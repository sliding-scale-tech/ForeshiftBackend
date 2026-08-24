// POST /event/impact — "what does THIS one event do to my demand?"
//
// The outlook endpoints answer "how busy am I", with events as one of several
// drivers folded into the total. This answers the inverse: isolate a single
// event and show its lift on its own, per daypart and for the day.
//
// Deliberately isolated: the numbers here are base_score + THAT event's lift,
// with no weather and no other event mixed in. Otherwise the figure would move
// when it rains, which is not what "this event's impact" means. That also makes
// it the only place where the returned band is an EVENT-ONLY band.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { fetchDemandRecords, fetchEventSignalById } from "./lib/bubble";
import { type CoefficientBundle } from "./lib/resolve";
import { SCORE_CAP } from "./lib/formula";
import {
  ZONES,
  CONCEPTS,
  DAYS,
  DAYPARTS,
  scoreToBand,
  keepKnown,
  type Band,
  type Daypart,
} from "./lib/vocab";

export interface EventImpactDaypart {
  daypart: Daypart;
  // How much this event raises that daypart against its own baseline, as
  // lift ÷ base_score × 100. A real number rounded to 1 decimal (48.5, not
  // "+48.5") so the client can compare, sort and format it. A JSON number
  // can't carry a leading "+", and it doesn't need one here: event lift is
  // magnitude × affinity × proximity, all of which are >= 0, so this value is
  // never negative — only weather can push demand down.
  //
  // NOTE this ratio is not defined in any ForeShift spec: the specs only give
  // the SCORE math (final = (base + event_lift) × weather_factor, capped at
  // 150). Expressing that lift as a percentage of base is this API's own
  // presentation choice — change it here if the owner defines it differently.
  //
  // 0 on the three dayparts the event doesn't fall in, and on a closed daypart
  // whose base_score is 0 (nothing to take a percentage of).
  percent: number;
}

export interface EventImpactResult {
  zone: string;
  concept: string;
  event: {
    event_id: string;
    name: string;
    venue: string;
    class: string;
    day: string;
    date: string;
    daypart: Daypart;
    time: string | null;
    proximity: number;
    distance_miles: number;
    magnitude: number;
    event_affinity: number;
  };
  dayparts: EventImpactDaypart[];
  // The one-word headline: the band this event's daypart lands in once its lift
  // is applied (base_score + lift, re-banded on the spec's §4.5 thresholds).
  // Weather and other events are excluded on purpose, so this describes THIS
  // event's contribution rather than the day as a whole.
  impact_band: Band;
}

/** 47.0537 -> 47.1 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export const getEventImpact = internalAction({
  args: {
    event_id: v.string(),
    zone: v.string(),
    concept: v.string(),
  },
  handler: async (ctx, args): Promise<EventImpactResult> => {
    const [zone] = keepKnown([args.zone], ZONES);
    const [concept] = keepKnown([args.concept], CONCEPTS);
    if (!zone) {
      throw new Error(
        `Unknown zone: "${args.zone}". Must be one of: ${ZONES.join(", ")}`,
      );
    }
    if (!concept) {
      throw new Error(
        `Unknown concept: "${args.concept}". Must be one of: ${CONCEPTS.join(", ")}`,
      );
    }

    const event = await fetchEventSignalById({ eventId: args.event_id, zone });
    if (!event) {
      throw new Error(
        `No event "${args.event_id}" near zone "${zone}". Either the id is wrong, ` +
          `the event is outside the current sync window, or it is more than 1.5 ` +
          `miles from that zone's centre (in which case it has no effect there).`,
      );
    }

    const coeffs: CoefficientBundle = await ctx.runQuery(
      internal.coefficients.getAll,
      {},
    );
    const magnitude = coeffs.eventMagnitude[event.event_class] ?? 0;
    const event_affinity = coeffs.eventAffinity[concept] ?? 0;
    // Spec §2, one term of event_lift's SUM.
    const lift = magnitude * event_affinity * event.proximity;

    // The stored day is free text as far as types go; clamp it to the vocabulary
    // before it reaches a lookup that only accepts the 7 known values.
    const [day] = keepKnown([event.day], DAYS);
    if (!day) {
      throw new Error(
        `EventSignal "${args.event_id}" has an unrecognised day: "${event.day}".`,
      );
    }

    const [record] = await fetchDemandRecords({
      zones: [zone],
      concepts: [concept],
      days: [day],
    });
    if (!record) {
      throw new Error(`No base demand data for ${zone} / ${concept} / ${day}.`);
    }

    const eventDaypart = event.daypart as Daypart;
    const baseScoreOf = (dp: Daypart) =>
      record.dayparts.find((d) => d.daypart === dp)?.base_score ?? 0;

    const dayparts: EventImpactDaypart[] = DAYPARTS.map((dp) => {
      const base_score = baseScoreOf(dp);
      const applies = dp === eventDaypart && base_score > 0;
      return {
        daypart: dp,
        percent: applies ? round1((lift / base_score) * 100) : 0,
      };
    });

    // Band of the event's own daypart once its lift lands — same 150 cap and
    // the same thresholds every other score in the system is banded on.
    const impact_band = scoreToBand(
      Math.min(baseScoreOf(eventDaypart) + lift, SCORE_CAP),
    );

    return {
      zone,
      concept,
      event: {
        event_id: event.event_id,
        name: event.name,
        venue: event.venue_name,
        class: event.event_class,
        day,
        date: event.date,
        daypart: eventDaypart,
        time: event.event_time,
        proximity: event.proximity,
        distance_miles: event.distance_miles,
        magnitude,
        event_affinity,
      },
      dayparts,
      impact_band,
    };
  },
});
