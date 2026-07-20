// The operator dashboard's demand data layer — powers the 7-day grid and the
// per-daypart day-detail view. Used two ways (per the operator UI build):
//   1. computeOperatorWeek — called live for a single zone+concept, e.g. once
//      when a restaurant signs up, so they see real numbers immediately.
//   2. syncResolvedDemandToBubble — a weekly cron that resolves EVERY
//      zone×concept×day at once and upserts into Bubble's ResolvedDemand table,
//      so ongoing dashboard loads just read Bubble (no live compute needed).
//
// Both paths share the exact same per-cell math (resolve.ts / computeDemand),
// so a live signup call and this week's cron-synced row always agree.
//
// Keyed by zone×concept×day, NOT per operator: the resolved demand only depends
// on zone/concept (base_score + live events + live weather + concept
// coefficients), never on which specific restaurant is asking. Two operators
// sharing a zone+concept get identical numbers.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin } from "./users";
import {
  fetchDemandRecords,
  fetchEventSignals,
  fetchWeatherSignals,
  listResolvedDemandIds,
  createResolvedDemand,
  updateResolvedDemand,
  deleteResolvedDemand,
  type BubbleResolvedDemand,
  type DemandRecord,
  type EventSignalRead,
  type WeatherSignalRead,
} from "./lib/bubble";
import {
  indexEventsByCell,
  indexWeatherByZoneDay,
  resolveCell,
  type CoefficientBundle,
} from "./lib/resolve";
import {
  ZONES,
  CONCEPTS,
  DAYS,
  DAYPARTS,
  DAYPART_WINDOWS,
  keepKnown,
  currentWeekDates,
  type Daypart,
  type Band,
} from "./lib/vocab";

interface DaypartScore {
  daypart: Daypart;
  window: string;
  score: number;
  band: Band;
}

// Resolve all 4 dayparts for one zone×concept×day row, plus that day's peak
// (busiest daypart) — the single number the 7-day grid card shows.
function resolveDay(args: {
  zone: string;
  concept: string;
  day: string;
  dayparts: { daypart: Daypart; base_score: number; base_band: string }[];
  eventsByCell: Map<string, EventSignalRead[]>;
  weatherByZoneDay: Map<string, WeatherSignalRead>;
  coeffs: CoefficientBundle;
}): { dayparts: DaypartScore[]; peak: DaypartScore } {
  const dayparts: DaypartScore[] = DAYPARTS.map((dp) => {
    const cell = args.dayparts.find((d) => d.daypart === dp);
    const resolved = resolveCell({
      zone: args.zone,
      concept: args.concept,
      day: args.day,
      daypart: dp,
      window: DAYPART_WINDOWS[dp],
      base_score: cell?.base_score ?? 0,
      base_band: cell?.base_band ?? "Minimal",
      eventsByCell: args.eventsByCell,
      weatherByZoneDay: args.weatherByZoneDay,
      coeffs: args.coeffs,
    });
    return {
      daypart: dp,
      window: DAYPART_WINDOWS[dp],
      score: resolved.final_score,
      band: resolved.final_band,
    };
  });

  const peak = dayparts.reduce((best, c) => (c.score > best.score ? c : best));
  return { dayparts, peak };
}

// --- 1. Live per-operator week (e.g. called once on signup) ----------------
export const computeOperatorWeek = internalAction({
  args: { zone: v.string(), concept: v.string() },
  handler: async (ctx, args) => {
    const [zone] = keepKnown([args.zone], ZONES);
    const [concept] = keepKnown([args.concept], CONCEPTS);
    if (!zone) throw new Error(`Unknown zone: ${args.zone}`);
    if (!concept) throw new Error(`Unknown concept: ${args.concept}`);

    const records: DemandRecord[] = await fetchDemandRecords({
      zones: [zone],
      concepts: [concept],
      days: [],
    });
    const events: EventSignalRead[] = await fetchEventSignals({
      zones: [zone],
      days: [],
    });
    const weather: WeatherSignalRead[] = await fetchWeatherSignals({
      zones: [zone],
      days: [],
    });
    const coeffs: CoefficientBundle = await ctx.runQuery(
      internal.coefficients.getAll,
      {},
    );

    const eventsByCell = indexEventsByCell(events);
    const weatherByZoneDay = indexWeatherByZoneDay(weather);

    const byDay = new Map(records.map((r) => [r.day, r]));
    const days = DAYS.filter((d) => byDay.has(d)).map((day) => {
      const record = byDay.get(day)!;
      const { dayparts, peak } = resolveDay({
        zone,
        concept,
        day,
        dayparts: record.dayparts,
        eventsByCell,
        weatherByZoneDay,
        coeffs,
      });
      const w = weatherByZoneDay.get(`${zone}|${day}`);
      return {
        day,
        date: w?.date ?? null,
        peak: { daypart: peak.daypart, score: peak.score, band: peak.band },
        dayparts: dayparts.map((d) => ({
          daypart: d.daypart,
          window: d.window,
          score: d.score,
          band: d.band,
        })),
      };
    });

    // Order chronologically by calendar date, NOT by Mon..Sun day-name — the
    // synced signals are a rolling 7-day forecast starting from whenever the
    // weekly sync last ran, not a fixed Monday-start week. Sorting by day-name
    // would show e.g. "Mon" a week ahead of "Tue" whenever the window straddles
    // two calendar weeks. Rows with no date (shouldn't happen) sort last.
    days.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    return { zone, concept, days };
  },
});

