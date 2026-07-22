# Zone Assignment — Client Package Brief

Summarizes the 4 files the client dropped in (`foreshift_13_zones.geojson`,
`foreshift_13_zones_map (2).html`, `README_zones.md`, `assign_zones.py`) and maps them
against what's already in the repo. This is a **read-and-understand** doc, not a build
plan — action plan comes next.

## What the client is asking for

Give every operator (restaurant) a **canonical zone** at onboarding time, computed from
their street address:

```
address → geocode (lat/lng) → point-in-polygon against the 13 zone boundaries → zone name
```

That zone name is what everything downstream (base-demand lookups, `/zone-demand`,
event proximity) keys off. The client is delivering the **boundary geometry** (the hard
part); we own wiring it into the app.

## The 4 files and their role

| File | Role | Use it for |
|---|---|---|
| `foreshift_13_zones.geojson` | **Source of truth.** 13 features, canonical `zone` name + `market_index` + `source` per feature. WGS84, `[lng, lat]` coordinate order. | Load into the DB / point-in-polygon engine. This is the only file to implement against. |
| `foreshift_13_zones_map (2).html` | Static Leaflet map — visual QA only, embeds the same ring data as the GeoJSON. | Sanity-check boundaries in a browser. Not consumed by code. |
| `README_zones.md` | Spec for the assignment algorithm: priority order, overlap rules, geometry notes. | The actual instructions — see below. |
| `assign_zones.py` | **Reference logic only**, written against an *earlier*, pre-consolidation set of source files (draft downtown boxes + raw City neighborhoods file + a venues CSV) — not against the final GeoJSON. | Shows the *shape* of the algorithm (priority order, Shapely point-in-polygon, Southwest Detroit's 4-neighborhood grouping). Do not run it or port its file-loading; reimplement its `assign()` logic against `foreshift_13_zones.geojson`. |

## The 13 zones (name, market index, geometry source)

| Zone (GeoJSON `zone` value) | Market Index | Geometry source | Shape |
|---|---|---|---|
| Woodward Core | 100 | drawn_box | Polygon (downtown sub-zone) |
| Foxtown/Stadium District | 95 | drawn_box | Polygon (downtown sub-zone) |
| Downtown Detroit (Core) | 93 | official_neighborhood | Polygon (broad downtown) |
| Greektown/Casino District | 92 | official_neighborhood | Polygon |
| Financial District | 87 | drawn_box | Polygon (downtown sub-zone) |
| Midtown | 83 | official_neighborhood | Polygon |
| Corktown | 79 | official_neighborhood | Polygon |
| Eastern Market | 72 | official_neighborhood | Polygon |
| New Center/North End | 65 | official_neighborhood | Polygon |
| Riverfront/RiverWalk | 61 | east_riverfront_district_official | Polygon |
| Mexicantown | 59 | official_neighborhood | Polygon |
| Core City/Woodbridge | 58 | official_neighborhood | Polygon |
| Southwest Detroit | 56 | official_neighborhood_group | **MultiPolygon** (4 neighborhoods: Hubbard Farms, Hubbard Richard, Central Southwest, Springwells) |

## Assignment algorithm (README §"How to assign an address to a zone")

1. Geocode the address → lat/lng.
2. **Three downtown sub-zones are drawn nested inside the broader Downtown Detroit
   (Core) polygon** — that's an intentional overlap, the only one in the dataset:
   - Woodward Core
   - Financial District
   - Foxtown/Stadium District
3. Priority order for point-in-polygon testing:
   1. Test the 3 downtown sub-zones first → if the point matches one, **that wins**
      (more specific).
   2. Else test Downtown Detroit (Core).
   3. Else test all remaining zones (each disjoint from every other — a full pairwise
      check verified no other overlaps, so at most one match here).
   4. No match anywhere → **outside coverage** (not yet supported — needs an explicit
      "unsupported address" outcome, not a silent default zone).
4. Southwest Detroit is a MultiPolygon — a standard point-in-(multi)polygon test
   against all 4 rings, returned as one zone name either way.

`assign_zones.py` mirrors this exact priority order (drawn boxes → Downtown catch-all →
grouped zones → kept single-neighborhood zones → "Out of Scope"), just against its
older, pre-consolidation file set.

## Geometry notes to not get wrong

- GeoJSON coordinate order is **`[longitude, latitude]`** — reversed from the
  `{lat, lng}` shape used everywhere else in this codebase (`convex/lib/geo.ts`,
  `convex/zones.ts`). Any point-in-polygon code needs to handle this conversion
  explicitly or it will silently test against swapped coordinates.
- 12 zones are `Polygon`; **Southwest Detroit is `MultiPolygon`** — geometry-handling
  code needs to branch on `geometry.type`.
- Rings are closed, geometries validated, no gaps expected other than the 3 documented
  downtown-nesting overlaps.

## Cross-check against the current codebase

**`convex/zones.ts`** currently seeds the `zones` table with 13 **approximate
centroids** (lat/lng points only, no polygons) — explicitly commented as
"PROVISIONAL... not authoritative geodata," to be overwritten once ForeShift delivers
official geometry. That geometry is what just arrived. Today `zones` is used only for
**event proximity** (haversine event-venue → zone-centroid, per `convex/lib/geo.ts`'s
locked 0.6mi/1.5mi tiers) — a different consumer than the onboarding assignment this
package is for. Both can read from the same underlying geometry, but:
- Event proximity needs a **centroid per zone** (works fine from polygons — take the
  centroid of each geometry, or of each MultiPolygon's parts combined for Southwest
  Detroit).
- Onboarding assignment needs the **full polygon**, not just the centroid.

**No onboarding / address-to-zone code exists yet** in `convex/` — no operators table,
no geocoding call, no point-in-polygon function. This is net-new.

**Zone-name mismatch — resolved.** `convex/lib/vocab.ts`'s `ZONES` is the canonical
list everything else joins against (base-demand lookups, coefficients, event/weather
signals, Bubble), so the GeoJSON was updated to match it rather than the other way
around. 5 of 13 `zone` properties were re-spaced to add the surrounding spaces around
`/` (`Foxtown/Stadium District` → `Foxtown / Stadium District`, and same for
Greektown/Casino District, New Center/North End, Riverfront/RiverWalk, Core
City/Woodbridge). All 13 `zone` values in `foreshift_13_zones.geojson` now match
`vocab.ts` exactly — verified by diffing both lists. The map HTML
(`foreshift_13_zones_map (2).html`) and `README_zones.md` still show the client's
original un-spaced names (display/reference only, not consumed by code) — flag if we
want those regenerated for consistency too.

## Implemented

The onboarding zone-assignment flow described above is now live:

- **`convex/data/foreshiftZones.json`** — the corrected GeoJSON, bundled as a static
  import (Convex's esbuild-based bundler parses `.json` imports directly, no file I/O
  at request time).
- **`convex/lib/pointInPolygon.ts`** — the pure ray-casting primitives
  (`pointInRing`, `pointInGeometry`), the priority-order `assignZone` (sub-zones →
  Downtown Core → rest → null), and `geometryCentroid` (replaces the old
  hand-picked approximate centroids with ones derived from the real boundaries).
- **`convex/schema.ts`** — old `zones` table (approximate centroids) replaced by
  `zoneGeometry`: `name`, `marketIndex`, `source`, `geometryType`, `coordinates`
  (the full ring data), `centroidLat`/`centroidLng`.
- **`convex/zones.ts`** — `importGeometry` (idempotent upsert from the bundled JSON,
  run once via `npx convex run zones:importGeometry`), `list` (lightweight
  name/marketIndex/centroid projection — used by `events.ts` and `weather.ts`, which
  no longer touch the old table), and `assign` (the point-in-polygon lookup).
- **`convex/http.ts`** — new `POST /zone-assign` endpoint. Bubble geocodes the address
  and sends just `{ lat, lng }`; the endpoint is pure geometry, no external calls.
- **`convex/events.ts`** / **`convex/weather.ts`** — updated to read centroids from
  `zoneGeometry` instead of the retired `zones` table.

Verified against the live dev deployment (`coordinated-bee-26`) with the exact
coordinates walked through in conversation — Woodward Core, Financial District,
Foxtown / Stadium District, the Downtown Core catch-all, Greektown, the Southwest
Detroit MultiPolygon, and an outside-coverage point all return correctly.

### Example API call (Bubble → Convex)

```
POST https://coordinated-bee-26.convex.site/zone-assign
Content-Type: application/json

{ "lat": 42.334, "lng": -83.047 }
```

Match:
```json
{ "zone": "Woodward Core", "market_index": 100, "outside_coverage": false }
```

No match:
```json
{ "zone": null, "market_index": null, "outside_coverage": true }
```

If `FORESHIFT_SHARED_SECRET` is set in the Convex env, Bubble must also send
`x-foreshift-secret: <secret>` — same convention as `/zone-demand`.

### Still open

- Geocoding provider for turning an operator's address into lat/lng — Bubble's side,
  not specified by the client package.
- What Bubble does on `outside_coverage: true` (reject onboarding, flag for manual
  review, etc.) — a product decision, not a backend one.
- `geometryCentroid`'s ring-point average is a rough stand-in for a true area-weighted
  centroid — fine for the 0.6mi/1.5mi event-proximity tiers, revisit if it ever needs
  to be more precise.
