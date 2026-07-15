# ForeShift Web Application — Bubble Development Specification (Model v8)

> **Reference only — not used every time.** This is the doc that came **after**
> [`ForeShift_Dev_Spec_v72.md`](./ForeShift_Dev_Spec_v72.md). It re-scopes the product
> for a **Bubble.io** build with **placeholder data** and an **IP gate**. Our
> authoritative backend build spec is still `ForeShift_Backend_Service_Spec.pdf`
> (captured in `CLAUDE.md`); refer to this file for product shape, screens, phasing,
> access control, and the exact **13-zone / 9-concept** reference data.
>fore
> Source: `ForeShift_Bubble_Build_Spec (3).pdf` · Detroit MVP · Model **v8** ·
> **13 Zones × 9 Concepts**. For: Sliding Scale Technologies (Bubble dev). Platform:
> Bubble.io (`app.foreshift.ai`) + Webflow marketing (`foreshift.ai`). CONFIDENTIAL.

## Why this doc matters for us (the big shift vs v7.1)

| Topic | v7.1 (`_Dev_Spec_v72.md`) | **This doc (Bubble v8)** | Our backend spec / CLAUDE.md |
|---|---|---|---|
| Zones / concepts | 10 / 8 | **13 / 9** ✅ | **13 / 9** ✅ |
| Demand score | app **computes** it (runtime formula) | app **NEVER computes** — displays stored `DemandRecord.band` | service computes `/zone-demand` |
| Demand data | derived from curves × seasonal × daypart | **pre-computed placeholder CSV** `zone,concept,day,daypart,score,band` (3,276 rows) | same 3,276-row base file |
| Events/weather | numeric demand adjustment in-app | **Phase 2, AI-context only — NO demand math in app** | caller supplies events → `/zone-demand` math |
| Event relevance | zone proximity tiers | **proximity = distance from event venue → zone** (explicitly *"not zone membership"*) | proximity to zone |
| Zone assignment | — | **geocode operator address → point-in-polygon → zone** | n/a (zone supplied) |
| AI | §5.5 narration | **AI Access Pass (Phase 2)**, Anthropic Messages API, narrates only | Phase 2 `/ai/ask` |
| IP posture | trade-secret coefficients | **real demand values withheld pending patent; build on placeholders** | owner loads real coefficients later |

**Crux:** In this Bubble build the app is a *store/display/narrate* shell — all
proprietary scoring is **out of scope** and lives ForeShift-side. That's the opposite
of our Convex backend spec, where the service *does* the math. Use this doc for the
**product/UX/data-model/phasing** picture, not the scoring approach.

---

## 1. Overview & Architecture

ForeShift gives restaurant operators a demand forecast for their location — how busy
demand is likely to be, by day and daypart, for their concept in their Detroit zone. The
operator signs up, is placed into a zone, buys a demand report, optionally subscribes to
an AI intelligence pass, and logs how busy they actually were.

**1.1 System pieces**

| Piece | Platform | Role |
|---|---|---|
| Application | Bubble.io (`app.foreshift.ai`) | Accounts,onboarding, demand report, subscriptions, operator dashboard, feedback, AI pass |
| Marketing site | Webflow (`foreshift.ai`) | Public marketing, lead capture (separate; not this spec) |
| Demand data | Loaded into Bubble DB | Zone × concept × day × daypart demand records (placeholder now, real later) |
| Zone geometry | External geocode + point-in-polygon | Assigns an operator's address to a zone at onboarding |
| AI (Phase 2) | **Anthropic API** via Bubble API Connector | Narrates demand in natural language, server-side |
| Events / weather (Phase 2) | Ticketmaster + weather API | Live signals pulled at query time to inform AI answers |
| Payments | Stripe (Bubble plugin) | Report purchase + AI pass subscription |

**1.2 Core data-flow principle (important for the AI):** *The model produces the demand
number; the app displays it; the AI narrates it.* The base demand score is a **fixed
value retrieved from the DB** (computed offline by ForeShift). **The app never computes a
demand score.** In Phase 2 the AI receives the retrieved score plus live event/weather
signals and writes an explanation — it **narrates**, never **generates** demand figures.

