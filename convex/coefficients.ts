import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { CONCEPTS } from "./lib/vocab";
import { requireAdmin } from "./users";

// Owner-editable coefficient store — THREE separate tables (backend spec
// §4.2/§4.3/§4.4, §5.2). Functions are INTERNAL: coefficients are trade-secret
// ([TS], §8), read server-side by the formula and edited by the owner via an
// auth-gated admin surface (added later), never a public API.

// --- Dummy seed values ---
// §4.3 Event magnitude by class.
const EVENT_MAGNITUDE: Record<string, number> = {
  "Major stadium game": 50,
  "Concert / large show": 30,
  "Festival day": 20,
  "Minor event": 10,
};
// §4.2 Event affinity (all concepts) and §4.4 Weather affinity (all concepts).
const EVENT_AFFINITY_DUMMY = 0.5;
const WEATHER_AFFINITY_DUMMY = 0.35;

/**
 * Seed all three coefficient tables with dummy values. Run ONCE at setup.
 * Idempotent (upserts by natural key), but it RESETS values to dummy — do not
 * re-run after the owner has edited real values. Owner edits go through the
 * per-table `update*` mutations.
 */
export const seedDummyCoefficients = internalMutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    let updated = 0;

    // event magnitude
    for (const [eventClass, magnitude] of Object.entries(EVENT_MAGNITUDE)) {
      const existing = await ctx.db
        .query("eventMagnitude")
        .withIndex("by_eventClass", (q) => q.eq("eventClass", eventClass))
        .unique();
      if (existing) {
        await ctx.db.patch("eventMagnitude", existing._id, { magnitude });
        updated += 1;
      } else {
        await ctx.db.insert("eventMagnitude", { eventClass, magnitude });
        inserted += 1;
      }
    }

    // event + weather affinity (per concept)
    for (const concept of CONCEPTS) {
      const ea = await ctx.db
        .query("eventAffinity")
        .withIndex("by_concept", (q) => q.eq("concept", concept))
        .unique();
      if (ea) {
        await ctx.db.patch("eventAffinity", ea._id, { affinity: EVENT_AFFINITY_DUMMY });
        updated += 1;
      } else {
        await ctx.db.insert("eventAffinity", { concept, affinity: EVENT_AFFINITY_DUMMY });
        inserted += 1;
      }

      const wa = await ctx.db
        .query("weatherAffinity")
        .withIndex("by_concept", (q) => q.eq("concept", concept))
        .unique();
      if (wa) {
        await ctx.db.patch("weatherAffinity", wa._id, {
          affinity: WEATHER_AFFINITY_DUMMY,
        });
        updated += 1;
      } else {
        await ctx.db.insert("weatherAffinity", {
          concept,
          affinity: WEATHER_AFFINITY_DUMMY,
        });
        inserted += 1;
      }
    }

    return {
      inserted,
      updated,
      total:
        Object.keys(EVENT_MAGNITUDE).length + CONCEPTS.length * 2,
    };
  },
});

// All three coefficient sets as lookup maps, in one query — for the demand calc /
// narration flow (resolve magnitude by class, affinities by concept).
export const getAll = internalQuery({
  args: {},
  handler: async (ctx) => {
    const em = await ctx.db.query("eventMagnitude").collect();
    const ea = await ctx.db.query("eventAffinity").collect();
    const wa = await ctx.db.query("weatherAffinity").collect();

    const eventMagnitude: Record<string, number> = {};
    for (const c of em) eventMagnitude[c.eventClass] = c.magnitude;
    const eventAffinity: Record<string, number> = {};
    for (const c of ea) eventAffinity[c.concept] = c.affinity;
    const weatherAffinity: Record<string, number> = {};
    for (const c of wa) weatherAffinity[c.concept] = c.affinity;

    return { eventMagnitude, eventAffinity, weatherAffinity };
  },
});

// --- §4.3 Event magnitude ---
export const listEventMagnitude = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("eventMagnitude").collect(),
});

export const updateEventMagnitude = internalMutation({
  args: { eventClass: v.string(), magnitude: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("eventMagnitude")
      .withIndex("by_eventClass", (q) => q.eq("eventClass", args.eventClass))
      .unique();
    if (!row) throw new Error(`No eventMagnitude for "${args.eventClass}"`);
    await ctx.db.patch("eventMagnitude", row._id, { magnitude: args.magnitude });
    return { eventClass: args.eventClass, magnitude: args.magnitude };
  },
});

// --- §4.2 Event affinity ---
export const listEventAffinity = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("eventAffinity").collect(),
});

