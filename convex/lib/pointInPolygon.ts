// Point-in-polygon assignment for onboarding: operator lat/lng -> canonical
// zone name, per the client's foreshift_13_zones.geojson + README_zones.md.
//
// GeoJSON coordinate order is [lng, lat] (reversed from the {lat, lng} shape
// used everywhere else in this codebase) — kept local to this file's ring
// arrays; every public function here takes/returns plain lat/lng numbers.

export type GeoRing = [number, number][]; // closed ring of [lng, lat] points

export type GeoGeometry =
  | { type: "Polygon"; coordinates: GeoRing[] }
  | { type: "MultiPolygon"; coordinates: GeoRing[][] };

export interface ZoneFeature {
  name: string;
  marketIndex: number;
  source: string;
  geometry: GeoGeometry;
}

/**
 * Ray-casting (even-odd rule): count how many edges of `ring` a horizontal
 * ray from (lng, lat) heading east crosses. Odd = inside, even = outside.
 * Works identically for a 4-point box or a 150-point jagged boundary — same
 * loop, just more edges.
 */
export function pointInRing(lng: number, lat: number, ring: GeoRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    const rayCrossesEdge =
      straddles && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (rayCrossesEdge) inside = !inside;
  }
  return inside;
}

/** Handles both shapes the GeoJSON uses: Polygon (one ring) and MultiPolygon
 * (Southwest Detroit's 4 separate neighborhood rings — first match wins). */
export function pointInGeometry(lng: number, lat: number, geometry: GeoGeometry): boolean {
  if (geometry.type === "Polygon") {
    return pointInRing(lng, lat, geometry.coordinates[0]);
  }
  return geometry.coordinates.some((poly) => pointInRing(lng, lat, poly[0]));
}

// The 3 downtown sub-zones drawn nested inside Downtown Detroit (Core) — the
// only intentional overlap in the dataset (README_zones.md "Overlaps & priority").
// A sub-zone match wins over the broader Downtown Core match.
const DOWNTOWN_SUB_ZONES = [
  "Woodward Core",
  "Financial District",
  "Foxtown / Stadium District",
];
const DOWNTOWN_CORE = "Downtown Detroit (Core)";

/**
 * Assign a geocoded point to one of the 13 zones, per README_zones.md's
 * priority order: sub-zones first, then Downtown Core, then the remaining
 * (verified pairwise-disjoint) zones. Returns null = outside coverage.
 */
export function assignZone(lat: number, lng: number, features: ZoneFeature[]): ZoneFeature | null {
  const byName = new Map(features.map((f) => [f.name, f]));

  for (const name of DOWNTOWN_SUB_ZONES) {
    const f = byName.get(name);
    if (f && pointInGeometry(lng, lat, f.geometry)) return f;
  }

  const core = byName.get(DOWNTOWN_CORE);
  if (core && pointInGeometry(lng, lat, core.geometry)) return core;

  for (const f of features) {
    if (DOWNTOWN_SUB_ZONES.includes(f.name) || f.name === DOWNTOWN_CORE) continue;
    if (pointInGeometry(lng, lat, f.geometry)) return f;
  }

  return null;
}

/**
 * Rough centroid for event-proximity math (haversine venue -> zone centroid,
 * see lib/geo.ts) — average of a ring's own points. Not an area-weighted
 * centroid, just a stand-in "middle" of the shape; good enough for the
 * 0.6mi/1.5mi proximity tiers, and strictly better than the old hand-picked
 * approximate guesses since it's derived from the real boundary.
 */
export function geometryCentroid(geometry: GeoGeometry): { lat: number; lng: number } {
  const rings: GeoRing[] =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0]]
      : geometry.coordinates.map((poly) => poly[0]);

  let sumLat = 0;
  let sumLng = 0;
  let count = 0;
  for (const ring of rings) {
    // Skip the closing point (ring[0] === ring[last]) so it isn't double-weighted.
    for (let i = 0; i < ring.length - 1; i++) {
      sumLng += ring[i][0];
      sumLat += ring[i][1];
      count += 1;
    }
  }
  return { lat: sumLat / count, lng: sumLng / count };
}
