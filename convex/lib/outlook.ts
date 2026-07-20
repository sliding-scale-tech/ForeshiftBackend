// "Demand Outlook" pipeline — the fixed-shape sibling of orchestrator.ts's
// free-text Q&A. Bubble sends a zone + concept (+ type: "today" | "weekly")
// instead of a natural-language question, so there's no AI #1 parse step:
// the dimensions are already known. We still run AI #2 (narration) to
// produce the operator-facing paragraph, using the exact same resolved
// numbers (resolveCell / spec §2 formula) as /operator/week and the
// ResolvedDemand sync, so the narration can never disagree with the numbers.

import {
  narrateTodayOutlook,
  narrateWeeklyOutlook,
  narrateEventImpact,
  narrateWeatherImpact,
  type TokenUsage,
} from "./gemini";
import {
  fetchDemandRecords,
  fetchEventSignals,
  fetchWeatherSignals,
  type DemandRecord,
  type EventSignalRead,
  type WeatherSignalRead,
} from "./bubble";
import {
  indexEventsByCell,
  indexWeatherByZoneDay,
  resolveCell,
  type CoefficientBundle,
} from "./resolve";
import {
  DAYS,
  DAYPARTS,
  DAYPART_WINDOWS,
  dayFromLocalDate,
  currentWeekDates,
  mondayOfWeek,
  type Zone,
  type Concept,
  type Day,
  type Daypart,
  type Band,
} from "./vocab";

export interface DaypartOutlook {
  daypart: Daypart;
  window: string;
  score: number;
  band: Band;
}

export interface DayDrivers {
  events: {
    name: string;
    venue: string;
    class: string;
    daypart: Daypart;
    proximity: number;
    distance_miles: number;
    time: string | null;
  }[];
  weather: { condition: string; severity: number; temp_f: number } | null;
}

export interface DayOutlook {
  day: Day;
  date: string;
  peak: DaypartOutlook;
  dayparts: DaypartOutlook[];
  drivers: DayDrivers;
}

// Resolve all 4 dayparts for one zone×concept×day, plus that day's peak and
// its named event/weather drivers (union of each daypart's events; weather is
// one value per zone|day, same across all 4 dayparts of that day).
function resolveDayOutlook(args: {
  zone: string;
  concept: string;
  day: Day;
  date: string;
  dayparts: { daypart: Daypart; base_score: number; base_band: string }[];
  eventsByCell: Map<string, EventSignalRead[]>;
  weatherByZoneDay: Map<string, WeatherSignalRead>;
  coeffs: CoefficientBundle;
}): DayOutlook {
  const cells = DAYPARTS.map((dp) => {
    const cell = args.dayparts.find((d) => d.daypart === dp);
    return resolveCell({
      zone: args.zone,
      concept: args.concept,
      day: args.day,
      daypart: dp,
      window: DAYPART_WINDOWS[dp],
      base_score: cell?.base_score ?? 0,
      base_band: cell?.base_band ?? "Minimal",
      eventsByCell: args.eventsByCell,
      weatherByZoneDay: args.weatherByZoneDay,
      coeffs: args.coeffs,
    });
  });

  const peakCell = cells.reduce((best, c) =>
    c.final_score > best.final_score ? c : best,
  );

  return {
    day: args.day,
    date: args.date,
    peak: {
      daypart: peakCell.daypart,
      window: peakCell.window,
      score: peakCell.final_score,
      band: peakCell.final_band,
    },
    dayparts: cells.map((c) => ({
      daypart: c.daypart,
      window: c.window,
      score: c.final_score,
      band: c.final_band,
    })),
    drivers: {
      events: cells.flatMap((c) =>
        c.events.map((e) => ({ ...e, daypart: c.daypart })),
      ),
      weather: cells[0].weather,
    },
  };
}

// Shared by all four "today"-scoped outlook types (today/events/weather) —
// each just narrates a different slice of the same resolved day, so the
// fetch + resolve step only needs to happen once per file.
async function resolveTodayDay(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<DayOutlook> {
  const now = args.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const day = dayFromLocalDate(date) as Day;

  const [records, events, weather] = await Promise.all([
    fetchDemandRecords({ zones: [args.zone], concepts: [args.concept], days: [day] }),
    fetchEventSignals({ zones: [args.zone], days: [day] }),
    fetchWeatherSignals({ zones: [args.zone], days: [day] }),
  ]);

  const record: DemandRecord | undefined = records[0];
  if (!record) {
    throw new Error(
      `No base demand data for ${args.zone} / ${args.concept} / ${day}.`,
    );
  }

  return resolveDayOutlook({
    zone: args.zone,
    concept: args.concept,
    day,
    date,
    dayparts: record.dayparts,
    eventsByCell: indexEventsByCell(events),
    weatherByZoneDay: indexWeatherByZoneDay(weather),
    coeffs: args.coeffs,
  });
}

export interface TodayOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "today";
  day: Day;
  date: string;
  peak: DaypartOutlook;
  dayparts: DaypartOutlook[];
  drivers: DayDrivers;
  narration: string;
  usage: TokenUsage;
}

