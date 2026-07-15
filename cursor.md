# ForeShift Backend — Cursor Reference

**Read this before any backend work.** Sources: `ForeShift_Backend_Service_Spec.pdf`, `FORESHIFT_DATA_STRUCTURE.md`, current Convex codebase.

Confidential — ForeShift LLC — under NDA.

---

## Architecture (current + target)

| Layer | Role |
|-------|------|
| **Bubble** | UI, operator identity, data store (`DemandScore`, `EventSignal`, `WeatherSignal`, `ZoneGeo`) |
| **Convex** | Standalone orchestrator — REST API, demand math, AI narration, weekly sync cron |
| **Gemini** | Parse questions + narrate (Phase 2 `/ai/ask` only) |

**Two hard requirements (spec §5):**
1. **Standalone REST API** — JSON in/out, callable via curl; not coupled to Bubble internals.
2. **Owner-editable coefficients** — event affinity, event magnitude, weather affinity editable without code deploy.

**Terminology:** Always **zone demand** (demand for a concept in a zone). Never "restaurant demand" in fields, logs, or responses.

---

## Demand formula (spec §2 — source of truth)

```
final = MIN( (base_score + event_lift) * weather_factor , 150 )

event_lift     = SUM per event: event_magnitude × concept_event_affinity × proximity
weather_factor = 1 - (weather_severity × concept_weather_affinity)
```

**Rules (do not change):**
- Events are **additive** (outside crowds on top of baseline).
- Weather is **multiplicative** (scales existing demand up/down).
- Multiple events → **sum** individual lifts before adding to base.
- Cap final at **150**, then **re-band**.

**Worked example (must pass with dummy coefficients):**
- `base_score=30.0`, one event class `"Major stadium game"` (`magnitude=50`), `proximity=1.0`, `concept_event_affinity=0.50`
- `event_lift = 50 × 0.50 × 1.0 = 25` → after event `55.0`
- `weather_severity=0.5`, `concept_weather_affinity=0.35` → `weather_factor = 1 - (0.5 × 0.35) = 0.825`
- `55.0 × 0.825 = 45.375` → round → **`45.38`**, band **`Moderate`**


## AI narration API (Phase 2 — implemented)

```
POST /ai/ask
```

**Request:** `{ question, operatorZone?, operatorConcept? }`  
**Response:** `{ answer, parsedQuery, recordCount, signals, usage, ... }`

Entry: `convex/http.ts` → `convex/lib/orchestrator.ts` → `answerQuestion()`.

---

## Reference data tables

### 4.1 Base zone-demand scores (ForeShift-provided)
- **3,276 rows** (long) or **819 rows** (wide) in Bubble `DemandScore`
- Grain: `zone × concept × day × daypart`
- `base_score` is **fixed floor** — NOT final demand
- Source files: `foreshift_base_demand_long.csv`, `foreshift_base_demand_wide.csv` (v8)
- Skip first 8 `#` comment lines on import

### 4.2 Event affinity by concept (DUMMY 0.50 all — owner loads real)
| Concept | Dummy affinity |
|---------|----------------|
| All 9 concepts | 0.50 |

### 4.3 Event magnitude by class (DUMMY — owner loads real)
| Event class | Magnitude |
|-------------|-----------|
| Major stadium game | 50 |
| Concert / large show | 30 |
| Festival day | 20 |
| Minor event | 10 |

### 4.4 Weather affinity by concept (DUMMY 0.35 all — owner loads real)

### 4.5 Band thresholds
| Band | Range |
|------|-------|
| Exceptional | 110–150 |
| Peak | 85–109 |
| High | 65–84 |
| Moderate | 40–64 |
| Light | 20–39 |
| Minimal | 0–19 |

Exceptional never appears in **base** data (max observed `100.4`). Only reachable after event/weather layers.

---

## Vocabularies (exact strings — joins break on mismatch)

