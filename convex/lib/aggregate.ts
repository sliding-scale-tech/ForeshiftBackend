// Deterministic demand aggregations — sums, averages, busiest/quietest.
// Computed in code so AI #2 never invents totals. Included in the narration
// context when the question implies totals, averages, or comparisons.

import { type AdjustedCell } from "./formula";

export interface ScoredRecord {
  zone: string;
  concept: string;
  day: string;
  dayparts: {
    daypart: string;
    score: number;
    band: string;
  }[];
}

export interface DayAggregate {
  day: string;
  total: number;
  avg: number;
  cellCount: number;
}

export interface CellHighlight {
  zone: string;
  concept: string;
  day: string;
  daypart: string;
  score: number;
  band: string;
}

export interface DemandAggregation {
  byDay: DayAggregate[];
  combinedTotal: number;
  combinedAvg: number;
  cellCount: number;
  busiest: CellHighlight | null;
  quietest: CellHighlight | null;
}

const AGGREGATION_PATTERN =
  /\b(cumulat|total|combined|overall|aggregate|sum|average|avg|mean|compare|comparison|versus|vs\.?|both|across)\b/i;

/**
 * True ONLY when the operator actually asked for totals/averages/comparison.
 * Spanning multiple days is NOT enough — a plain "how busy this weekend?" wants
 * the per-day picture (see buildDaySummary), not a combined average of every
 * cell (which drags in closed/quiet slots and reads as a misleading number).
 */
export function wantsAggregation(
  question: string,
  intent: string,
  _dayCount: number,
): boolean {
  if (intent === "comparison") return true;
  return AGGREGATION_PATTERN.test(question);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Per-day peak: for each day, the single busiest daypart and its band. This is
// the operator-relevant summary ("when am I busy each day?") — no averages of
// closed/quiet slots. Used for multi-cell answers instead of a global average.
export interface DayPeak {
  day: string;
  daypart: string;
  score: number;
  band: string;
}

export function buildDaySummary(records: ScoredRecord[]): DayPeak[] {
  const byDay = new Map<string, CellHighlight[]>();
  for (const c of flattenCells(records)) {
    const list = byDay.get(c.day) ?? [];
    list.push(c);
    byDay.set(c.day, list);
  }
  const out: DayPeak[] = [];
  for (const [day, cells] of byDay) {
    const peak = pickExtreme(cells, "max");
    if (peak) {
      out.push({ day, daypart: peak.daypart, score: peak.score, band: peak.band });
    }
  }
  return out;
}

function flattenCells(records: ScoredRecord[]): CellHighlight[] {
  const out: CellHighlight[] = [];
  for (const r of records) {
    for (const c of r.dayparts) {
      out.push({
        zone: r.zone,
        concept: r.concept,
        day: r.day,
        daypart: c.daypart,
        score: c.score,
        band: c.band,
      });
    }
  }
  return out;
}

function pickExtreme(
  cells: CellHighlight[],
  pick: "max" | "min",
): CellHighlight | null {
  if (cells.length === 0) return null;
  return cells.reduce((best, c) =>
    pick === "max"
      ? c.score > best.score
        ? c
        : best
      : c.score < best.score
        ? c
        : best,
  );
}

/** Sum/average/busiest across the scored cells passed to narration. */
export function buildAggregation(records: ScoredRecord[]): DemandAggregation {
  const cells = flattenCells(records);
  const byDayMap = new Map<string, number[]>();

  for (const c of cells) {
    const scores = byDayMap.get(c.day) ?? [];
    scores.push(c.score);
    byDayMap.set(c.day, scores);
  }

  const byDay: DayAggregate[] = [...byDayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, scores]) => {
      const total = round1(scores.reduce((s, v) => s + v, 0));
      return {
        day,
        total,
        avg: round1(total / scores.length),
        cellCount: scores.length,
      };
    });

  const combinedTotal = round1(cells.reduce((s, c) => s + c.score, 0));
  const combinedAvg = cells.length
    ? round1(combinedTotal / cells.length)
    : 0;

  return {
    byDay,
    combinedTotal,
    combinedAvg,
    cellCount: cells.length,
    busiest: pickExtreme(cells, "max"),
    quietest: pickExtreme(cells, "min"),
  };
}

/** Map adjusted formula output into the flat scored shape aggregations consume. */
export function scoredFromAdjusted(
  records: {
    zone: string;
    concept: string;
    day: string;
    dayparts: AdjustedCell[];
  }[],
): ScoredRecord[] {
  return records.map((r) => ({
    zone: r.zone,
    concept: r.concept,
    day: r.day,
    dayparts: r.dayparts.map((c) => ({
      daypart: c.daypart,
      score: c.final_score,
      band: c.final_band,
    })),
  }));
}

/** Map base-only cells (no formula) into the scored shape. */
export function scoredFromBase(
  records: {
    zone: string;
    concept: string;
    day: string;
    dayparts: { daypart: string; base_score: number; base_band: string }[];
  }[],
): ScoredRecord[] {
  return records.map((r) => ({
    zone: r.zone,
    concept: r.concept,
    day: r.day,
    dayparts: r.dayparts.map((c) => ({
      daypart: c.daypart,
      score: c.base_score,
      band: c.base_band,
    })),
  }));
}
