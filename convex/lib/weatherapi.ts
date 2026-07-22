// WeatherAPI.com forecast client (raw fetch + normalize).
//
// Scope: fetch the daily forecast for one location (Detroit) over N days and reduce
// each day to the fields the severity rule needs. No severity math here (that's
// weatherSeverity.ts), no storage.
//
// Docs basis: v8 §10.2 "forecast for relevant dates, Detroit"; v7.1 §4 weekly weather.

import { type Daypart } from "./vocab";

const FORECAST_URL = "https://api.weatherapi.com/v1/forecast.json";
const HISTORY_URL = "https://api.weatherapi.com/v1/history.json";

/** One hour of forecast/history, reduced to what severity slicing needs. */
export interface HourlyPoint {
  hour: number; // 0-23, local hour of day
  conditionText: string;
  tempF: number;
  chanceOfRain: number; // 0..100
  chanceOfSnow: number; // 0..100
}

/** One day of forecast, reduced to what the severity rule reads. */
export interface DailyForecast {
  date: string; // "YYYY-MM-DD"
  conditionText: string; // e.g. "Sunny", "Patchy rain nearby", "Thundery outbreaks"
  maxTempF: number;
  minTempF: number;
  avgTempF: number;
  chanceOfRain: number; // 0..100
  chanceOfSnow: number; // 0..100
  totalPrecipIn: number;
  hours: HourlyPoint[]; // this date's 24 hourly points, for daypart slicing
}

// --- Minimal shapes for the parts of the WeatherAPI response we read ---
interface WaDay {
  maxtemp_f?: number;
  mintemp_f?: number;
  avgtemp_f?: number;
  daily_chance_of_rain?: number;
  daily_chance_of_snow?: number;
  totalprecip_in?: number;
  condition?: { text?: string };
}
interface WaHour {
  time?: string; // "YYYY-MM-DD HH:MM"
  temp_f?: number;
  chance_of_rain?: number;
  chance_of_snow?: number;
  condition?: { text?: string };
}
interface WaForecastDay {
  date?: string;
  day?: WaDay;
  hour?: WaHour[];
}
interface WaResponse {
  forecast?: { forecastday?: WaForecastDay[] };
  error?: { message?: string };
}

/**
 * Fetch the daily forecast for `query` (city name or "lat,lng") over `days` days.
 * Throws on a non-OK response so the caller can surface a clear error.
 */
export async function fetchWeatherForecast(args: {
  apiKey: string;
  query: string; // "Detroit" or "lat,lng"
  days: number;
}): Promise<DailyForecast[]> {
  const params = new URLSearchParams({
    key: args.apiKey,
    q: args.query,
    days: String(args.days),
    aqi: "no",
    alerts: "no",
  });

  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WeatherAPI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as WaResponse;
  return normalizeForecastDays(data.forecast?.forecastday ?? []);
}

/**
 * Fetch ACTUAL past weather for `query` over [startDate, endDate] (inclusive,
 * "YYYY-MM-DD"). Used to backfill days within the current week that have
 * already elapsed — forecast.json only ever looks forward from today, so a
 * mid-week (or delayed) sync needs this to fill in Monday..yesterday.
 */
export async function fetchWeatherHistory(args: {
  apiKey: string;
  query: string;
  startDate: string;
  endDate: string;
}): Promise<DailyForecast[]> {
  const params = new URLSearchParams({
    key: args.apiKey,
    q: args.query,
    dt: args.startDate,
    end_dt: args.endDate,
  });

  const res = await fetch(`${HISTORY_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WeatherAPI history ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as WaResponse;
  return normalizeForecastDays(data.forecast?.forecastday ?? []);
}

function normalizeForecastDays(days: WaForecastDay[]): DailyForecast[] {
  return days.map((fd) => {
    const d = fd.day ?? {};
    return {
      date: fd.date ?? "",
      conditionText: d.condition?.text ?? "",
      maxTempF: d.maxtemp_f ?? NaN,
      minTempF: d.mintemp_f ?? NaN,
      avgTempF: d.avgtemp_f ?? NaN,
      chanceOfRain: d.daily_chance_of_rain ?? 0,
      chanceOfSnow: d.daily_chance_of_snow ?? 0,
      totalPrecipIn: d.totalprecip_in ?? 0,
      hours: (fd.hour ?? []).map((h) => ({
        // "time" is "YYYY-MM-DD HH:MM" local to the queried location.
        hour: parseInt((h.time ?? "").slice(11, 13), 10),
        conditionText: h.condition?.text ?? "",
        tempF: h.temp_f ?? NaN,
        chanceOfRain: h.chance_of_rain ?? 0,
        chanceOfSnow: h.chance_of_snow ?? 0,
      })),
    };
  });
}

// Clock windows, in local hours [start, end) — matches DAYPART_WINDOWS in
// vocab.ts, EXCEPT "late" is intentionally truncated to same-day hours only
// (21:00-23:59, not the 00:00-01:59 that technically belongs to the next
// calendar date) — by product decision, to avoid a second day's fetch just
// for a 2-hour tail.
const DAYPART_HOUR_RANGES: Record<Daypart, [number, number]> = {
  morning: [6, 11],
  midday: [11, 16],
  dinner: [16, 21],
  late: [21, 24],
};

/** One daypart's weather, reduced to what severityFromForecast reads. */
export interface DaypartWeather {
  daypart: Daypart;
  conditionText: string;
  avgTempF: number;
  chanceOfRain: number;
  chanceOfSnow: number;
}

/**
 * Slice one day's hourly points down to a single daypart's window and reduce
 * them to the same shape severityFromForecast already reads (so the exact
 * same severity RULE applies at daypart grain, not a different rule). Avg
 * temp across the window; MAX chance of rain/snow (a storm during any part
 * of the window should count for the whole window, not get averaged away);
 * condition text taken from whichever hour has the highest precip chance
 * (most likely to carry a "rain"/"thunder"/"snow" keyword if the window has
 * any severe weather in it at all).
 */
export function sliceDaypartWeather(
  day: DailyForecast,
  daypart: Daypart,
): DaypartWeather {
  const [start, end] = DAYPART_HOUR_RANGES[daypart];
  const hours = day.hours.filter((h) => h.hour >= start && h.hour < end);

  if (hours.length === 0) {
    // Shouldn't happen (WeatherAPI always returns 24 hours), but fall back
    // to the day's own aggregate rather than produce a bogus all-zero slice.
    return {
      daypart,
      conditionText: day.conditionText,
      avgTempF: day.avgTempF,
      chanceOfRain: day.chanceOfRain,
      chanceOfSnow: day.chanceOfSnow,
    };
  }

  const avgTempF =
    hours.reduce((sum, h) => sum + h.tempF, 0) / hours.length;
  const chanceOfRain = Math.max(...hours.map((h) => h.chanceOfRain));
  const chanceOfSnow = Math.max(...hours.map((h) => h.chanceOfSnow));
  const worstHour = hours.reduce((best, h) =>
    Math.max(h.chanceOfRain, h.chanceOfSnow) >
    Math.max(best.chanceOfRain, best.chanceOfSnow)
      ? h
      : best,
  );

  return {
    daypart,
    conditionText: worstHour.conditionText,
    avgTempF: Math.round(avgTempF * 10) / 10,
    chanceOfRain,
    chanceOfSnow,
  };
}
