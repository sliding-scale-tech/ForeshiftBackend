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
import { dayFromLocalDate, daypartFromLocalTime } from "./lib/vocab";
import {
  listEventSignalIds,
  createEventSignal,
  updateEventSignal,
  deleteEventSignal,
  type BubbleEventSignal,
} from "./lib/bubble";

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

// Shared core: derive the Detroit search area from the seeded zone centroids,
// build the next-`days` date window, and fetch normalized events in one call.
async function gatherDetroitEvents(
  ctx: ActionCtx,
  days: number,
): Promise<{
  zones: Doc<"zones">[];
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

  const zones: Doc<"zones">[] = await ctx.runQuery(api.zones.list, {});
  const { latlong, radiusMiles } = computeSearchArea(
    zones.map((z) => ({ lat: z.lat, lng: z.lng })),
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
  date: string; // localDate "YYYY-MM-DD"
  day: string | null; // Mon..Sun
  daypart: string | null; // morning|midday|dinner|late
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
      const dist = haversineMiles(venue, { lat: zone.lat, lng: zone.lng });
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
        date: ev.localDate,
        day: dayFromLocalDate(ev.localDate),
        daypart: daypartFromLocalTime(ev.localTime),
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

// Step 2e: sync the computed rows into Bubble EventSignal. Upserts by signal_key
// (update if the key exists, else create). With deleteStale=true, also removes
// Bubble rows whose signal_key is no longer produced (last week's events).
export const syncEventSignalsToBubble = internalAction({
  args: { days: v.optional(v.number()), deleteStale: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { summary, rows } = await computeEventSignalRows(ctx, args.days ?? 7);
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
        date: row.date,
        day: row.day,
        daypart: row.daypart,
      };
      seen.add(row.signal_key);
      const id = existing.get(row.signal_key);
      if (id) {
        await updateEventSignal(id, body);
        updated += 1;
      } else {
        await createEventSignal(body);
        created += 1;
      }
    }

    if (args.deleteStale) {
      for (const [key, id] of existing) {
        if (!seen.has(key)) {
          await deleteEventSignal(id);
          deleted += 1;
        }
      }
    }

    return {
      computed: summary,
      bubble: { created, updated, deleted, existingBefore: existing.size },
    };
  },
});
