// Public action wrapper around the AI pipeline.
//
// Handy for testing from the Convex dashboard / CLI without going through HTTP:
//   npx convex run ai:ask '{"question": "How busy is Fine Dining in Greektown on Saturday?"}'
//
// Bubble should normally call the HTTP endpoint in http.ts instead.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { answerQuestion, type CoefficientBundle } from "./lib/orchestrator";

export const ask = action({
  args: {
    question: v.string(),
    // Operator's own defaults (fallback when the question omits zone/concept).
    operatorZone: v.optional(v.string()),
    operatorConcept: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const coeffs: CoefficientBundle = await ctx.runQuery(
      internal.coefficients.getAll,
      {},
    );
    return await answerQuestion(
      args.question,
      { zone: args.operatorZone ?? null, concept: args.operatorConcept ?? null },
      coeffs,
    );
  },
});
