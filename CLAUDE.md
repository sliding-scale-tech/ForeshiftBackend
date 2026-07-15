<!-- foreshift-start -->

# ForeShift Demand Service — Build Reference

Source of truth: `ForeShift_Backend_Service_Spec.pdf` (the build spec) and
`FORESHIFT_DATA_STRUCTURE.md` (the base-demand CSV shape). This section captures
everything needed to build the backend. Confidential — ForeShift LLC — under NDA.

## What the service is

A **standalone, platform-agnostic REST API** that computes **zone demand** for a
given `zone × concept × day × daypart`. It starts from a fixed base score, applies
live **event lift (additive)** and **weather adjustment (multiplicative)**, caps the
result, and returns a **demand band**. The front-end (currently Bubble) only
orchestrates and displays; **the service does all the demand math**.

**Terminology (mandatory):** always **"zone demand"** (demand for a concept in a
zone). Never "restaurant demand" in any field name, log, or response.

## Two hard requirements (spec §5 — non-negotiable)

1. **Standalone REST API** — JSON in/out, any client can call it (curl/Postman),
   **no coupling to Bubble internals**. Rationale: the front-end may migrate off
   Bubble, and this service is meant to later power an external partner API.
2. **Owner-editable coefficients** — the coefficients in §4.2/§4.3/§4.4 (event
   affinity, event magnitude, weather affinity) must be editable by a **non-technical
   admin (the owner)** through a **simple admin screen**, with edits taking effect on
   the next request — **no code changes, no redeploy**. Store them in a DB
   table/config store, NOT hardcoded. Read them at request time (or cache with a
   short refresh).

## Demand formula (spec §2 — exact model logic, do NOT change)

```
final = MIN( (base_score + event_lift) * weather_factor , 150 )

event_lift     = SUM over events of ( event_magnitude × concept_event_affinity × proximity )
weather_factor = 1 - ( weather_severity × concept_weather_affinity )
```

- **Events are additive** — an event injects outside crowds independent of baseline
  (a big event on a slow day must still register).
- **Weather is multiplicative** — scales existing demand up or down.
- **Multiple events** → sum each event's individual lift before adding to base.
- **Cap** the final score at **150**, then **re-band** the capped score (§ bands).
- `weather_severity`: `0` = normal, `0.5` = storm, **`-0.2` = ideal-day boost**
  (negative severity makes `weather_factor > 1`, i.e. a demand boost).
- `proximity`: how close the event is to the zone — **LOCKED to discrete tiers 1.0 / 0.5 / 0** (see "Event ingestion — locked decisions" below), computed by the fetch layer.
- `base_score` is the **fixed floor**, NOT final demand.

**Worked example (build test — must reproduce exactly with the dummy coefficients):**
`base_score=30.0`, one `"Major stadium game"` (magnitude `50`), `proximity=1.0`,
event_affinity `0.50`, `weather_severity=0.5`, weather_affinity `0.35`.
`event_lift = 50 × 0.50 × 1.0 = 25` → `55.0` → `weather_factor = 1 − (0.5 × 0.35) = 0.825`
→ `55.0 × 0.825 = 45.375` → round **`45.38`** → band **`Moderate`**.

## Event ingestion — locked decisions

**Proximity model — LOCKED (adopted from `ForeShift_Dev_Spec_v72.md` §5; v8 states the
principle but gives no formula).**

- Events are relevant to **zones**, never to an operator's own lat/long. Operator
  coordinates are used **only once at onboarding** (geocode → point-in-polygon → zone).
- Relevance is by **proximity, not zone membership** (v8 §10.1): an event is matched to
  every zone it is *near*, not just the one polygon its venue sits inside.
- **Anchor = zone centroid.** Distance = `haversine(event venue lat/lng, zone centroid)`.
- **Proximity is a discrete 3-tier value — NOT a smooth decay:**

  | Distance venue → zone centroid | proximity |
  |---|---|
  | ≤ 0.6 mi | **1.0** |
  | ≤ 1.5 mi | **0.5** |
  | > 1.5 mi | **0** (event ignored for that zone) |

- One event therefore yields a `proximity` **per zone**, and can lift several nearby
  zones at once (e.g. an LCA game → Foxtown 1.0, Downtown/Greektown 0.5).
