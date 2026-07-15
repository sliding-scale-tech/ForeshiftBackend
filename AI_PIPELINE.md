# ForeShift AI Pipeline (Phase 2) — Convex

Convex is the **orchestrator**. Bubble sends a natural-language question; Convex
plans the query, pulls demand data from Bubble, layers in (dummy) weather/events,
and returns a narrated answer.

## Flow

```
Bubble ──POST /ai/ask { question, operatorZone?, operatorConcept? }──▶ Convex
   1. AI #1 (Gemini)  guardrail + build structured query   → lib/gemini.ts
   2. Resolve zone/concept: query-extracted wins, else      → lib/orchestrator.ts
      fall back to the operator's own zone/concept
   3. Query Bubble DemandScore (wide) table for rows       → lib/bubble.ts
   4. If demand requested: weather + events (DUMMY)        → lib/providers.ts
      then apply formula (base + lift) × weather           → lib/formula.ts
   5. AI #2 (Gemini)  narrate using ONLY those numbers      → lib/gemini.ts
Bubble ◀── { answer, parsedQuery, appliedOperatorDefaults, signals, usage } ──
```

Entry point: `convex/lib/orchestrator.ts` → `answerQuestion(question, operator?)`.

### Operator fallback (zone / concept)

Bubble resolves the logged-in **operator** (Operator table: `zone`, `concept_type`)
and passes those in as `operatorZone` / `operatorConcept`. Per dimension:

- If the **question names** a zone/concept → that wins.
- Else → use the **operator's own** value.

So "how busy is dinner?" uses the operator's zone *and* concept; "how busy is
Corktown?" uses Corktown (from the question) but the operator's concept. The
response's `appliedOperatorDefaults: { zone, concept }` flags which ones fell back.
Operator values are validated against the vocabulary too, so a mismatched option-set
label can't break the query.

## Files

| File | Role |
|------|------|
| `convex/http.ts` | `POST /ai/ask` — the endpoint Bubble calls |
| `convex/ai.ts` | `ask` action — same pipeline, for dashboard/CLI testing |
| `convex/lib/orchestrator.ts` | Runs the 5 steps |
| `convex/lib/gemini.ts` | Gemini client + AI #1 (parse) and AI #2 (narrate) |
| `convex/lib/bubble.ts` | Bubble Data API client for DemandScore |
| `convex/lib/providers.ts` | **DUMMY** weather + events (swap later) |
| `convex/lib/formula.ts` | **PROVISIONAL** demand formula |
| `convex/lib/vocab.ts` | Canonical zones/concepts/days/dayparts, bands, field map |

## Environment variables

Set with `npx convex env set NAME value`:

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio key |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | model string for both AI calls |
| `BUBBLE_API_BASE` | ✅ | — | e.g. `https://yourapp.bubbleapps.io/api/1.1/obj` (use `.../version-test/...` while building) |
| `BUBBLE_API_TOKEN` | ✅ | — | Bubble API token (Settings → API), sent as `Bearer` |
| `BUBBLE_DEMAND_TABLE` | — | `DemandScore` | Bubble data type name for the wide table |
| `FORESHIFT_SHARED_SECRET` | — | — | if set, callers must send header `x-foreshift-secret` |

> **Bubble field names:** `lib/vocab.ts → WIDE_FIELDS` assumes the wide CSV column
> names (`morning_base_score`, `morning_base_band`, …) plus `zone`, `concept`, `day`.
> If Bubble slugs them differently, fix them there in one place.

## Test it

```bash
# from the dashboard/CLI (after env vars are set + `npx convex dev` running)
npx convex run ai:ask '{"question": "How busy will Fine Dining in Greektown be this weekend?"}'

# operator fallback: no zone/concept in the question -> uses the operator's own
npx convex run ai:ask '{"question":"How busy will this weekend be?","operatorZone":"Midtown","operatorConcept":"Coffee Shop"}'
```

Or via HTTP:

```bash
curl -X POST "$CONVEX_SITE_URL/ai/ask" \
  -H "Content-Type: application/json" \
  -d '{"question":"How busy will this weekend be?","operatorZone":"Midtown","operatorConcept":"Coffee Shop"}'
```

## What's stubbed / provisional (by design)

- **Weather + events** return neutral placeholders (multiplier `1.0`, no events), so
  `final_score` currently equals `base_score` — **no demand is fabricated**. Replace
  the bodies in `lib/providers.ts` with real calls when ready.
- **Formula** in `lib/formula.ts` encodes the spec's "event additive, weather
  multiplicative" rule. Confirm/replace once ForeShift finalizes it.
- **Logging (AIQuery + counter)** is left to Bubble; Convex returns `usage` metadata
  and logs errors to `npx convex logs`.
