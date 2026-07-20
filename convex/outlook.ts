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
import { ZONES, CONCEPTS, keepKnown } from "./lib/vocab";

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

    const coeffs: CoefficientBundle = await ctx.runQuery(internal.coefficients.getAll, {});

    switch (args.type) {
      case "weekly":
        return await computeWeeklyOutlook({ zone, concept, coeffs });
      case "events":
        return await computeEventOutlook({ zone, concept, coeffs });
      case "weather":
        return await computeWeatherOutlook({ zone, concept, coeffs });
      default:
        return await computeTodayOutlook({ zone, concept, coeffs });
    }
  },
});