- Fetch strategy: **one city-wide Ticketmaster call**, then assign to the 13 zones
  locally by the rule above (do NOT fetch per-zone — it double-counts).
- Thresholds (0.6 / 1.5 mi) are v7.1 "calibration targets" — flag to owner as tunable.

## API contract (spec §3 — the CORE endpoint)

```
POST /zone-demand
```
Request (caller supplies events + weather; service is pure math):
```json
{
  "zone": "Woodward Core",
  "concept": "Sports Bar",
  "day": "Sat",
  "daypart": "dinner",                                  // morning | midday | dinner | late
  "events": [ { "class": "Major stadium game", "proximity": 1.0 } ],
  "weather_severity": 0.5                               // 0 normal, 0.5 storm, -0.2 ideal boost
}
```
Response:
```json
{
  "zone": "Woodward Core",
  "concept": "Sports Bar",
  "base_score": 30.0,
  "final_score": 45.38,
  "band": "Moderate",
  "event_applied": true
}
```
The caller (Bubble) fetches events (e.g. Ticketmaster) + weather and computes each
event's `proximity`. Keeping fetch in the caller keeps this service pure math. (The
spec allows the service to fetch instead, but that must be flagged — default is caller-fetch.)

## Reference data (spec §4 — the tables the service reads)

**§4.1 Base zone-demand scores — PROVIDED BY FORESHIFT.** Fixed base per
`zone × concept × day × daypart`. Local data files: `foreshift_base_demand_long.csv`
(3,276 rows, one score per row — preferred for lookups) and
`foreshift_base_demand_wide.csv` (819 rows, 4 dayparts as columns). **Both start with
8 `#` comment lines — skip them; the header is on line 9.** Long header:
`zone,concept,day,daypart,window,base_score,base_band`. Closed dayparts score 0 (Minimal).
Load into the datastore and look up the row matching the request.

**§4.2 Event affinity by concept** — DUMMY `0.50` for all 9 concepts (owner loads real).
**§4.3 Event magnitude by class** — DUMMY (owner loads real):
| Event class | Magnitude |
|---|---|
| Major stadium game | 50 |
| Concert / large show | 30 |
| Festival day | 20 |
| Minor event | 10 |

**§4.4 Weather affinity by concept** — DUMMY `0.35` for all (owner loads real).
Used in `weather_factor = 1 − (severity × weather_affinity)`.

**§4.5 Band thresholds (safe to share):**
| Band | Range |
|---|---|
| Exceptional | 110–150 |
| Peak | 85–109 |
| High | 65–84 |
| Moderate | 40–64 |
| Light | 20–39 |
| Minimal | 0–19 |

Exceptional never appears in base data (max observed ≈100.4) — only reachable after
event/weather layers. Re-band the capped final score with these thresholds.

## Vocabularies (exact strings — a mismatch silently breaks the lookup)

Canonical source in code: `convex/lib/vocab.ts`. Bubble option sets must match exactly.

- **13 zones:** Woodward Core; Downtown Detroit (Core); Foxtown / Stadium District;
  Greektown / Casino District; Financial District; Midtown; Corktown; Eastern Market;
  New Center / North End; Riverfront / RiverWalk; Mexicantown; Core City / Woodbridge;
  Southwest Detroit.
- **9 concepts:** Fine Dining; Upscale Casual; Casual Dining; Fast Casual; Coffee Shop;
  Breakfast / Brunch Cafe; Sports Bar; Cocktail Lounge; Neighborhood / Casual Bar.
- **7 days:** Mon, Tue, Wed, Thu, Fri, Sat, Sun.
- **4 dayparts:** `morning` 06:00–11:00 · `midday` 11:00–16:00 · `dinner` 16:00–21:00 ·
  `late` 21:00–02:00 (crosses midnight).

## Recalibration flow (spec §6 — build for this loop)

Venues report actual busy-ness → ForeShift compares predicted vs actual (owner's
analysis, outside the service) → owner updates coefficients via the admin screen (§5.2)
→ service immediately uses updated values on the next request. **You do NOT build the
analysis step**; you must ensure steps 3–4 work (owner-editable, live-effect). Optionally
log each request's inputs/outputs to support later recalibration.

