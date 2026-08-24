// POST /demand/outlook — the "Today's Demand Outlook" / "This Week's Demand
// Outlook" cards. Bubble sends a zone + concept (+ type), Convex resolves the
// real demand (same spec §2 math as /operator/week and the ResolvedDemand
// sync) and narrates it with Gemini. See lib/outlook.ts for the pipeline.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  computeTodayOutlook,
  computeWeeklyOutlook,
  computeEventOutlook,
  computeWeatherOutlook,
} from "./lib/outlook";
import { type CoefficientBundle } from "./lib/resolve";
import { ZONES, CONCEPTS, DAYS, currentWeekDates, keepKnown } from "./lib/vocab";

export const getOutlook = internalAction({
  args: {
    zone: v.string(),
    concept: v.string(),
    type: v.union(
      v.literal("today"),
      v.literal("weekly"),
      v.literal("events"),
      v.literal("weather"),
    ),
    // Which day the "today"-scoped cards describe, "YYYY-MM-DD". Defaults to
    // today. Restricted to the current Mon..Sun week — see resolveAsOf.
    date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const [zone] = keepKnown([args.zone], ZONES);
    const [concept] = keepKnown([args.concept], CONCEPTS);
    if (!zone) {
      throw new Error(`Unknown zone: "${args.zone}". Must be one of: ${ZONES.join(", ")}`);
    }
    if (!concept) {
      throw new Error(
        `Unknown concept: "${args.concept}". Must be one of: ${CONCEPTS.join(", ")}`,
      );
    }

    const now = resolveAsOf(args.date);
    const coeffs: CoefficientBundle = await ctx.runQuery(internal.coefficients.getAll, {});

    switch (args.type) {
      // Weekly always covers the whole current week, so `date` doesn't apply.
      case "weekly":
        return await computeWeeklyOutlook({ zone, concept, coeffs });
      case "events":
        return await computeEventOutlook({ zone, concept, coeffs, now });
      case "weather":
        return await computeWeatherOutlook({ zone, concept, coeffs, now });
      default:
        return await computeTodayOutlook({ zone, concept, coeffs, now });
    }
  },
});

/**
 * Turn the optional `date` argument into the Date the day-scoped cards resolve
 * against. Undefined = now.
 *
 * Only dates inside the CURRENT Mon..Sun week are accepted, and that is a hard
 * limit rather than a nicety: events and weather are looked up from Bubble by
 * day-of-week, not by calendar date, so asking for next Thursday would quietly
 * return THIS Thursday's signals against next week's label — wrong data with no
 * error. Rejecting it is the only honest option until the signal tables are
 * keyed by date.
 *
 * The chosen date is anchored at 12:00 UTC so that deriving "YYYY-MM-DD" from it
 * lands on the intended day in every timezone, instead of slipping a day at the
 * edges.
 */
function resolveAsOf(date: string | undefined): Date | undefined {
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: "${date}". Expected format YYYY-MM-DD.`);
  }
  const week = currentWeekDates(new Date());
  const allowed = DAYS.map((d) => week[d]);
  if (!allowed.includes(date)) {
    throw new Error(
      `Date "${date}" is outside the current week. Must be one of: ${allowed.join(", ")}.`,
    );
  }
  return new Date(`${date}T12:00:00Z`);
}
