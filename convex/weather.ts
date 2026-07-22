import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import {
  fetchWeatherForecast,
  fetchWeatherHistory,
  sliceDaypartWeather,
  type DailyForecast,
  type DaypartWeather,
} from "./lib/weatherapi";
import { severityFromForecast, simplifyWeatherCondition } from "./lib/weatherSeverity";
import { dayFromLocalDate, daysUntilNextMonday, mondayOfWeek, DAYPARTS } from "./lib/vocab";
import {
  listWeatherSignalIds,
  createWeatherSignal,
  updateWeatherSignal,
  deleteWeatherSignal,
  type BubbleWeatherSignal,
  type DaypartWeatherFields,
} from "./lib/bubble";

// Reduce one daypart's sliced weather to the {severity, condition, temp_f,
// precip_chance} shape stored on the Bubble row — same severity RULE as the
// whole-day aggregate (severityFromForecast), just fed a daypart's hourly
// slice instead of the day's own aggregate.
function daypartRow(dw: DaypartWeather): DaypartWeatherFields {
  return {
    severity: severityFromForecast(dw),
    // condition is a Bubble option set (7 fixed values) — the raw WeatherAPI
    // text ("Patchy rain nearby") isn't one of them and would be rejected.
    condition: simplifyWeatherCondition(dw.conditionText),
    temp_f: dw.avgTempF,
    precip_chance: Math.max(dw.chanceOfRain, dw.chanceOfSnow),
  };
}

function daypartRowsForDay(
  f: DailyForecast,
): Record<(typeof DAYPARTS)[number], DaypartWeatherFields> {
  return {
    morning: daypartRow(sliceDaypartWeather(f, "morning")),
    midday: daypartRow(sliceDaypartWeather(f, "midday")),
    dinner: daypartRow(sliceDaypartWeather(f, "dinner")),
    late: daypartRow(sliceDaypartWeather(f, "late")),
  };
}

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

    // Cap at the upcoming Monday (not a flat 7) — same reasoning as the event
    // sync: a mid-week run must stay inside this week, never spill into next
    // week's Mon/Tue/Wed and overwrite this week's day-slots with wrong dates.
    const now = new Date();
    const query = args.query ?? "Detroit";
    const days = args.days ?? daysUntilNextMonday(now);
    const forecast = await fetchWeatherForecast({ apiKey, query, days });

    // Backfill days already elapsed this week (Monday..yesterday) with ACTUAL
    // past weather — forecast.json only ever looks forward from today, so a
    // mid-week or delayed sync would otherwise leave those day-slots with no
    // weather signal at all even though the real data is available via history.
    const weekStart = mondayOfWeek(now);
    const todayStr = now.toISOString().slice(0, 10);
    let history: Awaited<ReturnType<typeof fetchWeatherHistory>> = [];
    if (weekStart < todayStr) {
      const yesterday = new Date(now.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      history = await fetchWeatherHistory({
        apiKey,
        query,
        startDate: weekStart,
        endDate: yesterday,
      });
    }

    const allDays = [...history, ...forecast];
    const zones: { name: string }[] = await ctx.runQuery(api.zones.list, {});

    // Fan out: one row per (zone × day) — STILL one row per zone/day, not
    // per zone/day/daypart (wide format, matching ResolvedDemand's own
    // morning/midday/dinner/late-as-columns convention) — same severity
    // across zones, but now the row also carries a per-daypart breakdown
    // alongside the existing whole-day aggregate fields (unchanged, kept for
    // back-compat with anything already reading them).
    const rows: BubbleWeatherSignal[] = [];
    for (const f of allDays) {
      const severity = severityFromForecast(f);
      const day = dayFromLocalDate(f.date);
      const precip_chance = Math.max(f.chanceOfRain, f.chanceOfSnow);
      const daypartRows = daypartRowsForDay(f);
      for (const zone of zones) {
        rows.push({
          signal_key: `${zone.name}__${f.date}`,
          zone: zone.name,
          date: f.date,
          day,
          severity,
          condition: simplifyWeatherCondition(f.conditionText),
          precip_chance,
          temp_f: f.avgTempF,
          morning: daypartRows.morning,
          midday: daypartRows.midday,
          dinner: daypartRows.dinner,
          late: daypartRows.late,
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
      days: allDays.length,
      historyDays: history.length,
      forecastDays: forecast.length,
      zones: zones.length,
      rows: rows.length,
      bubble: { created, updated, deleted, existingBefore: existing.size },
    };
  },
});