## What ForeShift provides

- Base zone-demand score file (§4.1, ~3,276 rows) — at build start (under NDA). ✅ present locally.
- Real coefficient values (§4.2–4.4) — loaded by owner via admin AFTER build; not needed to build.
- Zone/concept names, daypart windows, band thresholds — in the spec (above).

## Dev checklist (spec §8)

- [ ] Standalone REST API, JSON in/out, callable independently (not Bubble-coupled)
- [ ] Formula §2 exactly (additive events, multiplicative weather, cap 150, re-band)
- [ ] Passes the §2 worked example (dummy inputs → **45.38 / Moderate**)
- [ ] Reads base scores from the provided data file (§4.1)
- [ ] Coefficients in an editable store, NOT hardcoded (§5.2)
- [ ] Simple admin interface for the owner to edit coefficients (no code/redeploy)
- [ ] Coefficient edits take effect live (next request)
- [ ] "Zone demand" terminology throughout
- [ ] Deployable as serverless (low-cost, auto-scaling) — Convex satisfies this
- [ ] (Optional) request logging for recalibration analysis

## Phases

- **Phase 1 (build now) = the PDF spec.** The pure-math `POST /zone-demand` service:
  coefficient store + admin, base-score table, spec-exact formula, the endpoint, and
  the worked-example test. This is the required deliverable.
- **Phase 2 (deferred, complete later) = AI narration.** The `POST /ai/ask` Gemini
  natural-language pipeline (`convex/lib/orchestrator.ts`, `gemini.ts`, `bubble.ts`,
  `aggregate.ts`; see `AI_PIPELINE.md`). Already partly built. **Leave it in place — do
  not delete it** — but it is NOT part of the Phase 1 spec deliverable.

Note: Ticketmaster/WeatherAPI weekly cron and Bubble `EventSignal`/`WeatherSignal`
tables (mentioned in `cursor.md`) are Phase 2 / caller-side concerns — the Phase 1 PDF
has the **caller** supply events/weather, so `/zone-demand` stays pure math.

## Current state — Phase 1 not yet built (honest)

- **`POST /zone-demand` does not exist.** `convex/http.ts` only exposes the Phase 2
  `POST /ai/ask`.
- **`convex/lib/formula.ts` is provisional** — takes abstract `lift`/`multiplier`
  inputs; does NOT encode `magnitude × affinity × proximity` / `1 − (severity × affinity)`
  or the 150 cap. **Rewrite to spec §2.**
- **No coefficient store and no admin screen** (§5.2 unmet — hard requirement).
- **`convex/lib/providers.ts` are dummies** (lift 0, multiplier 1.0).
- **`convex/schema.ts` is still the Convex starter template** (`documents` table) —
  needs real tables: base scores + editable coefficients (+ optional request log).

**Phase 1 build order:** (1) coefficient tables + admin, (2) base-score table +
importer, (3) spec-exact `formula.ts`, (4) `POST /zone-demand` endpoint, (5) worked-
example unit test → **45.38 / Moderate**.

## File map & env

| File | Role |
|---|---|
| `convex/http.ts` | HTTP entry (`/ai/ask` today; add `/zone-demand`) |
| `convex/schema.ts` | DB tables (needs base-score + coefficient tables) |
| `convex/lib/formula.ts` | Demand formula — **align to spec §2** |
| `convex/lib/vocab.ts` | Canonical vocab, band thresholds, field maps |
| `convex/lib/providers.ts` | Event/weather context (dummy) |
| `convex/lib/orchestrator.ts` · `gemini.ts` · `bubble.ts` · `aggregate.ts` | AI-narration pipeline (Phase 2) |

Env vars: `FORESHIFT_SHARED_SECRET` (optional API auth), `BUBBLE_API_BASE`,
`BUBBLE_API_TOKEN`, `BUBBLE_DEMAND_TABLE`, `GEMINI_API_KEY` (Phase 2 only),
`TICKETMASTER_API_KEY` / `WEATHERAPI_KEY` (Phase 2 / caller-side, if used).

<!-- foreshift-end -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
