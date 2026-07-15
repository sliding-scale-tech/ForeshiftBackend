// ForeShift AI pipeline orchestrator.
//
// One entry point, answerQuestion(), runs the full flow that Bubble triggers:
//   1. AI #1 (Gemini): guardrail + structured query.
//   2. Resolve zone/concept: query-extracted values win; else fall back to the
//      operator's own zone/concept (Bubble looks these up and passes them in).
//   3. Query Bubble's DemandScore (wide) table for the matching rows.
//   4. If the question needs a demand score: read the REAL EventSignal +
//      WeatherSignal from Bubble and apply the spec §2 formula (computeDemand) —
//      the same math as /zone-demand, so narrated numbers match the API.
//   5. AI #2 (Gemini): narrate using ONLY the retrieved numbers + named factors.
//
// It takes the coefficient bundle as an argument (the caller fetches it from Convex)
// so this stays a plain async function with no direct Convex DB access.

import { guardrailAndParse, narrate, type TokenUsage } from "./gemini";
import { fetchDemandRecords, fetchEventSignals, fetchWeatherSignals, type DemandRecord } from "./bubble";
import {
  indexEventsByCell,
  indexWeatherByZoneDay,
  resolveCell,
  type CoefficientBundle,
} from "./resolve";
import {
  buildAggregation,
  buildDaySummary,
  scoredFromBase,
  wantsAggregation,
  type ScoredRecord,
} from "./aggregate";
import {
  DAYPART_WINDOWS,
  ZONES,
  CONCEPTS,
  keepKnown,
  type Daypart,
} from "./vocab";

// Re-exported so existing callers (ai.ts, http.ts) keep importing it from here.
export type { CoefficientBundle } from "./resolve";

// The operator's own defaults, resolved by Bubble from the Operator table and
// passed in. Used only when the question itself doesn't name a zone/concept.
export interface OperatorContext {
  zone?: string | null;
  concept?: string | null;
}

export interface AnswerResult {
  ok: boolean;
  allowed: boolean;
  refusalReason: string | null;
  answer: string;
  intent: string;
  parsedQuery: {
    zones: string[];
    concepts: string[];
    days: string[];
    dayparts: string[];
    needsDemandScore: boolean;
  };
  // Which dimensions fell back to the operator's own defaults (transparency/logging).
  appliedOperatorDefaults: { zone: boolean; concept: boolean };
  recordCount: number;
  signals: { events: { count: number }; weather: { count: number } } | null;
  usage: { parse: TokenUsage; narrate: TokenUsage | null };
}

// Trim each record to the dayparts the user actually asked about (all, if none).
function focusDayparts(
  record: DemandRecord,
  dayparts: Daypart[],
): DemandRecord["dayparts"] {
  if (dayparts.length === 0) return record.dayparts;
  const wanted = new Set<string>(dayparts);
  return record.dayparts.filter((c) => wanted.has(c.daypart));
}

