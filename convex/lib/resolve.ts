// Shared "resolve one demand cell" logic — computes final_score/band for a
// single zone×concept×day×daypart cell using live EventSignal/WeatherSignal +
// the owner-editable coefficients. This is the ONE place the spec §2 formula is
// applied to real signals, so the AI narration pipeline (orchestrator.ts) and the
// operator week endpoint/cron (operatorWeek.ts) can never drift apart.

import { computeDemand } from "./formula";
import { type EventSignalRead, type WeatherSignalRead } from "./bubble";
import { type Band, type Daypart } from "./vocab";

// The owner-editable coefficients as lookup maps (from coefficients.getAll).
export interface CoefficientBundle {
  eventMagnitude: Record<string, number>; // class -> magnitude
  eventAffinity: Record<string, number>; // concept -> affinity
  weatherAffinity: Record<string, number>; // concept -> affinity
}

export interface ResolvedCell {
  daypart: Daypart;
  window: string;
  base_score: number;
  base_band: string;
  final_score: number;
  final_band: Band;
  event_lift: number;
  weather_factor: number;
  // Named factors so callers (AI narration, operator dashboard) can attribute
  // the specific driver instead of a generic "an event happened".
  events: {
    name: string;
    venue: string;
    class: string;
    proximity: number;
    distance_miles: number;
    time: string | null;
  }[];
  weather: { condition: string; severity: number; temp_f: number } | null;
}

/** Index EventSignal rows by `zone|day|daypart` for O(1) per-cell lookup. */
export function indexEventsByCell(
  events: EventSignalRead[],
): Map<string, EventSignalRead[]> {
  const map = new Map<string, EventSignalRead[]>();
  for (const e of events) {
    const k = `${e.zone}|${e.day}|${e.daypart}`;
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }
  return map;
}

/** Index WeatherSignal rows by `zone|day` for O(1) per-cell lookup. */
export function indexWeatherByZoneDay(
  weather: WeatherSignalRead[],
): Map<string, WeatherSignalRead> {
  const map = new Map<string, WeatherSignalRead>();
  for (const w of weather) map.set(`${w.zone}|${w.day}`, w);
  return map;
}

/**
 * Resolve one zone×concept×day×daypart cell: pull its events + weather from the
 * pre-built indexes, resolve coefficients for the concept, and apply the spec §2
 * formula (computeDemand). Same math as /zone-demand, applied to live signals.
 */
export function resolveCell(args: {
  zone: string;
  concept: string;
  day: string;
  daypart: Daypart;
  window: string;
  base_score: number;
  base_band: string;
  eventsByCell: Map<string, EventSignalRead[]>;
  weatherByZoneDay: Map<string, WeatherSignalRead>;
  coeffs: CoefficientBundle;
}): ResolvedCell {
  const {
    zone,
    concept,
    day,
    daypart,
    window,
    base_score,
    base_band,
    eventsByCell,
    weatherByZoneDay,
    coeffs,
  } = args;

  const event_affinity = coeffs.eventAffinity[concept] ?? 0;
  const weather_affinity = coeffs.weatherAffinity[concept] ?? 0;

  const cellEvents = eventsByCell.get(`${zone}|${day}|${daypart}`) ?? [];
  const weather = weatherByZoneDay.get(`${zone}|${day}`) ?? null;

  const resolvedEvents = cellEvents.map((e) => ({
    magnitude: coeffs.eventMagnitude[e.event_class] ?? 0,
    affinity: event_affinity,
    proximity: e.proximity,
  }));

  const result = computeDemand({
    base_score,
    events: resolvedEvents,
    weather_severity: weather?.severity ?? 0,
    weather_affinity,
  });

  return {
    daypart,
    window,
    base_score,
    base_band,
    final_score: result.final_score,
    final_band: result.band,
    event_lift: Math.round(result.event_lift * 100) / 100,
    weather_factor: Math.round(result.weather_factor * 1000) / 1000,
    events: cellEvents.map((e) => ({
      name: e.name,
      venue: e.venue_name,
      class: e.event_class,
      proximity: e.proximity,
      distance_miles: e.distance_miles,
      time: e.event_time,
    })),
    weather: weather
      ? {
          condition: weather.condition,
          severity: weather.severity,
          temp_f: weather.temp_f,
        }
      : null,
  };
}