// Bubble's Data API has no bulk upsert/delete — every row is its own HTTP
// call. Running all ~819 sequentially (one row, wait, next row) makes this
// take minutes. Run a bounded number of them at once instead: each worker
// pulls the next item off the shared list until none are left, so at most
// `limit` requests are in flight at a time.
//
// Per-item failures are caught rather than left to reject the whole
// Promise.all — Bubble's own capacity limit (503 "app too busy") means some
// requests can fail even after fetchWithRetry's backoff, and one bad row
// shouldn't abandon the other ~800 in-flight writes or leave the sync in an
// unknown partial state. Callers get every error back and decide what to do.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<{ errors: unknown[] }> {
  let next = 0;
  const errors: unknown[] = [];
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]);
      } catch (e) {
        errors.push(e);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return { errors };
}

// 15 concurrent writes tripped Bubble's 503 "app too busy" on this app's
// plan; keep it modest. fetchWithRetry still backs off/retries on top of this.
const BUBBLE_WRITE_CONCURRENCY = 6;

// --- 2. Weekly cron: resolve EVERY zone×concept×day, upsert to Bubble ------
// Shared by the cron (internalAction below) and the admin "Save to Bubble"
// button (public action below) — same logic either way, only who's allowed to
// trigger it differs. Plain helper, not ctx.runAction, since both callers run
// in the same action already (no runtime to cross).
async function runSyncResolvedDemandToBubble(
  ctx: ActionCtx,
  args: {
    deleteStale?: boolean;
    trigger: "admin" | "cron";
    triggeredBy?: string;
  },
) {
  const startedAt = Date.now();
  try {
    const result = await doSync(ctx, args);
    // Explicit `null` annotation works around a TS circularity limitation:
    // `internal.operatorWeek.logSync` is a reference into this same file, so
    // TS can't infer this call's return type without first resolving this
    // function's own return type — annotating it breaks the cycle.
    const logged: null = await ctx.runMutation(internal.operatorWeek.logSync, {
      trigger: args.trigger,
      triggeredBy: args.triggeredBy,
      startedAt,
      finishedAt: Date.now(),
      status: "success",
      total: result.total,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
    });
    void logged;
    return result;
  } catch (e) {
    const logged: null = await ctx.runMutation(internal.operatorWeek.logSync, {
      trigger: args.trigger,
      triggeredBy: args.triggeredBy,
      startedAt,
      finishedAt: Date.now(),
      status: "error",
      total: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    void logged;
    throw e;
  }
}

async function doSync(
  ctx: ActionCtx,
  args: { deleteStale?: boolean },
) {
    const records: DemandRecord[] = await fetchDemandRecords({
      zones: [],
      concepts: [],
      days: [],
    });
    const events: EventSignalRead[] = await fetchEventSignals({
      zones: [],
      days: [],
    });
    const weather: WeatherSignalRead[] = await fetchWeatherSignals({
      zones: [],
      days: [],
    });
    const coeffs: CoefficientBundle = await ctx.runQuery(
      internal.coefficients.getAll,
      {},
    );

    const eventsByCell = indexEventsByCell(events);
    const weatherByZoneDay = indexWeatherByZoneDay(weather);
    // Derive each day-of-week's calendar date from THIS week's Monday directly,
    // rather than borrowing it from whatever WeatherSignal row happens to exist —
    // that lookup goes stale/wrong for a day with no live signal yet (e.g. an
    // already-elapsed day this week that a forward-looking forecast API can't
    // backfill), and previously showed next week's date instead of this week's.
    const weekDates = currentWeekDates(new Date());

    const rows: BubbleResolvedDemand[] = records.map((r) => {
      const { dayparts, peak } = resolveDay({
        zone: r.zone,
        concept: r.concept,
        day: r.day,
        dayparts: r.dayparts,
        eventsByCell,
        weatherByZoneDay,
        coeffs,
      });
      const byDp = new Map(dayparts.map((d) => [d.daypart, d]));

      return {
        signal_key: `${r.zone}__${r.concept}__${r.day}`,
        zone: r.zone,
        concept: r.concept,
        day: r.day,
        date: weekDates[r.day as (typeof DAYS)[number]] ?? "",
        peak_daypart: peak.daypart,
        peak_score: peak.score,
        peak_band: peak.band,
        morning_score: byDp.get("morning")!.score,
        morning_band: byDp.get("morning")!.band,
        midday_score: byDp.get("midday")!.score,
        midday_band: byDp.get("midday")!.band,
        dinner_score: byDp.get("dinner")!.score,
        dinner_band: byDp.get("dinner")!.band,
        late_score: byDp.get("late")!.score,
        late_band: byDp.get("late")!.band,
      };
    });

    const existing = await listResolvedDemandIds();
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const seenKeys = new Set<string>(rows.map((r) => r.signal_key));

    const writeResult = await runWithConcurrency(
      rows,
      BUBBLE_WRITE_CONCURRENCY,
      async (row) => {
        const id = existing.get(row.signal_key);
        if (id) {
          await updateResolvedDemand(id, row);
          updated += 1;
        } else {
          await createResolvedDemand(row);
          created += 1;
        }
      },
    );

    const errors = [...writeResult.errors];
    if (args.deleteStale) {
      const toDelete = [...existing].filter(([key]) => !seenKeys.has(key));
      const deleteResult = await runWithConcurrency(
        toDelete,
        BUBBLE_WRITE_CONCURRENCY,
        async ([, id]) => {
          await deleteResolvedDemand(id);
          deleted += 1;
        },
      );
      errors.push(...deleteResult.errors);
    }

    if (errors.length > 0) {
      const first = errors[0];
      const firstMessage = first instanceof Error ? first.message : String(first);
      throw new Error(
        `${errors.length} of ${rows.length + (args.deleteStale ? existing.size : 0)} Bubble ` +
          `write(s) failed after retries (${created} created, ${updated} updated, ${deleted} ` +
          `removed succeeded). First error: ${firstMessage}`,
      );
    }

    return { total: rows.length, created, updated, deleted, existingBefore: existing.size };
}

// Cron entry point — weekly, unauthenticated (Convex crons run server-side).
export const syncResolvedDemandToBubble = internalAction({
  args: { deleteStale: v.optional(v.boolean()) },
  handler: async (ctx, args) =>
    runSyncResolvedDemandToBubble(ctx, { ...args, trigger: "cron" }),
});

// --- 3. Admin "Save to Bubble" button ---------------------------------------
// Manual, on-demand version of the same weekly sync, gated to signed-in admins
// only. Always deletes stale rows (deleteStale: true) so a manual push fully
// replaces the current Mon..Sun week in Bubble's ResolvedDemand table, exactly
// like the cron does. Note: this is a normal Convex action invocation, not a
// streamed/held-open connection — once the request lands on the server it
// runs to completion independent of the client's browser tab, same as the
// cron. Closing the tab mid-sync does not interrupt it.
export const adminSyncResolvedDemandToBubble = action({
  args: {},
  handler: async (ctx) => {
    // Explicit annotation works around a TS circularity limitation: this
    // file also has same-file `internal.operatorWeek.*` references (see
    // logSync below), which means the generated `internal` type can't be
    // resolved without first resolving this handler's own return type.
    const admin: { email?: string; username?: string } = await ctx.runQuery(
      internal.users.requireAdminCheck,
      {},
    );
    return await runSyncResolvedDemandToBubble(ctx, {
      deleteStale: true,
      trigger: "admin",
      triggeredBy: admin.email ?? admin.username ?? "admin",
    });
  },
});

// --- 4. Sync log — powers "last updated" in the admin panel -----------------
export const logSync = internalMutation({
  args: {
    trigger: v.union(v.literal("admin"), v.literal("cron")),
    triggeredBy: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.number(),
    status: v.union(v.literal("success"), v.literal("error")),
    total: v.number(),
    created: v.number(),
    updated: v.number(),
    deleted: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("bubbleSyncLog", args);
  },
});

/** Most recent admin-triggered "Save to Bubble" run (success or failure), for
 * the "last updated" line in the admin panel. Reads from the log table, not
 * client state, so it's correct even after a reload or a closed-then-reopened
 * tab. Admin only. */
export const getLastAdminSync = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("bubbleSyncLog")
      .withIndex("by_trigger_and_finishedAt", (q) => q.eq("trigger", "admin"))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});
