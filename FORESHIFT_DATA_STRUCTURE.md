# ForeShift Detroit — Base Demand Data Structure

Reference doc for the two CSVs that will live in Bubble. This describes **exactly**
how the data is shaped so queries can be written against it later.
---

## 1. What this data is

Both files hold the **BASE DEMAND LAYER (v8)** for ForeShift Detroit — a per-zone,
per-concept, per-day, per-daypart demand score for restaurants/bars.

**Critical business rule (from the file header):**

> These are **BASE scores only** — BEFORE the event and weather layers.
> **Final demand = base_score + event lift + weather adjustment**, computed at query time in the app.
> - Event lift is **additive**.
> - Weather is **multiplicative**.
> - `base_score` is the **fixed floor**. Do **NOT** treat it as final demand.

So in Bubble, `base_score` is the starting number you pull from the DB, then the app
applies the event and weather layers on top.

---

## 2. The two files are the SAME data in two shapes

| File | Shape | Data rows | One row = |
|------|-------|-----------|-----------|
| `foreshift_base_demand_long.csv` | **Long / tidy** | 3,276 | one zone × concept × day × **daypart** |
| `foreshift_base_demand_wide.csv` | **Wide / pivoted** | 819 | one zone × concept × **day** (4 dayparts as columns) |

- Long: `13 zones × 9 concepts × 7 days × 4 dayparts = 3,276`
- Wide: `13 zones × 9 concepts × 7 days = 819` (each row has all 4 dayparts inline)

They contain identical information — pick whichever is easier to query.

### Which to use in Bubble
- **Long is almost always the better choice for querying.** Each row is a single
  atomic score, so you filter `zone = X AND concept = Y AND day = Z AND daypart = W`
  and get exactly one `base_score`. Clean, indexable, no column juggling.
- **Wide** is better for display/exports where you want a day's four dayparts on one line.

---

## 3. File preamble (first 8 lines of BOTH files)

Both CSVs start with **8 comment lines beginning with `#`**, then the header row on
line 9. When importing to Bubble, **skip the first 8 lines** (or strip `#` lines).

```
# ForeShift Detroit - BASE DEMAND LAYER (v8)
# IMPORTANT: These are BASE scores only - BEFORE the event and weather layers.
# Final demand shown to an operator = base_score + event lift + weather adjustment, ...
# Event lift (additive) and weather (multiplicative) are applied in-app; ...
# Grain: one row per zone x concept x day x daypart. 13 zones x 9 concepts x 7 days x 4 dayparts = 3,276 rows.
# Bands: Exceptional 110-150, Peak 85-109, High 65-84, Moderate 40-64, Light 20-39, Minimal 0-19.
# Closed dayparts score 0 (Minimal) by design. CONFIDENTIAL - ForeShift LLC.
```

---

## 4. LONG file — `foreshift_base_demand_long.csv`

**Header (line 9):**
```
zone,concept,day,daypart,window,base_score,base_band
```

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `zone` | text | Detroit sub-area (13 values) | `Woodward Core` |
| `concept` | text | Restaurant/bar type (9 values) | `Fine Dining` |
| `day` | text | Day of week, 3-letter (7 values) | `Fri` |
| `daypart` | text | Time block (4 values) | `dinner` |
| `window` | text | Clock hours for that daypart | `16:00-21:00` |
| `base_score` | number (float) | The base demand score, 0.0–~150 | `92.6` |
| `base_band` | text | Categorical band for `base_score` | `Peak` |

**Sample rows:**
```
Woodward Core,Fine Dining,Mon,morning,06:00-11:00,0.0,Minimal
Woodward Core,Fine Dining,Fri,dinner,16:00-21:00,92.6,Peak
```

---

## 5. WIDE file — `foreshift_base_demand_wide.csv`

**Header (line 9):**
```
zone,concept,day,morning_base_score,morning_base_band,midday_base_score,midday_base_band,dinner_base_score,dinner_base_band,late_base_score,late_base_band
```

