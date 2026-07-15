# ForeShift Development Specification — v7.1 (file: v72.pdf)

> **Reference only — NOT our build source of truth.** This is the **first** spec the
> client sent. We are **not** following it exactly; we refer to it when we need the
> original modeling intent (proximity tiers, event classes, holiday layer, evidence
> status, staffing math, acceptance tests). The authoritative build spec is
> `ForeShift_Backend_Service_Spec.pdf` (captured in `CLAUDE.md`).
>
> Source: `ForeShift_Development_Spec_v72.pdf`. Internal title says **v7.1** (filename
> says v72). Model master: `ForeShift_Detroit_v71.xlsx` · **10 Detroit zones** · 560
> baseline rows · holiday/occasion layer added. CONFIDENTIAL — under NDA, post
> provisional-patent filing.

## Key differences vs. our current build spec (read this first)

| Topic | v7.1 (this doc) | Newer PDF / our CLAUDE.md |
|---|---|---|
| Zones | **10** (incl. Mexicantown) | **13** |
| Concepts | 8 | 9 |
| Base grain | `structural_base` × `SeasonalIndex[zone][month]` × `daypart_fraction` (computed) | fixed `base_score` per zone×concept×day×daypart (pre-computed, 3,276 rows) |
| Event classes | **5**: major_game 60, arena_game 45, concert 35, festival 25, minor 15 | **4**: 50 / 30 / 20 / 10 |
| Proximity | **3-tier**: ≤0.6mi→1.0, ≤1.5mi→0.5, else 0 (adjacent zones credited) | "0–1 based on distance to zone" (curve open) |
| Weather | `1 − severity×affinity`; severity 0.5/0.25/−0.10 tiers | `1 − severity×affinity`; severity 0/0.5/−0.2 |
| Extra layers | **Holiday/occasion** (signed −1..+1), **SeasonalIndex**, **EvidenceStatus** (supply axis), staffing translation | none — pure `/zone-demand` math |
| Score floor | `MAX(…, 0)` floor (holidays can go negative) | cap 150 only (events additive ≥0) |
| Narration | §5.5 server-side AI advisory layer | Phase 2 `/ai/ask` |
| Deploy target | Bubble backend workflows OR stateless Node/Python service | Convex REST |

**Events are zone-based in BOTH specs.** See "Event ingestion" below.

---

## 1. Architecture principle — Excel is the model master, app is delivery

Heavy model construction = **Phase A** (in the `v71.xlsx` workbook: Location/Concept
scores, capture-weight blends, zone-daypart resolution, venue-supply evidence, the 560
baseline values, holiday affinity profiles). The app implements **Phase B only**:
lookups, one scoring formula, narration. Phase A is exported as flat CSVs.

**Two layers, never merged:** deterministic scoring (§3) produces a number + band; the
narration layer (§5.5) turns it into language. **Narration narrates, never computes** —
it may not alter scores.

## 2. Data model — ten core tables

Fields marked **[TS]** = trade secret: server-side only, never exposed via API
responses, page data, or client-visible searches. Operators see bands/statuses/
recommendations — never raw coefficients.

| Table | Key fields | Rows | Notes |
|---|---|---|---|
| **Zone** | `name`, `display_name`, `geo_center (lat/lng)`, `geo_radius` | 10 | Includes Mexicantown. **Geo drives event-API queries.** |
| **ConceptType** | `name`, `daypart_allocation`[TS], `turn_rates`[TS], `event_affinity`[TS], `weather_affinity`[TS] | 8 | `event_affinity` applies to EventMagnitude **ONLY** (§3.1). |
| **BaselineCurve** | `zone`, `concept_type`, `day_of_week`, `structural_base`[TS], `daypart_fraction (4)`[TS] | 560 | Uncapped, seasonal-free. Sports Bar base excludes NFL seasonality. |
| **SeasonalIndex** | `zone`, `month`, `index_value`[TS] | 120 | 10 zones × 12 months. |
| **EvidenceStatus** | `zone`, `concept_type`, `status`, `demand_per_venue`[TS] | 80 | Supply axis (§3.2). status ∈ {Opportunity, Average, Saturated}. |
| **EventMagnitude** | `event_class`, `magnitude` | 4* | major_game 60, concert 35, festival 25, minor 15. (*classifier in §5 also yields arena_game 45) |
| **HolidayOccasion** | `occasion`, `date_rule`, `archetype`, `magnitude`, `primary_daypart` | 8 | NEW. Calendar occasions; floating-date rules. Magnitude in EventMagnitude units. |
| **HolidayAffinity** | `occasion`, `concept_type`, `affinity`[TS] | 64 | NEW. **SIGNED −1..+1.** Occasion-specific; do NOT substitute `event_affinity`. |
| **Parameter** | `name`, `value` | 7 | `score_cap` 150; proximity; weather bounds; `utilization_default` 1.0. |
| **Operator** | `zone`, `concept_type`, `seats`, staffing params, `hours_overrides` | per user | **Staffing only, never demand. Not exported.** (No geo fields.) |

