import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { type Doc } from "./_generated/dataModel";
import {
  fetchTicketmasterEvents,
  type NormalizedEvent,
} from "./lib/ticketmaster";
import { computeSearchArea, haversineMiles, proximityTier, PROXIMITY_FAR_MILES } from "./lib/geo";
import { classifyEvent } from "./lib/classify";
import {
  dayFromLocalDate,
  daypartFromLocalTime,
  daysUntilNextMonday,
  mondayOfWeek,
  nextMondayDate,
} from "./lib/vocab";
import {
  listEventSignalIds,
  createEventSignal,
  updateEventSignal,
  deleteEventSignal,
  type BubbleEventSignal,
} from "./lib/bubble";
import {
  HUNTINGTON_CRAWL_DELAY_MS,
  HUNTINGTON_PLACE_VENUE,
  listHuntingtonEventUrls,
  fetchHuntingtonEvent,
  type HuntingtonEvent,
} from "./lib/huntingtonPlace";

// Format a Date as ISO8601 UTC without milliseconds (Ticketmaster wants
// "YYYY-MM-DDTHH:MM:SSZ").
function toTmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// A classified event = normalized event + its class and (Convex-sourced) magnitude.
type ClassifiedEvent = NormalizedEvent & {
  event_class: string;
  magnitude: number;
};

// Zone centroid, as returned by zones.list (derived from the real
// foreshift_13_zones.geojson boundary, not the old approximate guesses).
type ZoneCentroid = {
  name: string;
  marketIndex: number;
  source: string;
  centroidLat: number;
  centroidLng: number;
};

// Shared core: derive the Detroit search area from the zone centroids,
// build the next-`days` date window, and fetch normalized events in one call.
async function gatherDetroitEvents(
  ctx: ActionCtx,
  days: number,
): Promise<{
  zones: ZoneCentroid[];
  searchArea: { latlong: string; radiusMiles: number };
  window: { start: string; end: string; days: number };
  events: NormalizedEvent[];
}> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TICKETMASTER_API_KEY is not set. Run: npx convex env set TICKETMASTER_API_KEY <key>",
    );
  }

  const zones: ZoneCentroid[] = await ctx.runQuery(api.zones.list, {});
  const { latlong, radiusMiles } = computeSearchArea(
    zones.map((z) => ({ lat: z.centroidLat, lng: z.centroidLng })),
    PROXIMITY_FAR_MILES,
  );

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const startDateTime = toTmDateTime(now);
  const endDateTime = toTmDateTime(end);

  const events = await fetchTicketmasterEvents({
    apiKey,
    latlong,
    radiusMiles,
    startDateTime,
    endDateTime,
  });

  return {
    zones,
    searchArea: { latlong, radiusMiles },
    window: { start: startDateTime, end: endDateTime, days },
    events,
  };
}

// Classify each event (B1 rule) and attach the magnitude from the owner-editable
// Convex catalog. Throws if a rule output isn't in the catalog (code/data drift).
async function attachClassAndMagnitude(
  ctx: ActionCtx,
  events: NormalizedEvent[],
): Promise<ClassifiedEvent[]> {
  const catalog: Doc<"eventMagnitude">[] = await ctx.runQuery(
    internal.coefficients.listEventMagnitude,
    {},
  );
  if (catalog.length === 0) {
    throw new Error(
      "No eventMagnitude coefficients seeded. Run: npx convex run coefficients:seedDummyCoefficients",
    );
  }
  const magnitudeByClass = new Map(
    catalog.map((c) => [c.eventClass, c.magnitude]),
  );

  return events.map((ev) => {
    const event_class = classifyEvent(ev);
    const magnitude = magnitudeByClass.get(event_class);
    if (magnitude === undefined) {
      throw new Error(
        `Class "${event_class}" from the rule is not in the eventMagnitude catalog.`,
      );
    }
    return { ...ev, event_class, magnitude };
  });
}

