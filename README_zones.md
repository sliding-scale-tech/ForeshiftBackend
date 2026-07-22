# ForeShift Detroit — Zone Boundaries (Developer Package)

## What this is

The definitive geographic boundaries for ForeShift's **13 Detroit zones**, used to assign a
restaurant address to a zone during onboarding (address → geocode → point-in-polygon → zone).

## Files

| File | Purpose |
|---|---|
| `foreshift_13_zones.geojson` | **The source of truth.** All 13 zone boundaries with canonical names. Load this for point-in-polygon assignment. |
| `foreshift_13_zones_map.html` | Visual reference — open in a browser to see all 13 zones on a map. |
| `assign_zones.py` | **Reference logic only** — shows the assignment approach (priority order, the Southwest Detroit grouping). It was written against the *original* source files (a 3-zone draft + the raw City neighborhoods file + a venue CSV), **not** the consolidated GeoJSON. Use it to understand the logic; implement against `foreshift_13_zones.geojson`. |

## The 13 zones

Each feature in the GeoJSON has these properties:
- `zone` — the canonical zone name (must match the demand model exactly)
- `market_index` — the zone's Market Index score (for reference)
- `source` — how the boundary was derived

| Zone | Market Index |
|---|---|
| Woodward Core | 100 |
| Foxtown/Stadium District | 95 |
| Downtown Detroit (Core) | 93 |
| Greektown/Casino District | 92 |
| Financial District | 87 |
| Midtown | 83 |
| Corktown | 79 |
| Eastern Market | 72 |
| New Center/North End | 65 |
| Riverfront/RiverWalk | 61 |
| Mexicantown | 59 |
| Core City/Woodbridge | 58 |
| Southwest Detroit | 56 |

## How to assign an address to a zone

1. **Geocode** the restaurant address → latitude/longitude.
2. **Point-in-polygon**: test the point against each zone polygon in `foreshift_13_zones.geojson`.
3. Return the `zone` property of the matching polygon.
4. If the point matches **no** zone → it is **outside coverage** (not yet supported).

### Overlaps & priority (important)
Zones are disjoint **except** for three intentional cases: **Woodward Core**, **Financial
District**, and **Foxtown/Stadium District** are drawn *inside* the broader **Downtown Detroit
(Core)** area — they are higher-value sub-zones nested within downtown.

When a point matches both a downtown sub-zone **and** Downtown Detroit (Core), the
**sub-zone wins** (it is more specific). So the assignment order is:

1. Test the three downtown sub-zones first (Woodward Core, Financial District, Foxtown/Stadium
   District).
2. Then test Downtown Detroit (Core).
3. Then test all remaining zones.
4. If no match → **outside coverage**.

All other zone pairs are **non-overlapping** (verified by a full pairwise check), so outside the
three downtown sub-zones the assignment is unambiguous — a point falls in at most one zone.

## Geometry notes

- Format: GeoJSON, WGS84 (EPSG:4326), coordinates as **[longitude, latitude]** (GeoJSON standard).
- 12 zones are single Polygons; **Southwest Detroit** is a MultiPolygon (it groups four adjacent
  neighborhoods: Hubbard Farms, Hubbard Richard, Central Southwest, Springwells).
- All rings are closed. All geometries validated.

## Riverfront/RiverWalk — boundary basis

This zone is based on the **City of Detroit's official East Riverfront District** (St. Antoine
to East Grand Boulevard, Larned Street to the Detroit River) — the dense, developed,
restaurant-relevant stretch of the riverfront (Rivertown, Orleans Landing, Harbortown).

Its **western edge has been trimmed** to abut the Downtown Detroit (Core) zone, so the two do
**not** overlap. As a result, the Renaissance Center and the immediate downtown-riverfront core
fall in **Downtown Detroit (Core)**, while Riverfront/RiverWalk covers the riverfront district
**east** of downtown. Verified: riverfront addresses east of the RenCen (e.g. the Outdoor
Adventure Center at 1801 Atwater St, Rivard Plaza, Mt. Elliott Park) correctly fall inside this
zone; the RenCen falls in Downtown.

> Note: the boundary is an approximation drawn to the official district streets and the river
> shoreline. If precise parcel-level edges are needed later, it can be refined.

## Important: zone names must match the model

The `zone` values in this file are the **canonical names** the demand model uses. Do not rename
them — the zone assignment output is joined to demand data on these exact strings.
