// Live-signal providers: weather + events.
//
// DUMMY IMPLEMENTATIONS. These return neutral placeholders so the pipeline runs
// end-to-end without fabricating demand. Swap the bodies for real API calls once
// ForeShift provides the weather/events sources and the formulas that map them
// onto the base score. The SHAPES here are the contract the formula consumes.

import { type Zone, type Day } from "./vocab";

export interface WeatherContext {
  provider: string; // "dummy" until a real source is wired in
  summary: string;
  // Multiplicative adjustment applied to demand. 1.0 = no effect.
  multiplier: number;
}

export interface EventContext {
  provider: string;
  events: {
    name: string;
    day: Day | null;
    // Additive lift applied to the base score. 0 = no effect.
    lift: number;
  }[];
}

/**
 * DUMMY weather. Returns a neutral multiplier (1.0) so nothing is invented.
 * Replace with a real forecast lookup for the given zone/days.
 */
export async function getWeather(_args: {
  zone: Zone | null;
  days: Day[];
}): Promise<WeatherContext> {
  return {
    provider: "dummy",
    summary: "Weather integration not yet connected (neutral placeholder).",
    multiplier: 1.0,
  };
}

/**
 * DUMMY events. Returns no events (zero lift) so nothing is invented.
 * Replace with a real nearby-events lookup for the given zone/days.
 */
export async function getEvents(_args: {
  zone: Zone | null;
  days: Day[];
}): Promise<EventContext> {
  return {
    provider: "dummy",
    events: [],
  };
}