// Step 2a/2b (debug): fetch raw Detroit events over the whole zone footprint.
export const fetchDetroitEvents = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { searchArea, window, events } = await gatherDetroitEvents(
      ctx,
      args.days ?? 7,
    );
    return { searchArea, window, count: events.length, events };
  },
});

// Step 2c (debug): fetch + classify + attach magnitude, with a per-class breakdown.
export const fetchClassifiedEvents = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { searchArea, window, events } = await gatherDetroitEvents(
      ctx,
      args.days ?? 7,
    );
    const classified = await attachClassAndMagnitude(ctx, events);

    const breakdown: Record<string, number> = {};
    for (const ev of classified) {
      breakdown[ev.event_class] = (breakdown[ev.event_class] ?? 0) + 1;
    }
    return {
      searchArea,
      window,
      count: classified.length,
      breakdown,
      events: classified,
    };
  },
});

// One event×zone signal row (the unit we upsert into the event store).
export interface EventSignalRow {
  signal_key: string; // `${eventId}__${zone}` — unique upsert key
  eventId: string;
  name: string;
  venueName: string | null;
  eventClass: string;
  magnitude: number; // for inspection only; NOT stored (resolved at compute time)
  zone: string;
  proximity: number; // 1.0 or 0.5 (0 rows are dropped)
  distanceMiles: number; // raw venue -> zone-centroid distance (event narration)
  time: string | null; // localTime "HH:MM:SS", if Ticketmaster provided one
  date: string; // localDate "YYYY-MM-DD"
  day: string | null; // Mon..Sun
  daypart: string | null; // morning|midday|dinner|late (null when all_dayparts)
  // true -> timeless event, lift applies to all 4 dayparts (see resolve.ts).
  // Only the Huntington Place scrape sets this; Ticketmaster rows are always false.
  allDayparts: boolean;
}

// Core of step 2d: fetch Detroit events, classify + attach magnitude, then assign
// each to zones by the locked 1.0/0.5/0 proximity rule. One row per (event × zone)
// with nonzero proximity; events with no venue coords or beyond 1.5 mi of every zone
// are dropped.
async function computeEventSignalRows(
  ctx: ActionCtx,
  days: number,
): Promise<{
  searchArea: { latlong: string; radiusMiles: number };
  window: { start: string; end: string; days: number };
  summary: {
    fetchedEvents: number;
    droppedNoCoords: number;
    droppedOutOfRange: number;
    signalRows: number;
  };
  rows: EventSignalRow[];
}> {
  const { zones, searchArea, window, events } = await gatherDetroitEvents(ctx, days);
  const classified = await attachClassAndMagnitude(ctx, events);

  const rows: EventSignalRow[] = [];
  let droppedNoCoords = 0;
  let droppedOutOfRange = 0;

  for (const ev of classified) {
    if (ev.venueLat === null || ev.venueLng === null) {
      droppedNoCoords += 1;
      continue;
    }
    const venue = { lat: ev.venueLat, lng: ev.venueLng };

    let matched = 0;
    for (const zone of zones) {
      const dist = haversineMiles(venue, { lat: zone.centroidLat, lng: zone.centroidLng });
      const proximity = proximityTier(dist);
      if (proximity === 0) continue;
      matched += 1;
      rows.push({
        signal_key: `${ev.id}__${zone.name}`,
        eventId: ev.id,
        name: ev.name,
        venueName: ev.venueName,
        eventClass: ev.event_class,
        magnitude: ev.magnitude,
        zone: zone.name,
        proximity,
        distanceMiles: Math.round(dist * 10) / 10,
        time: ev.localTime,
        date: ev.localDate,
        day: dayFromLocalDate(ev.localDate),
        daypart: daypartFromLocalTime(ev.localTime),
        allDayparts: false,
      });
    }
    if (matched === 0) droppedOutOfRange += 1;
  }

  return {
    searchArea,
    window,
    summary: {
      fetchedEvents: classified.length,
      droppedNoCoords,
      droppedOutOfRange,
      signalRows: rows.length,
    },
    rows,
  };
}

// Step 2d (debug): compute + return the event×zone rows (no storage).
export const assignEventsToZones = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await computeEventSignalRows(ctx, args.days ?? 7);
  },
});