export async function computeTodayOutlook(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<TodayOutlookResult> {
  const outlook = await resolveTodayDay(args);

  const { text, usage } = await narrateTodayOutlook({
    zone: args.zone,
    concept: args.concept,
    day: outlook.day,
    date: outlook.date,
    peak: outlook.peak,
    dayparts: outlook.dayparts,
    drivers: outlook.drivers,
  });

  return {
    zone: args.zone,
    concept: args.concept,
    type: "today",
    day: outlook.day,
    date: outlook.date,
    peak: outlook.peak,
    dayparts: outlook.dayparts,
    drivers: outlook.drivers,
    narration: text.trim(),
    usage,
  };
}

export interface EventOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "events";
  day: Day;
  date: string;
  events: DayDrivers["events"];
  narration: string;
  usage: TokenUsage;
}

export async function computeEventOutlook(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<EventOutlookResult> {
  const outlook = await resolveTodayDay(args);

  const { text, usage } = await narrateEventImpact({
    zone: args.zone,
    concept: args.concept,
    day: outlook.day,
    date: outlook.date,
    events: outlook.drivers.events,
    dayparts: outlook.dayparts,
  });

  return {
    zone: args.zone,
    concept: args.concept,
    type: "events",
    day: outlook.day,
    date: outlook.date,
    events: outlook.drivers.events,
    narration: text.trim(),
    usage,
  };
}

export interface WeatherOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "weather";
  day: Day;
  date: string;
  weather: DayDrivers["weather"];
  narration: string;
  usage: TokenUsage;
}

export async function computeWeatherOutlook(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<WeatherOutlookResult> {
  const outlook = await resolveTodayDay(args);

  const { text, usage } = await narrateWeatherImpact({
    zone: args.zone,
    concept: args.concept,
    day: outlook.day,
    date: outlook.date,
    weather: outlook.drivers.weather,
    dayparts: outlook.dayparts,
  });

  return {
    zone: args.zone,
    concept: args.concept,
    type: "weather",
    day: outlook.day,
    date: outlook.date,
    weather: outlook.drivers.weather,
    narration: text.trim(),
    usage,
  };
}

export interface WeeklyOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "weekly";
  weekStart: string;
  days: DayOutlook[];
  weekPeak: { day: Day; date: string } & DaypartOutlook;
  narration: string;
  usage: TokenUsage;
}

export async function computeWeeklyOutlook(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<WeeklyOutlookResult> {
  const now = args.now ?? new Date();
  const weekStart = mondayOfWeek(now);
  const weekDates = currentWeekDates(now);

  const [records, events, weather] = await Promise.all([
    fetchDemandRecords({ zones: [args.zone], concepts: [args.concept], days: [] }),
    fetchEventSignals({ zones: [args.zone], days: [] }),
    fetchWeatherSignals({ zones: [args.zone], days: [] }),
  ]);
  if (records.length === 0) {
    throw new Error(`No base demand data for ${args.zone} / ${args.concept}.`);
  }

  const eventsByCell = indexEventsByCell(events);
  const weatherByZoneDay = indexWeatherByZoneDay(weather);
  const byDay = new Map(records.map((r) => [r.day, r]));

  const days: DayOutlook[] = DAYS.map((day) =>
    resolveDayOutlook({
      zone: args.zone,
      concept: args.concept,
      day,
      date: weekDates[day],
      dayparts: byDay.get(day)?.dayparts ?? [],
      eventsByCell,
      weatherByZoneDay,
      coeffs: args.coeffs,
    }),
  );

  const peakDay = days.reduce((best, d) =>
    d.peak.score > best.peak.score ? d : best,
  );

  const { text, usage } = await narrateWeeklyOutlook({
    zone: args.zone,
    concept: args.concept,
    weekStart,
    days: days.map((d) => ({
      day: d.day,
      date: d.date,
      peak: d.peak,
      drivers: d.drivers,
    })),
  });

  return {
    zone: args.zone,
    concept: args.concept,
    type: "weekly",
    weekStart,
    days,
    weekPeak: { day: peakDay.day, date: peakDay.date, ...peakDay.peak },
    narration: text.trim(),
    usage,
  };
}