export async function answerQuestion(
  question: string,
  operator: OperatorContext | undefined,
  coeffs: CoefficientBundle,
): Promise<AnswerResult> {
  // --- Step 1: guardrail + parse -------------------------------------------
  const { parsed, usage: parseUsage } = await guardrailAndParse(question);

  if (!parsed.allowed) {
    return {
      ok: true,
      allowed: false,
      refusalReason: parsed.refusalReason,
      answer:
        parsed.refusalReason ??
        "I can only answer questions about ForeShift demand for Detroit zones and concepts.",
      intent: parsed.intent,
      parsedQuery: {
        zones: parsed.zones,
        concepts: parsed.concepts,
        days: parsed.days,
        dayparts: parsed.dayparts,
        needsDemandScore: parsed.needsDemandScore,
      },
      appliedOperatorDefaults: { zone: false, concept: false },
      recordCount: 0,
      signals: null,
      usage: { parse: parseUsage, narrate: null },
    };
  }

  // --- Step 2: resolve zone/concept ----------------------------------------
  // The operator's own zone/concept are a fallback used ONLY when the question
  // names NEITHER a zone nor a concept. If the question pins one dimension, the
  // other is intentionally left "all":
  //   concept only -> that concept across ALL zones
  //   zone only    -> ALL concepts in that zone
  //   neither      -> the operator's own zone + concept
  //   both         -> exactly what was asked
  const operatorZones = keepKnown([operator?.zone ?? ""], ZONES);
  const operatorConcepts = keepKnown([operator?.concept ?? ""], CONCEPTS);

  const namedNeither =
    parsed.zones.length === 0 && parsed.concepts.length === 0;

  const zones = parsed.zones.length
    ? parsed.zones
    : namedNeither
      ? operatorZones // neither named -> operator's own zone
      : []; // concept named, zone omitted -> all zones
  const concepts = parsed.concepts.length
    ? parsed.concepts
    : namedNeither
      ? operatorConcepts // neither named -> operator's own concept
      : []; // zone named, concept omitted -> all concepts

  const usedOperatorZone = namedNeither && operatorZones.length > 0;
  const usedOperatorConcept = namedNeither && operatorConcepts.length > 0;

  const parsedQuery = {
    zones,
    concepts,
    days: parsed.days,
    dayparts: parsed.dayparts,
    needsDemandScore: parsed.needsDemandScore,
  };
  const appliedOperatorDefaults = {
    zone: usedOperatorZone,
    concept: usedOperatorConcept,
  };

  // Guard: reject ONLY when nothing scopes the query — no zone AND no concept
  // (question named neither and the operator has no defaults). That would fan
  // out to all zones × all concepts, a meaningless city-wide dump. One dimension
  // pinned is fine (all zones for a concept, or all concepts for a zone).
  if (zones.length === 0 && concepts.length === 0) {
    return {
      ok: true,
      allowed: true,
      refusalReason: null,
      answer: `I need at least a zone or a concept to answer that. Name a Detroit zone or concept in your question (e.g. "Fine Dining this weekend" or "Midtown this weekend"), or set a zone and concept on your operator profile.`,
      intent: parsed.intent,
      parsedQuery,
      appliedOperatorDefaults,
      recordCount: 0,
      signals: null,
      usage: { parse: parseUsage, narrate: null },
    };
  }

  // --- Step 3: query Bubble DemandScore ------------------------------------
  const records = await fetchDemandRecords({ zones, concepts, days: parsed.days });

  if (records.length === 0) {
    return {
      ok: true,
      allowed: true,
      refusalReason: null,
      answer:
        "I don't have demand data for that combination. Try naming a Detroit zone and a concept (e.g. \"Fine Dining in Greektown this weekend\").",
      intent: parsed.intent,
      parsedQuery,
      appliedOperatorDefaults,
      recordCount: 0,
      signals: null,
      usage: { parse: parseUsage, narrate: null },
    };
  }

  // --- Step 4: real signals + spec formula (only when demand is requested) --
  let signals: AnswerResult["signals"] = null;
  let contextForNarration: unknown;

  if (parsed.needsDemandScore) {
    const [eventSignals, weatherSignals] = await Promise.all([
      fetchEventSignals({ zones, days: parsed.days }),
      fetchWeatherSignals({ zones, days: parsed.days }),
    ]);

    // Index events by (zone|day|daypart) and weather by (zone|day), then resolve
    // each requested cell through the shared formula helper (resolve.ts) — the
    // same code path the /operator/week endpoint and its cron use.
    const eventsByCell = indexEventsByCell(eventSignals);
    const weatherByZoneDay = indexWeatherByZoneDay(weatherSignals);

    const computedRecords = records.map((r) => {
      const cells = focusDayparts(r, parsed.dayparts).map((c) =>
        resolveCell({
          zone: r.zone,
          concept: r.concept,
          day: r.day,
          daypart: c.daypart,
          window: DAYPART_WINDOWS[c.daypart],
          base_score: c.base_score,
          base_band: c.base_band,
          eventsByCell,
          weatherByZoneDay,
          coeffs,
        }),
      );
      return { zone: r.zone, concept: r.concept, day: r.day, dayparts: cells };
    });

    signals = {
      events: { count: eventSignals.length },
      weather: { count: weatherSignals.length },
    };

    const scored: ScoredRecord[] = computedRecords.map((r) => ({
      zone: r.zone,
      concept: r.concept,
      day: r.day,
      dayparts: r.dayparts.map((c) => ({
        daypart: c.daypart,
        score: c.final_score,
        band: c.final_band,
      })),
    }));
    const includeAggregation = wantsAggregation(
      question,
      parsed.intent,
      computedRecords.length,
    );
    const daySummary = buildDaySummary(scored);
    contextForNarration = {
      note: "final_score = MIN( (base_score + Σ magnitude×affinity×proximity) × (1 − severity×weather_affinity) , 150 ). These are the final numbers — do not recompute. When demand is raised or lowered, name the specific event(s) (use the event name + venue) and/or the weather condition driving it.",
      records: computedRecords,
      // Per-day peak (busiest daypart + band each day) — the operator-relevant
      // summary. Lead with these bands; do NOT average across dayparts.
      daySummary,
      ...(includeAggregation
        ? {
            aggregation: buildAggregation(scored),
            aggregationNote:
              "Operator explicitly asked for totals/comparison — use these exact numbers; do not recalculate.",
          }
        : {}),
    };
  } else {
    // Base-only context: bands/scores as-is, no live signals.
    const baseRecords = records.map((r) => ({
      zone: r.zone,
      concept: r.concept,
      day: r.day,
      dayparts: focusDayparts(r, parsed.dayparts).map((c) => ({
        daypart: c.daypart,
        window: DAYPART_WINDOWS[c.daypart],
        base_score: c.base_score,
        base_band: c.base_band,
      })),
    }));
    const includeAggregation = wantsAggregation(
      question,
      parsed.intent,
      baseRecords.length,
    );
    const scoredBase = scoredFromBase(baseRecords);
    contextForNarration = {
      note: "Base demand only. Event/weather adjustments not requested/applied.",
      records: baseRecords,
      daySummary: buildDaySummary(scoredBase),
      ...(includeAggregation
        ? {
            aggregation: buildAggregation(scoredBase),
            aggregationNote:
              "Operator explicitly asked for totals/comparison — use these exact numbers; do not recalculate.",
          }
        : {}),
    };
  }

  // --- Step 5: narrate ------------------------------------------------------
  const { text, usage: narrateUsage } = await narrate(question, contextForNarration);

  return {
    ok: true,
    allowed: true,
    refusalReason: null,
    answer: text.trim(),
    intent: parsed.intent,
    parsedQuery,
    appliedOperatorDefaults,
    recordCount: records.length,
    signals,
    usage: { parse: parseUsage, narrate: narrateUsage },
  };
}
