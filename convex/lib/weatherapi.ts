// WeatherAPI.com forecast client (raw fetch + normalize).
//
// Scope: fetch the daily forecast for one location (Detroit) over N days and reduce
// each day to the fields the severity rule needs. No severity math here (that's
// weatherSeverity.ts), no storage.
//
// Docs basis: v8 §10.2 "forecast for relevant dates, Detroit"; v7.1 §4 weekly weather.

const FORECAST_URL = "https://api.weatherapi.com/v1/forecast.json";

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
interface WaForecastDay {
  date?: string;
  day?: WaDay;
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
  const days = data.forecast?.forecastday ?? [];

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
    };
  });
}