### Zones (13)
```
Core City / Woodbridge, Corktown, Downtown Detroit (Core), Eastern Market,
Financial District, Foxtown / Stadium District, Greektown / Casino District,
Mexicantown, Midtown, New Center / North End, Riverfront / RiverWalk,
Southwest Detroit, Woodward Core
```

### Concepts (9)
```
Breakfast / Brunch Cafe, Casual Dining, Cocktail Lounge, Coffee Shop,
Fast Casual, Fine Dining, Neighborhood / Casual Bar, Sports Bar, Upscale Casual
```

### Days (7)
`Mon, Tue, Wed, Thu, Fri, Sat, Sun`

### Dayparts (4)
| key | window |
|-----|--------|
| morning | 06:00–11:00 |
| midday | 11:00–16:00 |
| dinner | 16:00–21:00 |
| late | 21:00–02:00 |

Canonical source in code: `convex/lib/vocab.ts`. Bubble option sets must match exactly.

---

## Bubble data types

| Table | Grain | Purpose |
|-------|-------|---------|
| `DemandScore` | zone × concept × day (wide: 4 dayparts as columns) | Base demand |
| `ZoneGeo` | 1 row per zone | lat/lng for Ticketmaster + WeatherAPI |
| `EventSignal` | 1 row per event per zone per week | Weekly Ticketmaster upsert |
| `WeatherSignal` | 1 row per zone × forecast day | Weekly WeatherAPI upsert |

**Wide DemandScore fields:** `zone`, `concept`, `day`, `morning_base_score`, `morning_base_band`, `midday_base_score`, `midday_base_band`, `dinner_base_score`, `dinner_base_band`, `late_base_score`, `late_base_band`

Field map in code: `convex/lib/vocab.ts` → `WIDE_FIELDS`.

---

## Convex file map

| File | Role |
|------|------|
| `convex/http.ts` | `POST /ai/ask` HTTP entry |
| `convex/lib/orchestrator.ts` | Pipeline orchestration |
| `convex/lib/gemini.ts` | AI #1 parse + AI #2 narrate |
| `convex/lib/bubble.ts` | Bubble Data API client |
| `convex/lib/vocab.ts` | Canonical vocab + field maps |
| `convex/lib/formula.ts` | Demand formula — **align to spec §2** |
| `convex/lib/providers.ts` | Weather/events — read Bubble signals |
| `convex/lib/aggregate.ts` | Deterministic totals before narration |

---

## Env vars (Convex)

| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` | Gemini AI |
| `BUBBLE_API_BASE` | Bubble Data API base URL |
| `BUBBLE_API_TOKEN` | Bubble API token |
| `BUBBLE_DEMAND_TABLE` | Default `DemandScore` |
| `FORESHIFT_SHARED_SECRET` | Optional auth on `/ai/ask` |
| `TICKETMASTER_API_KEY` | Weekly event sync (planned) |
| `WEATHERAPI_KEY` | Weekly weather sync (planned) |

---

## Implementation gaps to close

- [ ] `formula.ts` must match spec §2 exactly (affinity × magnitude × proximity; weather_factor formula; cap 150)
- [ ] Coefficients in editable store (Convex DB or Bubble admin table), not hardcoded
- [ ] `POST /zone-demand` endpoint per spec §3
- [ ] Weekly cron: Ticketmaster + WeatherAPI → upsert `EventSignal` / `WeatherSignal`
- [ ] `providers.ts` reads from Bubble signal tables, not dummy
- [ ] Pass spec §2 worked example as unit test

---

## Dev checklist (spec §8)

- [ ] Standalone REST API, JSON, curl-testable
- [ ] Formula §2: additive events, multiplicative weather, cap 150, re-band
- [ ] Worked example → 45.38 / Moderate with dummy coefficients
- [ ] Base scores from ForeShift data file
- [ ] Owner-editable coefficients (no redeploy)
- [ ] "Zone demand" terminology throughout
- [ ] Optional request logging for recalibration
