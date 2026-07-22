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
    // This event's own contribution, isolated from the sum: magnitude ×
    // concept_event_affinity × proximity (one term of event_lift's SUM, not
    // combined with any other event in this cell). lift_percent is that
    // against base_score (this daypart's baseline before any event/weather),
    // so multiple events' percentages sum to the daypart's total % lift, and
    // it reads as "extra demand over a normal day" — null when base_score is
    // 0 (nothing to take a percentage of; lift_score alone still tells the
    // story: new activity where there normally wouldn't be any).
    lift_score: number;
    lift_percent: number | null;
  }[];
  weather: {
    condition: string;
    severity: number;
    temp_f: number;
    // Weather's own contribution, isolated the same way event lift_score/
    // lift_percent are: how much this daypart's number changed BECAUSE of
    // weather, vs (base_score + event_lift). Weather multiplies that whole
    // pre-weather subtotal (not just base_score), so this is measured
    // against the same subtotal — that's the only way the two stay
    // consistent with each other (weather_impact_score = subtotal ×
    // weather_impact_percent / 100) and with what the formula actually does.
    // Negative = weather is dampening demand, positive = an ideal-day boost.
    weather_impact_score: number;
    weather_impact_percent: number;
  } | null;
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

/** Index WeatherSignal rows by `zone|day` for O(1) per-cell lookup. Still one
 * row per zone/day (wide format — see bubble.ts) even though weather is now
 * daypart-aware; the daypart-specific slice is picked off that one row by
 * pickDaypartWeather below. */
export function indexWeatherByZoneDay(
  weather: WeatherSignalRead[],
): Map<string, WeatherSignalRead> {
  const map = new Map<string, WeatherSignalRead>();
  for (const w of weather) map.set(`${w.zone}|${w.day}`, w);
  return map;
}

/** Pick one daypart's severity/condition/temp off a WeatherSignal row — each
 * daypart can genuinely differ now (rain moving in by dinner, clear at
 * lunch), unlike the old single day-wide value. */
function pickDaypartWeather(
  row: WeatherSignalRead,
  daypart: Daypart,
): { condition: string; severity: number; temp_f: number } {
  const dw = row[daypart];
  return { condition: dw.condition, severity: dw.severity, temp_f: dw.temp_f };
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
  const weatherRow = weatherByZoneDay.get(`${zone}|${day}`) ?? null;
  const weather = weatherRow ? pickDaypartWeather(weatherRow, daypart) : null;

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

  // (base_score + event_lift) is exactly what weather_factor multiplies in
  // the formula — using that same subtotal here (not base_score alone) is
  // what keeps weather_impact_score honest when an event also happened that
  // day (weather dampens/lifts the event's contribution too, not just the
  // baseline).
  const preWeatherSubtotal = base_score + result.event_lift;
  const weatherImpactPercent = (result.weather_factor - 1) * 100;
  const weatherImpactScore = preWeatherSubtotal * (result.weather_factor - 1);

  return {
    daypart,
    window,
    base_score,
    base_band,
    final_score: result.final_score,
    final_band: result.band,
    event_lift: Math.round(result.event_lift * 100) / 100,
    weather_factor: Math.round(result.weather_factor * 1000) / 1000,
    events: cellEvents.map((e) => {
      const magnitude = coeffs.eventMagnitude[e.event_class] ?? 0;
      const lift = magnitude * event_affinity * e.proximity;
      return {
        name: e.name,
        venue: e.venue_name,
        class: e.event_class,
        proximity: e.proximity,
        distance_miles: e.distance_miles,
        time: e.event_time,
        lift_score: Math.round(lift * 100) / 100,
        lift_percent:
          base_score > 0 ? Math.round((lift / base_score) * 1000) / 10 : null,
      };
    }),
    weather: weather
      ? {
          ...weather,
          weather_impact_score: Math.round(weatherImpactScore * 100) / 100,
          weather_impact_percent: Math.round(weatherImpactPercent * 10) / 10,
        }
      : null,
  };
}
