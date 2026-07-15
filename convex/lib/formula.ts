// Demand formula.
//
// PROVISIONAL. The spec states: final demand = base_score + event lift (additive)
// then weather (multiplicative). This encodes exactly that until ForeShift hands
// over the finalized formulas. Because the providers are dummies (lift 0,
// multiplier 1.0), final_score currently equals base_score — no demand is invented.

import { scoreToBand, type Band } from "./vocab";
import { type WeatherContext, type EventContext } from "./providers";

// ---------------------------------------------------------------------------
// Spec §2 demand formula (Phase 1, /zone-demand). This is the authoritative,
// pure-math core matching ForeShift_Backend_Service_Spec.md §2:
//
//   final = MIN( (base_score + event_lift) * weather_factor , 150 )   then re-band
//   event_lift     = SUM per event ( magnitude * concept_event_affinity * proximity )
//   weather_factor = 1 - ( weather_severity * concept_weather_affinity )
//
// No floor at 0: the backend spec caps at 150 only. (v7.1 adds MAX(...,0) for its
// SIGNED holiday layer, which this build does not have — events are additive >= 0
// and affinities are 0..1, so the result can't go negative.)
// ---------------------------------------------------------------------------

// One event with its coefficients already resolved (magnitude from eventMagnitude,
// affinity = the concept's event_affinity, proximity from the EventSignal row).
export interface ResolvedEvent {
  magnitude: number;
  affinity: number;
  proximity: number;
}

export interface DemandResult {
  event_lift: number;
  weather_factor: number;
  final_score: number;
  band: Band;
  event_applied: boolean;
}

export function computeDemand(args: {
  base_score: number;
  events: ResolvedEvent[];
  weather_severity: number;
  weather_affinity: number;
}): DemandResult {
  const event_lift = args.events.reduce(
    (sum, e) => sum + e.magnitude * e.affinity * e.proximity,
    0,
  );
  const weather_factor = 1 - args.weather_severity * args.weather_affinity;
  const raw = (args.base_score + event_lift) * weather_factor;
  const capped = Math.min(raw, 150);
  // Round to 2 decimals; +EPSILON so exact halves (e.g. 45.375) round up to 45.38.
  const final_score = Math.round((capped + Number.EPSILON) * 100) / 100;

  return {
    event_lift,
    weather_factor,
    final_score,
    band: scoreToBand(final_score),
    event_applied: event_lift > 0,
  };
}

export interface AdjustedCell {
  daypart: string;
  window: string;
  base_score: number;
  base_band: string;
  final_score: number;
  final_band: Band;
  event_lift_applied: number;
  weather_multiplier_applied: number;
}

/**
 * Apply the provisional formula to a single daypart cell.
 *   final = (base + totalEventLift) * weatherMultiplier   (clamped to >= 0)
 */
export function applyDemandFormula(
  base_score: number,
  base_band: string,
  daypart: string,
  window: string,
  weather: WeatherContext,
  events: EventContext,
): AdjustedCell {
  const totalLift = events.events.reduce((sum, e) => sum + e.lift, 0);
  const raw = (base_score + totalLift) * weather.multiplier;
  const final_score = Math.max(0, Math.round(raw * 10) / 10);

  return {
    daypart,
    window,
    base_score,
    base_band,
    final_score,
    final_band: scoreToBand(final_score),
    event_lift_applied: totalLift,
    weather_multiplier_applied: weather.multiplier,
  };
}