## 2. Phase Plan & Build Order

Build **Phase 1 first — it is a complete, sellable product on its own.** Phase 2 adds AI
+ live data and may be built in parallel, but Phase 1 must not depend on Phase 2.

| Capability | Phase | Notes |
|---|---|---|
| Accounts & auth | 1 | Bubble native user accounts |
| Onboarding + zone auto-assignment | 1 | Geocode → point-in-polygon → zone; concept suggest; confirm/adjust |
| Location Demand Report (static) | 1 | Bands by day/daypart; placeholder values |
| Subscription / paywall (report purchase) | 1 | Stripe; per-zone report product line |
| Operator feedback capture | 1 | Busy-ness tap; store + export actuals |
| AI access pass (Claude narration) | 2 | Anthropic API via API Connector; monthly tiers; query caps |
| Live events layer (Ticketmaster) | 2 | Pulled at query time; feeds AI |
| Live weather layer | 2 | Pulled at query time; feeds AI |
| Interactive operator dashboard | 2 | Beyond the static report |
| Per-venue calibration engine | **OUT** | ForeShift-side, IP-gated — see §11 |

## 3. Data Model (Bubble Data Types)

Field names are suggestions; types in parentheses are Bubble field types.

- **Zone** — `name (text)` · `market_index (number)` · `character_description (text)` ·
  `boundary_geojson (text — polygon, for reference/display)` · `display_label (text)` ·
  `slug (text)`. 13 records (Appendix A). Static reference data.
- **Concept** — `name (text)` · `description (text)` · `operating_profile (text — e.g.
  "Midday + Dinner + Late Night")` · `slug (text)`. 9 records. Static reference data.
- **DemandRecord** — `zone (Zone)` · `concept (Concept)` · `day (text: Mon–Sun)` ·
  `daypart (text: morning/midday/dinner/late)` · `score (number — 0–150, PLACEHOLDER)` ·
  `band (text: Minimal/Light/Moderate/High/Peak/Exceptional)`. **Core demand table:
  13 × 9 × 7 × 4 = 3,276 records.** Structure mirrors `model_bands.csv`. Values are
  placeholder until the IP gate clears — *the schema is what matters now.*
- **Venue** — `name (text)` · `address (text)` · `latitude (number)` ·
  `longitude (number)` · `zone (Zone)` · `concept (Concept)` · `category_raw (text)` ·
  `is_operator_venue (yes/no)`. Reference venue universe (**~1,038 in-scope**) +
  operator-created venues at onboarding.
- **Operator (extends Bubble User)** — `venue (Venue)` · `zone (Zone)` ·
  `concept (Concept)` · `onboarding_complete (yes/no)` · `subscription_status (text)` ·
  `ai_pass_tier (text: none/single_zone/full_detroit)` · `report_access (list of Zone)`.
- **FeedbackEntry** — `operator (Operator)` · `venue (Venue)` · `date (date)` ·
  `daypart (text)` · `busyness (text: Dead/Slow/Steady/Busy/Slammed)` ·
  `actual_covers (number, optional)` · `predicted_band (text — snapshot at entry)` ·
  `created_date (date)`. App stores & exports; does **NOT** recalibrate the model (§11).
- **Subscription** — `operator (Operator)` · `product (text: report / ai_pass)` ·
  `zone_scope (text)` · `stripe_subscription_id (text)` · `status (text)` ·
  `current_period_end (date)` · `query_count_period (number)`.
- **AIQuery (Phase 2)** — `operator (Operator)` · `question (text)` · `zone (Zone)` ·
  `concept (Concept)` · `base_score_used (number)` · `events_context (text)` ·
  `weather_context (text)` · `ai_response (text)` · `created_date (date)`. Logs AI
  interactions; also enforces query caps.

## 4. Data Loading & the Placeholder Dataset

ForeShift provides a CSV with the **correct structure** (`zone, concept, day, daypart,
score, band`) but **placeholder score/band values**. Load into `DemandRecord` via
Bubble's CSV import (or Data API). Build every screen/query against it. When the IP gate
clears, ForeShift supplies the real CSV and it **replaces the placeholder rows — no
schema change.**

