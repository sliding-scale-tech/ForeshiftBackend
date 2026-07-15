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
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
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

// --- 2. Weekly cron: resolve EVERY zone×concept×day, upsert to Bubble ------
export const syncResolvedDemandToBubble = internalAction({
  args: { deleteStale: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
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
      const w = weatherByZoneDay.get(`${r.zone}|${r.day}`);

      return {
        signal_key: `${r.zone}__${r.concept}__${r.day}`,
        zone: r.zone,
        concept: r.concept,
        day: r.day,
        date: w?.date ?? "",
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
    const seenKeys = new Set<string>();

    for (const row of rows) {
      seenKeys.add(row.signal_key);
      const id = existing.get(row.signal_key);
      if (id) {
        await updateResolvedDemand(id, row);
        updated += 1;
      } else {
        await createResolvedDemand(row);
        created += 1;
      }
    }

    if (args.deleteStale) {
      for (const [key, id] of existing) {
        if (!seenKeys.has(key)) {
          await deleteResolvedDemand(id);
          deleted += 1;
        }
      }
    }

    return { total: rows.length, created, updated, deleted, existingBefore: existing.size };
  },
});