**Band** = 6-row display reference (`band`, `lower`, `upper`, `trend_up`, `trend_down`),
consumed as an option set + the edge-trend rule (§3.1). **Export pipeline:** one CSV per
table from the workbook; quarterly Phase A rebuilds = re-export + re-import, no code
changes.

## 3. Runtime calculation

Two independent outputs, **kept separate by design**: the **DEMAND SCORE** (how much
appetite) and the **EVIDENCE STATUS** (whether it's already served). Displayed side by
side; must not be merged. **Supply never enters the demand score.**

### 3.1 Demand score (the runtime formula)

```
base         = BaselineCurve.structural_base × SeasonalIndex[zone][month]
daypart_base = base × BaselineCurve.daypart_fraction[daypart]

event_lift   = SUM events: EventMagnitude × ConceptType.event_affinity × proximity   (additive, ≥ 0)
holiday_lift = HolidayOccasion.magnitude × HolidayAffinity[occasion][concept]        (SIGNED; 0 if none)
weather_fx   = 1 − weather_severity × ConceptType.weather_affinity

score = MAX( MIN( (daypart_base + event_lift + holiday_lift) × weather_fx , 150 ) , 0 )
```

Order (validated): **lifts (event + holiday) ADD → weather MULTIPLIES → cap 150 → floor 0.**

- **`proximity = 1.0` inside the operator's zone, `0.5` adjacent, `0` otherwise (v1).**
- **Floor at 0 is load-bearing:** holiday affinities are SIGNED and can be strongly
  negative (closure/suppression), driving the adjusted score below 0 before the floor.
  Event affinities never do this (0..1, additive only).
- **CRITICAL — `event_affinity` is NOT holiday affinity.** `event_affinity` is tuned for
  event crowds (games/concerts/festivals) and applies ONLY to EventMagnitude classes.
  Holidays use the separate SIGNED `HolidayAffinity` table, often inverted vs.
  `event_affinity`. (Stadium game: Sports Bar 1.0, Fine Dining 0.15. Valentine's: Fine
  Dining +1.0, Sports Bar −0.2.) Applying the event column to holidays = backwards.
- **Holiday + event stacking (v1 decision):** when a holiday and a real event coincide
  and describe the same demand, both `holiday_lift` and `event_lift` apply additively;
  the cap absorbs overlap. May over-count; flagged for POS calibration (Phase-2 revisit).
  **Do NOT de-duplicate silently at runtime** — keep both terms so narration can attribute each.

**Band mapping:** 110–150 Exceptional · 85–109 Peak · 65–84 High · 40–64 Moderate ·
20–39 Light · 0–19 Minimal.

**Edge-trend display rule:** within **4 points** of a band boundary, append the
adjacent-band hint. 82 (High, upper 84) → "High — trending toward Peak"; 87 (Peak, lower
85) → "Peak — softening toward High". Mid-band scores show band name only.

**Daypart split:** `daypart_score = score × BaselineCurve.daypart_fraction[daypart]`
(zone-specific). Dayparts: Morning 6–11, Midday 11–4, Dinner 4–9, Late Night 9–2.

### 3.2 Evidence status (supply axis — lookup, not computed at runtime)

Each `zone × concept` carries a pre-computed `EvidenceStatus` from the workbook — a
straight lookup, never recomputed. Displayed next to the demand band:
**Opportunity** (high demand vs venues), **Average** (moderate field), **Saturated**
(well-served/contested). e.g. "Fine Dining — Exceptional demand · Opportunity status."
The two axes are independent; never collapse into one label.

**Staffing translation:**
```
covers   = (daypart_score / 150) × seats × turn_rate × utilization
servers  = CEILING(covers / covers_per_server)
cooks    = CEILING(covers / covers_per_cook)
revenue  = covers × avg_check
```
CEILING always rounds **UP**. **Utilization = 1.0** (Parameter.csv default; turn rates
already encode throughput — any 0.85 from earlier drafts is superseded).

## 4. Bubble.io implementation map

| ForeShift element | Bubble construct |
|---|---|
| Zones, ConceptTypes, curves, indices, evidence, HolidayOccasion, HolidayAffinity, Band | Data types; bulk CSV import; privacy rules = no client access to [TS] fields |
| Bands, dayparts, event classes, statuses, occasions | Option sets |
| Demand-score formula | **Server-side** backend workflow → `Forecast` data type. Do NOT compute [TS] math in page expressions. |
| Holiday detection | Calendar resolver (date + floating-date rules). **NOT an API call.** |
| Evidence status | Lookup by zone+concept; display alongside band. No runtime math. |
| **Event detection API** | API Connector to events API; **query by zone `geo_center`+radius and date; classify by venue size/segment.** |
| Weather API | API Connector to forecast API (NWS or OpenWeather); map to severity scale. |
| Narration layer | Server-side AI call (§5.5); receives score/band/trend/factors; returns copy. Never alters scores. |
| Weekly refresh | Scheduled backend workflow per operator: resolve holidays, fetch events, fetch weather, recompute 7×4 Forecast, request narration. |
| Operator onboarding | Form: zone dropdown (10), concept dropdown, operational params; hours pre-filled. |
| Display | Weekly 7×4 grid colored by band (edge-trend label); evidence chip; staffing card; narration per cell/day. |
| Quarterly update | Re-import CSVs from Excel master — no workflow changes. |

## 5. Event, weather, and holiday ingestion — **implement classification exactly**

| Rule | Logic |
|---|---|
| **Event magnitude** | `segment=Sports & capacity ≥ 30k → major_game (60)`; `Sports < 30k → arena_game (45)`; `Music ≥ 8k → concert (35)`; `capacity ≥ 3k → festival (25)`; `else minor (15)` |
| **Zone proximity** | `haversine(venue, zone centroid): ≤ 0.6 mi → 1.0; ≤ 1.5 mi → 0.5; else 0` |
| **Weather severity** | `thunder/snow OR precip ≥ 70% → 0.5`; `rain OR precip ≥ 40% → 0.25`; `sunny & 68–84°F → −0.10`; `else 0` |
| **Holiday detection** | Resolve `HolidayOccasion.date_rule` against the calendar (incl. floating rules: 4th Thu Nov, 2nd Sun May). Match → apply `holiday_lift` via HolidayAffinity. **No API.** |
| **Stacking** | Same-day event + holiday: both `event_lift` and `holiday_lift` ADD → weather multiplies → cap 150 → floor 0. |

> **Coordinates:** zone centroids and venue coordinates MUST be verified against
> authoritative geodata; the proximity thresholds (0.6/1.5 mi) are calibration targets.
>
> ⚠️ **Note the capacity dependency:** this classifier keys off venue **capacity**
> (≥30k, ≥8k, ≥3k). Ticketmaster does not reliably return capacity — hence our plan to
> back it with a curated Detroit major-venue tier list.

### 5.5 Narration layer (advisory copy)

Server-side AI call: receives model outputs, returns operator-facing guidance. Narrates,
never computes/overrides.

- **Input contract** (per zone×concept×day[×daypart]): `score`, `band`, edge-trend flag,
  contributing factors (event(s)/holiday/weather) with each factor's **signed direction**,
  and whether lift is base-driven or overlay-driven. Must NOT receive raw [TS] coefficients
  beyond what's needed to name a factor.
- **Tone rules:** (1) advisory only ("may", "consider", "based on early signals" — never
  directives); (2) attribute the driving factor(s) + direction; (3) defer to the operator.
- **Confidence modulation:** hedge harder when (a) score within 4 pts of a band edge, or
  (b) lift is overlay-driven (more falsifiable than steady base). Soften "likely" → "may".
- **Example:** *"Early signals point to Peak demand tonight, trending toward Exceptional —
  driven by a major game nearby and clear weather. Based on your foot traffic, you may
  want to consider extending Late Night hours; confirm against what you see in the room."*

## 6. Custom-web alternative (non-Bubble path)

A single **stateless scoring service** (Node/Python, ~250 lines), one endpoint
(`operator_id → weekly forecast + evidence statuses + narration`), backed by Postgres
tables mirroring §2 (incl. HolidayOccasion/HolidayAffinity/Band), cron jobs for weekly
event/weather/holiday refresh + on-demand CSV import. Narration = server-side API call.
No queue/cache/ML at launch. *(This is closest to our Convex approach.)*

## 7. Acceptance tests (validated v71 values — reproduce to ±0.2)

Month index 6 (June), normal weather unless noted. T16–T22 = holiday layer.

| # | Scenario | Expected |
|---|---|---|
| T1 | Campus Martius · Fine Dining · Sat · June · no events | 145.0 → EXCEPTIONAL |
| T2 | Core City · Sports Bar · Tue · June · baseline | 24.8 → LIGHT |
| T3 | T2 + major game (60 × 1.0 × 1.0) | 84.8 → HIGH |
| T4 | T3 + storm (severity 0.5, affinity 0.30 → ×0.85) | 72.1 → HIGH |
| T5 | Same game, Core City Fine Dining Tue (affinity 0.15) | base + 9 only — unrelated type must NOT spike |
| T6 | Eastern Market · Fine Dining · Sat · June | 61.6 → MODERATE (uncapped) |
| T7 | Mexicantown · Casual Dining · Sat · June | 66.2 → HIGH |
| T8 | Mexicantown · Fine Dining · Sat · June | 87.1 → PEAK |
| T9 | Evidence: Corktown · Fine Dining | Opportunity (high demand, ~0 venues) |
| T10 | Evidence: Mexicantown · Casual Dining | Saturated (dense casual field) |
| T11 | Two-axis: Corktown Fine Dining | Exceptional demand AND Opportunity, never merged |
| T12 | Any score, any inputs | always within [0,150] |
| T13 | Staffing: 2.3 servers required | rounds to 3 (CEILING, never down) |
| T14 | Lions Sun (Ford Field 65k) + rain 60% · Campus sports bar · Sep | base + 60×1.0, ×0.93 rain, cap → 150 EXCEPTIONAL |
| T15 | Same Lions game · New Center & Core City profiles | event lift = 0 (beyond 1.5 mi) — no geographic leakage |
| T16 | Valentine's · Corktown Fine Dining Sat (holiday_lift 70 × +1.0) | 125 + 70 → cap 150 EXCEPTIONAL |
| T17 | Christmas · Financial Coffee Thu (70 × −0.6 = −42) | 68 − 42 → 26 LIGHT; asserts suppression + floor at 0 |
| T18 | Thanksgiving · Campus Casual Thu (60 × −0.4) | 83.6 − 24 → 59.6 MODERATE (suppressed) |
| T19 | Thanksgiving · Greektown Sports Bar Thu (60 × +0.3) | 64.8 + 18 → 82.8 HIGH (LIFTED — opposite sign vs T18) |
| T20 | Valentine's · Campus Sports Bar Sat (70 × −0.2) | 109.6 − 14 → 95.6 PEAK (inversion: NOT lifted) |
| T21 | Stacking: Thanksgiving + Lions game · sports bar | holiday_lift +18 AND event_lift +60 both apply, cap absorbs |
| T22 | Edge-trend: score 82.8 (High, upper 84) | label = "High — trending toward Peak" |

**Evidence-status thresholds (reference):** `demand_per_venue = avg daily demand /
(venue count + 0.5)`; Saturated < 7, Average 7–18, Opportunity > 18. Uniform across
concepts. App consumes the **status label**, not the threshold math.

## 8. Security, IP, sequencing

Coefficients, curve values, daypart fractions, demand-per-venue, and the **signed
HolidayAffinity matrix** are the trade-secret core: server-side-only access (privacy
rules on every [TS] field), excluded from API responses/logs; show operators bands +
status labels, not raw scores, by default.

**Sequencing gate:** file the provisional patent BEFORE sharing this doc or the data
export with any external developer; use NDAs regardless. Event/weather API ToS must be
reviewed for commercial-use compliance before launch.

## 9. Phasing

| Phase | Scope |
|---|---|
| **MVP (Tier 1, $99)** | Onboarding (10 zones); weekly 7×4 band grid w/ edge-trend labels; evidence-status chips; event intelligence layer; **holiday/occasion layer** (magnitudes = uncalibrated research priors); narration layer; basic staffing card. |
| **Phase 2 (Tier 2, $199)** | Weather layer live; staffing schedule builder; POS CSV upload → calibration blend (incl. holiday magnitudes); daypart-windowed events/holidays; holiday+event de-duplication. |

**MVP note:** holiday layer is in MVP (not Phase 2) because holidays are a primary
external factor for the start-of-day advisory — the signal would feel broken if it went
silent on Thanksgiving/Valentine's. Magnitudes ship as research priors, calibrate against
POS in Phase 2.
