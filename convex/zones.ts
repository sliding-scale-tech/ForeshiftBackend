import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { ZONES } from "./lib/vocab";
import {
  assignZone,
  geometryCentroid,
  type GeoGeometry,
  type ZoneFeature,
} from "./lib/pointInPolygon";
import zonesGeoJson from "./data/foreshiftZones.json";

// The client-delivered boundary package (foreshift_13_zones.geojson) bundled
// as a static import — see ZONE_ASSIGNMENT_BRIEF.md for provenance. Zone
// names were normalized to match convex/lib/vocab.ts ZONES exactly (the
// original file spaced the slash differently in 5 of the 13 names).
interface GeoJsonFeature {
  properties: { zone: string; market_index: number; source: string };
  geometry: GeoGeometry;
}
const FEATURES = (zonesGeoJson as unknown as { features: GeoJsonFeature[] }).features;

/**
 * Load / refresh the `zoneGeometry` table from the bundled GeoJSON. Idempotent:
 * upserts by name, so re-running never creates duplicates. Run this once after
 * deploy (and again any time the bundled GeoJSON changes) via:
 *   npx convex run zones:importGeometry
 */
export const importGeometry = internalMutation({
  args: {},
  handler: async (ctx) => {
    const vocab = new Set<string>(ZONES);
    const missing = FEATURES.filter((f) => !vocab.has(f.properties.zone)).map(
      (f) => f.properties.zone,
    );
    if (missing.length > 0) {
      throw new Error(`GeoJSON zone names not in vocab: ${missing.join(", ")}`);
    }
    if (FEATURES.length !== ZONES.length) {
      throw new Error(`Expected ${ZONES.length} zones, got ${FEATURES.length}`);
    }

    let inserted = 0;
    let updated = 0;
    for (const f of FEATURES) {
      const centroid = geometryCentroid(f.geometry);
      const doc = {
        name: f.properties.zone,
        marketIndex: f.properties.market_index,
        source: f.properties.source,
        geometryType: f.geometry.type,
        coordinates: f.geometry.coordinates,
        centroidLat: centroid.lat,
        centroidLng: centroid.lng,
      };
      const existing = await ctx.db
        .query("zoneGeometry")
        .withIndex("by_name", (q) => q.eq("name", f.properties.zone))
        .unique();
      if (existing) {
        await ctx.db.patch("zoneGeometry", existing._id, doc);
        updated += 1;
      } else {
        await ctx.db.insert("zoneGeometry", doc);
        inserted += 1;
      }
    }
    return { total: FEATURES.length, inserted, updated };
  },
});

/** List all zones (name + market index + centroid) — no geometry payload.
 * Used by event proximity (events.ts) and the weekly weather fan-out
 * (weather.ts); neither needs the full polygon. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("zoneGeometry").withIndex("by_name").collect();
    return rows.map((r) => ({
      name: r.name,
      marketIndex: r.marketIndex,
      source: r.source,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
    }));
  },
});

/**
 * Onboarding core: assign a geocoded lat/lng to one of the 13 zones by
 * point-in-polygon, per README_zones.md's priority order (downtown sub-zones
 * -> Downtown Core -> the rest). Returns null when no zone matches (outside
 * coverage) — see lib/pointInPolygon.ts for the actual algorithm.
 */
export const assign = internalQuery({
  args: { lat: v.number(), lng: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("zoneGeometry").withIndex("by_name").collect();
    const features: ZoneFeature[] = rows.map((r) => ({
      name: r.name,
      marketIndex: r.marketIndex,
      source: r.source,
      geometry: { type: r.geometryType, coordinates: r.coordinates },
    }));
    const match = assignZone(args.lat, args.lng, features);
    if (!match) return { zone: null, marketIndex: null, outsideCoverage: true };
    return { zone: match.name, marketIndex: match.marketIndex, outsideCoverage: false };
  },
});