export const updateEventAffinity = internalMutation({
  args: { concept: v.string(), affinity: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("eventAffinity")
      .withIndex("by_concept", (q) => q.eq("concept", args.concept))
      .unique();
    if (!row) throw new Error(`No eventAffinity for "${args.concept}"`);
    await ctx.db.patch("eventAffinity", row._id, { affinity: args.affinity });
    return { concept: args.concept, affinity: args.affinity };
  },
});

// --- §4.4 Weather affinity ---
export const listWeatherAffinity = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("weatherAffinity").collect(),
});

export const updateWeatherAffinity = internalMutation({
  args: { concept: v.string(), affinity: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("weatherAffinity")
      .withIndex("by_concept", (q) => q.eq("concept", args.concept))
      .unique();
    if (!row) throw new Error(`No weatherAffinity for "${args.concept}"`);
    await ctx.db.patch("weatherAffinity", row._id, { affinity: args.affinity });
    return { concept: args.concept, affinity: args.affinity };
  },
});

// ---------------------------------------------------------------------------
// Admin console (§5.2) — PUBLIC but admin-gated. The owner edits coefficients
// here through the panel; changes take effect on the next demand request with no
// code change or redeploy. Every function calls requireAdmin first, so a
// non-admin (or signed-out) caller can neither read nor write these values.
// ---------------------------------------------------------------------------

const conceptOrder = (concept: string): number => {
  const i = CONCEPTS.indexOf(concept as (typeof CONCEPTS)[number]);
  return i === -1 ? CONCEPTS.length : i;
};

/** All three coefficient sets for the admin panel (admin only). */
export const adminGetAll = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const em = await ctx.db.query("eventMagnitude").collect();
    const ea = await ctx.db.query("eventAffinity").collect();
    const wa = await ctx.db.query("weatherAffinity").collect();
    return {
      eventMagnitude: em
        .map((r) => ({ eventClass: r.eventClass, magnitude: r.magnitude }))
        .sort((a, b) => b.magnitude - a.magnitude),
      eventAffinity: ea
        .map((r) => ({ concept: r.concept, affinity: r.affinity }))
        .sort((a, b) => conceptOrder(a.concept) - conceptOrder(b.concept)),
      weatherAffinity: wa
        .map((r) => ({ concept: r.concept, affinity: r.affinity }))
        .sort((a, b) => conceptOrder(a.concept) - conceptOrder(b.concept)),
    };
  },
});

/** Edit one event magnitude (admin only). Magnitude must be a finite >= 0 number. */
export const adminUpdateEventMagnitude = mutation({
  args: { eventClass: v.string(), magnitude: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(args.magnitude) || args.magnitude < 0) {
      throw new Error("Magnitude must be a number >= 0.");
    }
    const row = await ctx.db
      .query("eventMagnitude")
      .withIndex("by_eventClass", (q) => q.eq("eventClass", args.eventClass))
      .unique();
    if (!row) throw new Error(`No eventMagnitude for "${args.eventClass}".`);
    await ctx.db.patch("eventMagnitude", row._id, { magnitude: args.magnitude });
    return { eventClass: args.eventClass, magnitude: args.magnitude };
  },
});

/** Edit one event affinity (admin only). Affinity must be within 0..1. */
export const adminUpdateEventAffinity = mutation({
  args: { concept: v.string(), affinity: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(args.affinity) || args.affinity < 0 || args.affinity > 1) {
      throw new Error("Affinity must be a number between 0 and 1.");
    }
    const row = await ctx.db
      .query("eventAffinity")
      .withIndex("by_concept", (q) => q.eq("concept", args.concept))
      .unique();
    if (!row) throw new Error(`No eventAffinity for "${args.concept}".`);
    await ctx.db.patch("eventAffinity", row._id, { affinity: args.affinity });
    return { concept: args.concept, affinity: args.affinity };
  },
});

/** Edit one weather affinity (admin only). Affinity must be within 0..1. */
export const adminUpdateWeatherAffinity = mutation({
  args: { concept: v.string(), affinity: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (!Number.isFinite(args.affinity) || args.affinity < 0 || args.affinity > 1) {
      throw new Error("Affinity must be a number between 0 and 1.");
    }
    const row = await ctx.db
      .query("weatherAffinity")
      .withIndex("by_concept", (q) => q.eq("concept", args.concept))
      .unique();
    if (!row) throw new Error(`No weatherAffinity for "${args.concept}".`);
    await ctx.db.patch("weatherAffinity", row._id, { affinity: args.affinity });
    return { concept: args.concept, affinity: args.affinity };
  },
});
