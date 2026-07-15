import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { type Doc } from "./_generated/dataModel";
import { fetchWeatherForecast } from "./lib/weatherapi";
import { severityFromForecast } from "./lib/weatherSeverity";
import { dayFromLocalDate } from "./lib/vocab";
import {
  listWeatherSignalIds,
  createWeatherSignal,
  updateWeatherSignal,
  deleteWeatherSignal,
  type BubbleWeatherSignal,
} from "./lib/bubble";

// Step 3a/3b (debug): fetch the Detroit 7-day forecast and attach the v7.1 severity
// to each day. Inspection only — no per-zone fan-out, no storage (that's 3c).
//
// Requires the Convex deployment env var WEATHERAPI_KEY:
//   npx convex env set WEATHERAPI_KEY <key>
export const fetchWeatherRaw = internalAction({
  args: {
    query: v.optional(v.string()), // default "Detroit"
    days: v.optional(v.number()), // default 7
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.WEATHERAPI_KEY;
    if (!apiKey) {
      throw new Error(
        "WEATHERAPI_KEY is not set. Run: npx convex env set WEATHERAPI_KEY <key>",
      );
    }

    const forecast = await fetchWeatherForecast({
      apiKey,
      query: args.query ?? "Detroit",
      days: args.days ?? 7,
    });

    const withSeverity = forecast.map((f) => ({
      date: f.date,
      day: dayFromLocalDate(f.date),
      condition: f.conditionText,
      avgTempF: f.avgTempF,
      chanceOfRain: f.chanceOfRain,
      chanceOfSnow: f.chanceOfSnow,
      severity: severityFromForecast(f),
    }));

    return { count: withSeverity.length, forecast: withSeverity };
  },
});

// Step 3c: fetch one Detroit forecast, compute severity per day, fan out to all 13
// zones (same severity across zones), and upsert into Bubble WeatherSignal by
// signal_key (`${zone}__${date}`). With deleteStale=true, removes rows whose key is
// no longer produced (last week's dates).
export const syncWeatherSignalsToBubble = internalAction({
  args: {
    query: v.optional(v.string()),
    days: v.optional(v.number()),
    deleteStale: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.WEATHERAPI_KEY;
    if (!apiKey) {
      throw new Error(
        "WEATHERAPI_KEY is not set. Run: npx convex env set WEATHERAPI_KEY <key>",
      );
    }

    const forecast = await fetchWeatherForecast({
      apiKey,
      query: args.query ?? "Detroit",
      days: args.days ?? 7,
    });
    const zones: Doc<"zones">[] = await ctx.runQuery(api.zones.list, {});

    // Fan out: one row per (zone × forecast day), same severity across zones.
    const rows: BubbleWeatherSignal[] = [];
    for (const f of forecast) {
      const severity = severityFromForecast(f);
      const day = dayFromLocalDate(f.date);
      const precip_chance = Math.max(f.chanceOfRain, f.chanceOfSnow);
      for (const zone of zones) {
        rows.push({
          signal_key: `${zone.name}__${f.date}`,
          zone: zone.name,
          date: f.date,
          day,
          severity,
          condition: f.conditionText,
          precip_chance,
          temp_f: f.avgTempF,
        });
      }
    }

    const existing = await listWeatherSignalIds();
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const seen = new Set<string>();

    for (const row of rows) {
      seen.add(row.signal_key);
      const id = existing.get(row.signal_key);
      if (id) {
        await updateWeatherSignal(id, row);
        updated += 1;
      } else {
        await createWeatherSignal(row);
        created += 1;
      }
    }

    if (args.deleteStale) {
      for (const [key, id] of existing) {
        if (!seen.has(key)) {
          await deleteWeatherSignal(id);
          deleted += 1;
        }
      }
    }

    return {
      days: forecast.length,
      zones: zones.length,
      rows: rows.length,
      bubble: { created, updated, deleted, existingBefore: existing.size },
    };
  },
});