| Column | Type | Description |
|--------|------|-------------|
| `zone` | text | Same 13 zones |
| `concept` | text | Same 9 concepts |
| `day` | text | Same 7 days |
| `morning_base_score` | number | score for morning (06:00-11:00) |
| `morning_base_band` | text | band for morning |
| `midday_base_score` | number | score for midday (11:00-16:00) |
| `midday_base_band` | text | band for midday |
| `dinner_base_score` | number | score for dinner (16:00-21:00) |
| `dinner_base_band` | text | band for dinner |
| `late_base_score` | number | score for late (21:00-02:00) |
| `late_base_band` | text | band for late |

**Sample row** (one day, all 4 dayparts inline):
```
Woodward Core,Fine Dining,Fri,0.0,Minimal,23.7,Light,92.6,Peak,17.4,Minimal
```
> Note: the wide `window` clock-hours aren't columns here; they're implied by the
> daypart→window mapping in section 6.

---

## 6. The dimension vocabularies (exact allowed values)

Use these exact strings when filtering in Bubble — they are case- and
punctuation-sensitive (e.g. spaces around the `/` in some zones/concepts).

### Zones (13)
```
Core City / Woodbridge
Corktown
Downtown Detroit (Core)
Eastern Market
Financial District
Foxtown / Stadium District
Greektown / Casino District
Mexicantown
Midtown
New Center / North End
Riverfront / RiverWalk
Southwest Detroit
Woodward Core
```

### Concepts (9)
```
Breakfast / Brunch Cafe
Casual Dining
Cocktail Lounge
Coffee Shop
Fast Casual
Fine Dining
Neighborhood / Casual Bar
Sports Bar
Upscale Casual
```

### Days (7)
`Mon, Tue, Wed, Thu, Fri, Sat, Sun`

### Dayparts (4) and their windows
| daypart | window |
|---------|--------|
| `morning` | `06:00-11:00` |
| `midday` | `11:00-16:00` |
| `dinner` | `16:00-21:00` |
| `late` | `21:00-02:00` (crosses midnight) |

---

## 7. Score bands

`base_band` is a categorical label derived from the numeric `base_score`.

| Band | Score range |
|------|-------------|
| Exceptional | 110–150 |
| Peak | 85–109 |
| High | 65–84 |
| Moderate | 40–64 |
| Light | 20–39 |
| Minimal | 0–19 |

**Observed in the base data:** `Minimal, Light, Moderate, High, Peak`.
- `Exceptional` is **defined but never appears** in the base layer (max observed
  `base_score` is `100.4`). Scores can reach the Exceptional band only **after**
  event/weather layers are applied on top.
- **Closed dayparts score `0.0` (Minimal) by design** — e.g. Fast Casual / Coffee /
  Breakfast concepts show `0.0` at `late`; bar/dinner concepts show `0.0` at `morning`.
  A `0.0` means "not operating / no demand," not missing data.

---

## 8. Querying cheat-sheet (for Bubble)

**Single score lookup (LONG file):** filter on all four dimensions → returns 1 row.
```
zone = "Midtown"
concept = "Cocktail Lounge"
day = "Fri"
daypart = "late"
→ base_score = 36.0, base_band = "Light"
```

**Whole-day view (WIDE file):** filter on 3 dimensions → returns 1 row with all 4 dayparts.
```
zone = "Midtown" AND concept = "Cocktail Lounge" AND day = "Fri"
→ morning 0.0 / midday 3.7 / dinner 39.4 / late 36.0
```

**Reminder — final demand is NOT `base_score` alone:**
```
final_demand = base_score + event_lift + weather_adjustment
```
`base_score` from these files is only the floor; the event (additive) and weather
(multiplicative) layers are applied in-app at query time.

### Suggested Bubble field types
- `zone`, `concept`, `day`, `daypart`, `window`, `base_band` → **text** (or Option Sets
  for the fixed vocabularies — recommended for zone/concept/day/daypart/band).
- `base_score` (and all wide `*_base_score`) → **number**.

---

## 9. Quick facts

- **Files:** `foreshift_base_demand_long.csv`, `foreshift_base_demand_wide.csv`
- **Version:** v8
- **Long rows:** 3,276 data rows (+ 8 comment lines + 1 header)
- **Wide rows:** 819 data rows (+ 8 comment lines + 1 header)
- **Score type:** float, one decimal place, range `0.0`–`~150` (base observed max `100.4`)
- **Confidential** — ForeShift LLC.