- **Zones & Concepts** — 13 zone + 9 concept reference records (Appendix A); names are
  final and not proprietary.
- **DemandRecord** — 3,276 rows, placeholder values, real structure.
- **Venue universe** — ForeShift provides the in-scope venue list (name, address,
  lat/lng, zone, concept) for onboarding lookups + zone density. Reference data, not
  proprietary scoring.
- **Zone boundaries** — ForeShift provides **GeoJSON polygons for the 13 zones** (used by
  point-in-polygon in §5).

**Naming consistency requirement.** Zone names must match **exactly** across every data
type and import (e.g. "Woodward Core", "Foxtown / Stadium District", "Downtown Detroit
(Core)"). A mismatch silently breaks joins between Venue, DemandRecord, and Zone. Use the
exact strings in Appendix A.

## 5. Onboarding & Zone Auto-Assignment (Phase 1)

Places a new operator into the correct zone from their address, with confirm/adjust
fallback. Must be smooth — it's the entry point.

**5.1 Flow:** (1) Account creation (Bubble native). (2) Venue entry — name + street
address. (3) **Geocode** the address → lat/lng (Google Maps Geocoding API via API
Connector, or Bubble's native geographic address field). (4) **Zone assignment
(point-in-polygon)** — determine which of the 13 zone polygons contains the venue's
coordinates; set Operator's zone. (5) **Concept suggestion** — if a matching Venue exists
in the reference universe, use its concept; else present the 9 concepts. (6)
**Confirm/adjust** — show assigned zone (on a map) + suggested concept; let the operator
confirm or change; store final zone + concept on Operator and Venue.

**5.2 Point-in-polygon options:**

| Option | How | Trade-off |
|---|---|---|
| **Server-side plugin / API** | A geo library (e.g. Turf.js endpoint/plugin) tests the point against the 13 polygons | Most reliable; **recommended** |
| Bubble geographic + radius fallback | Nearest-zone-centroid if polygon test unavailable | Approximate; fallback only |
| Precomputed lookup | ForeShift pre-assigns known venues; new addresses use the geo test | Fast for known venues |

ForeShift supplies the 13 zone polygons as GeoJSON. Address outside all 13 zones (out of
the central-Detroit MVP area) → show a "not yet covered" state + capture the lead.

> **Why beyond onboarding:** the same zone geometry is the assignment engine. Exact name
> strings (Appendix A) so the assigned zone joins cleanly to DemandRecords.

## 6. The Location Demand Report (Phase 1 core)

The core Phase-1 product an operator buys — a demand report for their zone × concept,
titled by neighborhood (e.g. "Corktown Demand Report").

**6.1 Shows:** header (neighborhood-titled name, zone character description, concept);
**weekly demand pattern** — the demand **band** for each day × daypart (Mon–Sun ×
morning/midday/dinner/late), from DemandRecord; band label (Minimal → Exceptional) with
a color scale in a days × dayparts grid; daypart breakdown (Morning 6–11, Midday 11–16,
Dinner 16–21, Late 21–02); a read guide legend (ForeShift supplies band definitions).

**6.2 Retrieved:** query `DemandRecord where zone = operator's zone AND concept =
operator's concept` → 28 records (7 × 4). Group by day for the grid. **No computation in
the app — display the stored band.** Placeholder values until the real dataset loads.

> **UI-copy honesty:** the report is *zone-level demand intelligence for the operator's
> concept* — a research-grounded baseline. Say it reflects **expected demand patterns for
> the area and concept**, refined over time. Do **not** imply it's a measured prediction
> of that specific venue's exact sales.

## 7. Subscriptions, Paywall & Access Control

**7.1 Products** (prices indicative — confirm with ForeShift):

| Product | Type | Price | Grants |
|---|---|---|---|
| Location Demand Report | Per-zone (one-time or recurring) | ~$199/zone; ~$799 Detroit bundle | Access to that zone's static report |
| AI Access Pass — single zone | Monthly, cancel anytime | ~$49/mo | AI queries for one zone (Phase 2) |
| AI Access Pass — full Detroit | Monthly, cancel anytime | ~$99/mo | AI queries for all zones (Phase 2) |

The AI pass is **decoupled** from the static report — buy either independently.

**7.2 Implementation:** Stripe via Bubble plugin (one-time report charge; subscription
for AI pass). **Access control** — on Operator, maintain `report_access` (list of Zones)
+ `ai_pass_tier`; gate report pages and AI features on these; use Bubble privacy rules so
unpurchased data isn't exposed client-side. **Query caps** — for the AI pass, track
`query_count_period` on Subscription; enforce a per-billing-period cap (value from
ForeShift); reset on `current_period_end`.

## 8. Operator Feedback Capture (Phase 1)

Operators log how busy they actually were → builds ForeShift's calibration dataset. **The
app collects and exports; it does NOT recalibrate the model (§11).**

**8.1 Capture UI:** a quick **busy-ness tap** — five levels (Dead · Slow · Steady · Busy ·
Slammed) selectable per daypart for a date; optional **actual covers** numeric entry; at
entry time snapshot the **predicted band** onto the FeedbackEntry (so the comparison
survives even if the model later changes).

**8.2 What the app does:** store each FeedbackEntry; optionally display a simple variance
view ("you reported Busy; forecast was High") for engagement only — descriptive, not a
model change; **export** (CSV/Data API) FeedbackEntries for ForeShift's offline
calibration. **Do not build recalibration logic in the app.**

## 9. The AI Access Pass (Phase 2)

Lets an operator ask natural-language questions and get demand-aware answers. The AI
**narrates** the model's stored demand plus live signals; it does not invent demand
numbers.

**9.1 Architecture:** (1) operator asks a question; (2) Bubble backend workflow retrieves
the relevant DemandRecord(s) (base bands for zone/concept/days); (3) Bubble pulls live
context — nearby events (§10) + weather (§10); (4) Bubble calls the **Anthropic Messages
API** via API Connector (server-side), passing the retrieved demand bands, event context,
weather context, and the question; (5) system prompt instructs the model to **explain the
demand using the provided numbers/context and explicitly NOT to fabricate demand
values** — returns natural-language text; (6) display response, log an AIQuery, increment
the query counter.

**9.2 API Connector setup:** endpoint = Anthropic Messages API, **server-side call** (key
in Bubble backend, never client-side); model = a cost-appropriate Claude model (ForeShift
specifies; Haiku-class noted as margin-favorable — confirm current model string at build
time); pass conversation + retrieved demand/context as structured input; keep
`max_tokens` bounded for cost; base demand figures come **only** from DemandRecord — the
model must not be asked to compute them.

> **System-prompt principle (ForeShift to finalize):** *"You are given ForeShift's demand
> bands for this location and concept, plus live event and weather context. Explain what
> the operator can expect and why, using only the provided demand values and context. Do
> not invent or alter demand numbers."*

## 10. Live External Layers — Events & Weather (Phase 2)

**10.1 Events:** source = **Ticketmaster API** (or equivalent) for Detroit venue events
(stadiums, arenas, theaters). **Pulled at query time** for the relevant dates + the
operator's zone vicinity. Used as **context for the AI** (and later as input to
ForeShift's event layer) — *the app does not compute an event-adjusted demand score (that
logic is ForeShift-side).* **Event relevance is by proximity (distance from the event
venue to the zone), not zone membership.**

**10.2 Weather:** source = a weather API (forecast for relevant dates, Detroit); pulled at
query time; passed to the AI as context.

> **Note on scoring:** in this build, events + weather inform the AI's **narrative only**.
> Numeric adjustment of demand scores by events/weather is **ForeShift-side and deferred**
> until real operator outcome data exists to calibrate it. **Do not implement demand-score
> math for events/weather in the app.**

## 11. Out of Scope (ForeShift-side / IP-gated) — **do not build**

| Item | Why out of scope |
|---|---|
| Demand scoring formulas (four-lever model, daypart overlap, Market Index derivation) | Core proprietary IP; app displays stored scores, never computes them |
| Per-venue calibration engine (capture rate, per-venue curve, coupling) | Proprietary IP; runs offline at ForeShift; app only *collects* actuals |
| Recalibration / model-updating from feedback | ForeShift-side; app exports FeedbackEntries, doesn't adjust the model |
| Event/weather numeric demand adjustment | ForeShift-side; deferred pending calibration; app passes events/weather to AI as context only |
| The real demand values | Withheld pending patent filing; build against placeholder data |

## 12. Non-Functional Requirements

- **Data privacy** — Bubble privacy rules must prevent client-side exposure of demand
  data the operator hasn't purchased, and of other operators' feedback.
- **API keys server-side** — Anthropic, Ticketmaster, weather, geocoding keys live in
  Bubble backend; never exposed to the browser.
- **Caching of live data** — cache events/weather results server-side per zone/date to
  avoid repeated external calls and control cost/latency. *Do not call live APIs on every
  page load.*
- **Cost control** — enforce AI query caps; bound `max_tokens`; log AIQuery for monitoring.
- **Responsive** — mobile + desktop.
- **Placeholder-to-real swap** — real demand dataset loadable without schema changes
  (same columns as placeholder CSV).

## Appendix A — Reference Data

### A.1 The 13 Zones (exact names — use verbatim) + Market Index

| Zone (exact string) | Market Index |
|---|---|
| Woodward Core | 100 |
| Foxtown / Stadium District | 95 |
| Downtown Detroit (Core) | 93 |
| Greektown / Casino District | 92 |
| Financial District | 87 |
| Midtown | 83 |
| Corktown | 79 |
| Eastern Market | 72 |
| New Center / North End | 65 |
| Riverfront / RiverWalk | 61 |
| Mexicantown | 59 |
| Core City / Woodbridge | 58 |
| Southwest Detroit | 56 |

*Market Index is a zone intensity label (reference, not proprietary scoring). The demand
scores that depend on it are the withheld part.*

### A.2 The 9 Concepts (exact names — use verbatim) + Operating Profile

| Concept | Operating profile |
|---|---|
| Fine Dining | Dinner + Late Night |
| Upscale Casual | Midday + Dinner |
| Casual Dining | Morning + Midday + Dinner |
| Fast Casual | Morning + Midday + Dinner |
| Coffee Shop | Morning + Midday + Dinner |
| Breakfast / Brunch Cafe | Morning + Midday |
| Sports Bar | Midday + Dinner + Late Night |
| Cocktail Lounge | Dinner + Late Night |
| Neighborhood / Casual Bar | Midday + Dinner + Late Night |

### A.3 Dayparts

| Daypart | Window |
|---|---|
| Morning | 6:00 AM – 11:00 AM |
| Midday | 11:00 AM – 4:00 PM |
| Dinner | 4:00 PM – 9:00 PM |
| Late Night | 9:00 PM – 2:00 AM |

### A.4 The six demand bands

| Band | Score range (0–150) |
|---|---|
| Exceptional | 110–150 |
| Peak | 85–109 |
| High | 65–84 |
| Moderate | 40–64 |
| Light | 20–39 |
| Minimal | 0–19 |

### A.5 Screen inventory

| Screen | Phase | Purpose |
|---|---|---|
| Sign up / Log in | 1 | Auth |
| Onboarding wizard | 1 | Venue entry → zone → concept → confirm |
| Demand Report | 1 | Days × dayparts band grid |
| Purchase / checkout | 1 | Stripe report purchase |
| Feedback capture | 1 | Busy-ness tap + covers |
| Account / subscription | 1 | Manage plan, access |
| AI chat / query | 2 | Ask questions; see narration |
| AI pass upgrade / checkout | 2 | Subscribe to AI tier |
| Interactive dashboard | 2 | Richer demand + live signals |

**Build summary (one line):** Phase 1 delivers a complete self-serve product — operators
sign up, are auto-assigned to a Detroit zone, buy a neighborhood Demand Report (built on
placeholder data with the real schema), and log how busy they were. Phase 2 adds the AI
Access Pass that narrates demand with live event + weather context. The proprietary
scoring and calibration never enter the app; it stores, displays, and narrates values
ForeShift supplies.
