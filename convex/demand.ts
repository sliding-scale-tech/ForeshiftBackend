import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { type Doc } from "./_generated/dataModel";
import { fetchDemandRecords } from "./lib/bubble";
import {
  ZONES,
  CONCEPTS,
  DAYS,
  DAYPARTS,
  keepKnown,
  type Daypart,
} from "./lib/vocab";
import { computeDemand, type ResolvedEvent } from "./lib/formula";

// Debug: pull the base-score row for one zone × concept × day from Bubble's
// DemandScore (wide) table, to confirm the reader + field names line up.
export const debugBaseScore = internalAction({
  args: { zone: v.string(), concept: v.string(), day: v.string() },
  handler: async (_ctx, args) => {
    const zones = keepKnown([args.zone], ZONES);
    const concepts = keepKnown([args.concept], CONCEPTS);
    const days = keepKnown([args.day], DAYS);
    const records = await fetchDemandRecords({ zones, concepts, days });
    return { count: records.length, records };
  },
});

// Spec §2 build test: run the worked example through the pure formula.
// Expect final_score 45.38, band "Moderate".
export const debugWorkedExample = internalAction({
  args: {},
  handler: async () => {
    return computeDemand({
      base_score: 30.0,
      events: [{ magnitude: 50, affinity: 0.5, proximity: 1.0 }],
      weather_severity: 0.5,
      weather_affinity: 0.35,
    });
  },
});

// Phase 1 core: compute /zone-demand for one zone × concept × day × daypart.
// Reads base_score from Bubble (DemandScore) and the owner-editable coefficients
// from Convex, then applies the spec §2 formula. This is Option A — the caller
// supplies events[] ({class, proximity}) and weather_severity.
export const computeZoneDemand = internalAction({
  args: {
    zone: v.string(),
    concept: v.string(),
    day: v.string(),
    daypart: v.string(),
    events: v.array(v.object({ class: v.string(), proximity: v.number() })),
    weather_severity: v.number(),
  },
  handler: async (ctx, args) => {
    // Validate dimensions against the canonical vocab (mismatch = silent join break).
    const [zone] = keepKnown([args.zone], ZONES);
    const [concept] = keepKnown([args.concept], CONCEPTS);
    const [day] = keepKnown([args.day], DAYS);
    if (!zone) throw new Error(`Unknown zone: ${args.zone}`);
    if (!concept) throw new Error(`Unknown concept: ${args.concept}`);
    if (!day) throw new Error(`Unknown day: ${args.day}`);
    if (!DAYPARTS.includes(args.daypart as Daypart)) {
      throw new Error(`Unknown daypart: ${args.daypart}`);
    }
    const daypart = args.daypart as Daypart;

    // 1. base_score — from Bubble DemandScore (wide), pick this daypart's cell.
    const records = await fetchDemandRecords({
      zones: [zone],
      concepts: [concept],
      days: [day],
    });
    const record = records[0];
    if (!record) {
      throw new Error(`No base_score row for ${zone} / ${concept} / ${day}`);
    }
    const cell = record.dayparts.find((d) => d.daypart === daypart);
    if (!cell) throw new Error(`No ${daypart} base_score in row`);
    const base_score = cell.base_score;

    // 2. Owner-editable coefficients — from Convex (trade-secret, server-side).
    const eventMag: Doc<"eventMagnitude">[] = await ctx.runQuery(
      internal.coefficients.listEventMagnitude,
      {},
    );
    const eventAff: Doc<"eventAffinity">[] = await ctx.runQuery(
      internal.coefficients.listEventAffinity,
      {},
    );
    const weatherAff: Doc<"weatherAffinity">[] = await ctx.runQuery(
      internal.coefficients.listWeatherAffinity,
      {},
    );

    const magByClass = new Map(eventMag.map((c) => [c.eventClass, c.magnitude]));
    const event_affinity = new Map(
      eventAff.map((c) => [c.concept, c.affinity]),
    ).get(concept);
    const weather_affinity = new Map(
      weatherAff.map((c) => [c.concept, c.affinity]),
    ).get(concept);
    if (event_affinity === undefined) {
      throw new Error(`No event_affinity for concept ${concept}`);
    }
    if (weather_affinity === undefined) {
      throw new Error(`No weather_affinity for concept ${concept}`);
    }

    // Resolve each incoming event's coefficients (affinity is the concept's).
    const events: ResolvedEvent[] = args.events.map((e) => {
      const magnitude = magByClass.get(e.class);
      if (magnitude === undefined) {
        throw new Error(`Unknown event class: ${e.class}`);
      }
      return { magnitude, affinity: event_affinity, proximity: e.proximity };
    });

    // 3. Apply the spec §2 formula.
    const result = computeDemand({
      base_score,
      events,
      weather_severity: args.weather_severity,
      weather_affinity,
    });

    return {
      zone,
      concept,
      base_score,
      final_score: result.final_score,
      band: result.band,
      event_applied: result.event_applied,
    };
  },
});
