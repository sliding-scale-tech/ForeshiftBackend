// Geo helpers: great-circle distance + Detroit search-area derivation.
//
// Distance constants are the LOCKED proximity thresholds from
// ForeShift_Dev_Spec_v72.md §5 (see CLAUDE.md "Event ingestion — locked decisions"):
//   <= 0.6 mi -> proximity 1.0 ; <= 1.5 mi -> 0.5 ; > 1.5 mi -> 0.

export const PROXIMITY_NEAR_MILES = 0.6; // within this -> proximity 1.0
export const PROXIMITY_FAR_MILES = 1.5; // within this -> proximity 0.5; beyond -> 0

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_MILES = 3958.7613;

/** Great-circle distance between two points, in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The LOCKED proximity rule: distance (miles) from an event venue to a zone
 * centroid -> proximity tier. <=0.6 -> 1.0 ; <=1.5 -> 0.5 ; beyond -> 0.
 */
export function proximityTier(distanceMiles: number): number {
  if (distanceMiles <= PROXIMITY_NEAR_MILES) return 1.0;
  if (distanceMiles <= PROXIMITY_FAR_MILES) return 0.5;
  return 0;
}

/**
 * Given the zone centroids, derive a single search center + radius that covers
 * every point within `marginMiles` of any zone. Center = mean of centroids;
 * radius = farthest centroid from center + margin (rounded up to an integer,
 * since Ticketmaster's `radius` is a whole number of miles).
 */
export function computeSearchArea(
  zones: LatLng[],
  marginMiles: number,
): { latlong: string; radiusMiles: number } {
  if (zones.length === 0) {
    throw new Error("No zones to derive a search area from — seed zones first.");
  }
  const center: LatLng = {
    lat: zones.reduce((s, z) => s + z.lat, 0) / zones.length,
    lng: zones.reduce((s, z) => s + z.lng, 0) / zones.length,
  };
  const maxDist = Math.max(...zones.map((z) => haversineMiles(center, z)));
  return {
    latlong: `${center.lat.toFixed(5)},${center.lng.toFixed(5)}`,
    radiusMiles: Math.ceil(maxDist + marginMiles),
  };
}
