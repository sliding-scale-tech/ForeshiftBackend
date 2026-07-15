import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { ZONES } from "./lib/vocab";

// Approximate zone centroids (lat/lng) for the 13 Detroit zones.
//
// PROVISIONAL — these are best-estimate placeholders, NOT authoritative geodata.
// ForeShift is expected to provide official ZoneGeo / GeoJSON; when it does, re-run
// the seed with source "official" (or upsert) to overwrite these in place.
//
// Names MUST match convex/lib/vocab.ts ZONES exactly (joins break on mismatch).
const APPROX_CENTROIDS: { name: string; lat: number; lng: number }[] = [
  { name: "Core City / Woodbridge", lat: 42.3565, lng: -83.084 },
  { name: "Corktown", lat: 42.332, lng: -83.067 },
  { name: "Downtown Detroit (Core)", lat: 42.3314, lng: -83.0458 },
  { name: "Eastern Market", lat: 42.3475, lng: -83.04 },
  { name: "Financial District", lat: 42.3295, lng: -83.0465 },
  { name: "Foxtown / Stadium District", lat: 42.34, lng: -83.05 },
  { name: "Greektown / Casino District", lat: 42.3355, lng: -83.0435 },
  { name: "Mexicantown", lat: 42.3235, lng: -83.0865 },
  { name: "Midtown", lat: 42.354, lng: -83.0665 },
  { name: "New Center / North End", lat: 42.369, lng: -83.074 },
  { name: "Riverfront / RiverWalk", lat: 42.329, lng: -83.035 },
  { name: "Southwest Detroit", lat: 42.305, lng: -83.115 },
  { name: "Woodward Core", lat: 42.345, lng: -83.057 },
];

/**
 * Seed / refresh the `zones` table with the 13 approximate centroids.
 * Idempotent: upserts by name (patch if the zone already exists, insert otherwise),
 * so re-running never creates duplicates. Returns a summary of what changed.
 */
export const seedApproximateCentroids = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Guard: our seed list must line up with the canonical vocabulary.
    const vocab = new Set<string>(ZONES);
    const missing = APPROX_CENTROIDS.filter((z) => !vocab.has(z.name)).map(
      (z) => z.name,
    );
    if (missing.length > 0) {
      throw new Error(`Seed zone names not in vocab: ${missing.join(", ")}`);
    }
    if (APPROX_CENTROIDS.length !== ZONES.length) {
      throw new Error(
        `Expected ${ZONES.length} zones, got ${APPROX_CENTROIDS.length}`,
      );
    }

    let inserted = 0;
    let updated = 0;
    for (const z of APPROX_CENTROIDS) {
      const existing = await ctx.db
        .query("zones")
        .withIndex("by_name", (q) => q.eq("name", z.name))
        .unique();
      const doc = { ...z, source: "approximate" as const };
      if (existing) {
        await ctx.db.patch("zones", existing._id, doc);
        updated += 1;
      } else {
        await ctx.db.insert("zones", doc);
        inserted += 1;
      }
    }
    return { total: APPROX_CENTROIDS.length, inserted, updated };
  },
});

/** List all zone centroids (for inspection / downstream proximity math). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("zones").withIndex("by_name").collect();
  },
});