// ---------------------------------------------------------------------------
// Second event source: Huntington Place Detroit (web scrape). See
// lib/huntingtonPlace.ts for why it's a scrape and not an API call.
// ---------------------------------------------------------------------------

// Every Huntington Place booking is a multi-day, 3k+ convention-centre event —
// the "Festival day" tier (see the CLAUDE.md event-magnitude discussion). We do
// NOT classify per event: the scrape exposes no capacity / attendance / segment,
// and the category tag doesn't track crowd size (the Detroit Auto Show is tagged
// "Family Friendly"). The owner retunes the "Festival day" magnitude itself from
// the admin screen; to promote a specific event later, add a `recid -> class`
// lookup right here.
const HUNTINGTON_EVENT_CLASS = "Festival day";

// Calendar dates (YYYY-MM-DD) spanned by [startDate, endDate] that also fall in
// the half-open sync window [windowStart, windowEnd). Keeps a multi-day event
// inside today..next-Monday — never an already-elapsed day, never next week —
// exactly like the Ticketmaster fetch window.
function daysInWindow(
  startDate: string,
  endDate: string,
  windowStart: string,
  windowEnd: string,
): string[] {
  const out: string[] = [];
  let cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return out;
  for (let guard = 0; guard < 90 && cur <= end; guard++) {
    const iso = cur.toISOString().slice(0, 10);
    if (iso >= windowStart && iso < windowEnd) out.push(iso);
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return out;
}

interface HuntingtonGatherResult {
  events: HuntingtonEvent[]; // fetched + normalized OK (all, before window filter)
  rows: EventSignalRow[]; // one per event × in-window day × nearby zone (allDayparts)
  summary: {
    discovered: number; // event URLs found in the sitemap
    fetched: number; // detail pages parsed OK
    failed: number; // detail pages that errored (transport / HTTP)
    inWindow: number; // events with ≥1 day inside the sync window
    signalRows: number;
    zonesInRange: number;
  };
}

// Fetch + normalize the Huntington Place calendar and turn each in-window event
// into one EventSignal row per nearby zone per day. Mirrors computeEventSignalRows
// for the Ticketmaster path, with three source-specific differences:
//   - one FIXED venue point (every event is at Huntington Place), so proximity
//     per zone is computed once, not per event;
//   - no start time -> the row carries daypart=null and allDayparts=true, so
//     resolveCell applies its lift to all 4 dayparts (a plain null-daypart row
//     never matches resolve.ts's `zone|day|daypart` join and would do nothing);
//   - multi-day spans -> one row per in-window calendar day.
async function gatherHuntingtonSignalRows(
  ctx: ActionCtx,
  now: Date,
  days: number,
): Promise<HuntingtonGatherResult> {
  const windowStart = now.toISOString().slice(0, 10);
  const windowEnd = new Date(now.getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Drift guard, same as attachClassAndMagnitude: the class we emit must exist
  // in the owner-editable catalog or its lift silently resolves to 0.
  const catalog: Doc<"eventMagnitude">[] = await ctx.runQuery(
    internal.coefficients.listEventMagnitude,
    {},
  );
  const magnitude = catalog.find(
    (c) => c.eventClass === HUNTINGTON_EVENT_CLASS,
  )?.magnitude;
  if (magnitude === undefined) {
    throw new Error(
      `Huntington Place class "${HUNTINGTON_EVENT_CLASS}" is not in the eventMagnitude catalog.`,
    );
  }

  // Fixed venue -> proximity per zone, computed once (not per event).
  const zones: ZoneCentroid[] = await ctx.runQuery(api.zones.list, {});
  const venue = {
    lat: HUNTINGTON_PLACE_VENUE.lat,
    lng: HUNTINGTON_PLACE_VENUE.lng,
  };
  const zonesInRange = zones
    .map((z) => {
      const dist = haversineMiles(venue, {
        lat: z.centroidLat,
        lng: z.centroidLng,
      });
      return {
        zone: z.name,
        proximity: proximityTier(dist),
        distanceMiles: Math.round(dist * 10) / 10,
      };
    })
    .filter((z) => z.proximity > 0);

  const discovered = await listHuntingtonEventUrls();

  const events: HuntingtonEvent[] = [];
  const rows: EventSignalRow[] = [];
  let failed = 0;
  let inWindow = 0;

  for (const { url, recid } of discovered) {
    let ev: HuntingtonEvent | null = null;
    try {
      ev = await fetchHuntingtonEvent(url, recid);
    } catch (e) {
      failed += 1;
      console.warn(`Huntington event ${recid} fetch failed: ${String(e)}`);
    }
    // Polite crawl pace regardless of outcome (robots.txt Crawl-delay: 2).
    await new Promise((resolve) =>
      setTimeout(resolve, HUNTINGTON_CRAWL_DELAY_MS),
    );
    if (!ev) continue;
    events.push(ev);

    const dayList = daysInWindow(
      ev.startDate,
      ev.endDate,
      windowStart,
      windowEnd,
    );
    if (dayList.length === 0) continue;
    inWindow += 1;

    for (const date of dayList) {
      const day = dayFromLocalDate(date);
      for (const z of zonesInRange) {
        // ONE row per event × zone × day. No start time -> allDayparts=true,
        // and resolveCell/indexEventsByCell applies the lift to all 4 dayparts.
        rows.push({
          signal_key: `hp_${recid}__${z.zone}__${date}`,
          eventId: `hp_${recid}`,
          name: ev.name,
          venueName: HUNTINGTON_PLACE_VENUE.name,
          eventClass: HUNTINGTON_EVENT_CLASS,
          magnitude,
          zone: z.zone,
          proximity: z.proximity,
          distanceMiles: z.distanceMiles,
          time: null,
          date,
          day,
          daypart: null,
          allDayparts: true,
        });
      }
    }
  }

  return {
    events,
    rows,
    summary: {
      discovered: discovered.length,
      fetched: events.length,
      failed,
      inWindow,
      signalRows: rows.length,
      zonesInRange: zonesInRange.length,
    },
  };
}

// Debug: run the Huntington Place scrape for the current sync window and return
// what it WOULD upsert — no writes. Mirrors fetchDetroitEvents / assignEventsToZones.
export const fetchHuntingtonEventsRaw = internalAction({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = new Date();
    const days = args.days ?? daysUntilNextMonday(now);
    const res = await gatherHuntingtonSignalRows(ctx, now, days);
    return {
      window: { start: now.toISOString().slice(0, 10), days },
      summary: res.summary,
      events: res.events,
      sampleRows: res.rows.slice(0, 24),
    };
  },
});

// Step 2e: sync the computed rows into Bubble EventSignal. Pulls from TWO
// sources in one pass — Ticketmaster (computeEventSignalRows) and a Huntington
// Place Detroit web scrape (gatherHuntingtonSignalRows) — and upserts the merged
// set by signal_key (update if the key exists, else create). Huntington keys are
// `hp_<recid>__<zone>__<date>` (one row per event/zone/day, allDayparts=true);
// Ticketmaster keys are `<eventId>__<zone>`, so the two never collide. With
// deleteStale=true, also
// prunes Bubble rows — but only within a bounded window (see below), so the
// daily cron can refresh today..next-Monday without wiping days of the current
// week that have already elapsed. A Huntington scrape failure is non-fatal:
// the run proceeds Ticketmaster-only and skips Huntington pruning.
//
// Chains into the weather sync on completion (see `finally` below) instead of
// waiting on a separately-scheduled cron — the `finally` runs whether this sync
// succeeded or threw, so a failure here still lets the weather sync attempt its
// run rather than blocking the rest of the daily chain. See crons.ts.
export const syncEventSignalsToBubble = internalAction({
  args: { days: v.optional(v.number()), deleteStale: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    try {
      const now = new Date();
      // Fetch window: today through the upcoming Monday (exclusive) — never
      // reaches into next week, and shrinks through the week as days elapse.
      const days = args.days ?? daysUntilNextMonday(now);
      const { summary, rows: tmRows } = await computeEventSignalRows(ctx, days);

      // Second source: scrape Huntington Place Detroit's calendar and merge its
      // rows into the SAME pass, so one `seen` set drives the windowed
      // stale-delete below (a separate sync couldn't tell a live Huntington row
      // from a Ticketmaster orphan). A scrape failure is non-fatal — fall back
      // to Ticketmaster-only and skip Huntington pruning for this run.
      let huntington: HuntingtonGatherResult | null = null;
      try {
        huntington = await gatherHuntingtonSignalRows(ctx, now, days);
      } catch (e) {
        console.error(
          `Huntington Place scrape failed — continuing Ticketmaster-only: ${String(e)}`,
        );
      }
      // "Clean" = this run has a COMPLETE fresh Huntington picture (sitemap
      // returned events and every detail page parsed). Only then is it safe to
      // treat a missing `hp_` key as a genuinely-vanished event.
      const huntingtonClean =
        huntington !== null &&
        huntington.summary.failed === 0 &&
        huntington.summary.discovered > 0;
      const rows = huntington ? [...tmRows, ...huntington.rows] : tmRows;

      const existing = await listEventSignalIds();

      let created = 0;
      let updated = 0;
      let deleted = 0;
      const seen = new Set<string>();

      for (const row of rows) {
        const body: BubbleEventSignal = {
          signal_key: row.signal_key,
          event_id: row.eventId,
          name: row.name,
          venue_name: row.venueName,
          event_class: row.eventClass,
          zone: row.zone,
          proximity: row.proximity,
          distance_miles: row.distanceMiles,
          event_time: row.time,
          date: row.date,
          day: row.day,
          daypart: row.daypart,
          all_dayparts: row.allDayparts,
        };
        seen.add(row.signal_key);
        const found = existing.get(row.signal_key);
        if (found) {
          await updateEventSignal(found.id, body);
          updated += 1;
        } else {
          await createEventSignal(body);
          created += 1;
        }
      }

      if (args.deleteStale) {
        // Retained window is [mondayOfThisWeek, nextMonday). A stored row is
        // deleted only when it is either:
        //   (a) OUTSIDE that window — a previous week's leftover (or an
        //       undated/junk row). This is the cleanup the old weekly full
        //       wipe used to do; without it EventSignal would grow forever and
        //       last week's "Mon" would collide with this week's "Mon" on the
        //       day-of-week join in resolve.ts.
        //   (b) today-or-later AND not produced by this run — a future event
        //       that has since been cancelled or rescheduled away.
        // Rows in [mondayOfThisWeek, today) are this week's already-elapsed
        // days: left untouched so a mid-week (i.e. every daily) run can't wipe
        // Monday's signal on Tuesday.
        const weekStart = mondayOfWeek(now);
        const weekEnd = nextMondayDate(now); // exclusive
        const today = now.toISOString().slice(0, 10);
        for (const [key, { id, date }] of existing) {
          const isHuntington = key.startsWith("hp_");
          const outOfWindow = date === "" || date < weekStart || date >= weekEnd;
          // Only prune a "vanished future" row when this run has a complete
          // fresh picture from that row's source. If the Huntington scrape
          // failed / returned nothing, its keys are legitimately missing from
          // `seen` and must NOT be deleted. Out-of-window pruning (previous
          // weeks) still runs for both sources.
          const sourceRefreshed = isHuntington ? huntingtonClean : true;
          const vanishedFuture =
            sourceRefreshed && date >= today && !seen.has(key);
          if (outOfWindow || vanishedFuture) {
            await deleteEventSignal(id);
            deleted += 1;
          }
        }
      }

      return {
        computed: summary,
        huntington: huntington?.summary ?? { skipped: true },
        bubble: { created, updated, deleted, existingBefore: existing.size },
      };
    } finally {
      await ctx.scheduler.runAfter(0, internal.weather.syncWeatherSignalsToBubble, {
        deleteStale: true,
      });
    }
  },
});
