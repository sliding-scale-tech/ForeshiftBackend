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
  narrateDaypartEventNotes,
  type DaypartNotes,
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
  // This daypart's baseline before any event/weather — what a "normal" day of
  // this kind looks like. Sent so a client can show the comparison itself.
  base_score: number;
  score: number;
  band: Band;
  // Two percentages, because one number can't answer both questions the card
  // asks. Both are rounded to 1 decimal and carry an explicit sign ("+3.5",
  // "-8.8", "0") — strings, not numbers, because JSON has no way to express a
  // leading "+". The "%" symbol is the UI's to add.
  //
  //   weather_percent  — weather's contribution ALONE: how much this daypart
  //                      moved because of the conditions, independent of any
  //                      event. Negative when weather is dampening demand.
  //   combined_percent — the total move off base_score, events AND weather
  //                      together. This is the one that matches `score`.
  //
  // They are equal whenever a daypart has no events; they diverge sharply when
  // it does (a concert can put combined_percent in the hundreds while
  // weather_percent stays at a few points).
  weather_percent: string;
  combined_percent: string;
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
    lift_score: number;
    lift_percent: number | null;
  }[];
  // One entry per daypart that has a weather reading (normally all 4) —
  // weather can now genuinely differ across the day (rain moving in by
  // dinner, clear at lunch), unlike the old single value shared by all 4
  // dayparts.
  weather: {
    daypart: Daypart;
    condition: string;
    severity: number;
    temp_f: number;
    weather_impact_score: number;
    weather_impact_percent: number;
  }[];
}

export interface DayOutlook {
  day: Day;
  date: string;
  peak: DaypartOutlook;
  dayparts: DaypartOutlook[];
  drivers: DayDrivers;
}

// --- Public "demand drivers" shape (today + weekly responses only) ----------
//
// Internally events and weather stay in two separately-typed arrays (DayDrivers)
// because the narration prompts and the isolated events/weather cards each need
// one side on its own. The today/weekly RESPONSES instead expose a single flat
// list where each entry carries `type`, so a client can render one repeating
// group over every driver. Every field of both shapes is present on every entry
// — the ones that don't apply to that type are filled with 0 / "N/A" rather
// than omitted, so the client never has to branch on which keys exist.
//
// Both types report their effect through the SAME pair of fields: weather's old
// weather_impact_score/_percent are named lift_score/lift_percent here, matching
// what events already used.
export interface DemandDriver {
  type: "event" | "weather";
  daypart: Daypart;
  // event-only (weather rows carry "N/A" / 0)
  name: string;
  venue: string;
  class: string;
  // Full ISO instant with Detroit's offset, e.g. "2026-08-05T19:30:00-04:00",
  // so a client can bind it to a date/time field. Empty string on weather rows
  // and on events Ticketmaster gave no time for.
  time: string;
  proximity: number;
  distance_miles: number;
  // weather-only (event rows carry "N/A" / 0)
  condition: string;
  severity: number;
  temp_f: number;
  // both
  lift_score: number;
  lift_percent: number;
}

const NA = "N/A";

// Detroit's UTC offset ON A GIVEN DATE, "-04:00" (EDT) or "-05:00" (EST).
// Looked up per date rather than hardcoded — a fixed offset would put every
// event an hour out for half the year.
function detroitOffset(date: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-05:00"; // EST — the safer fallback if the lookup fails
}

// An event's start as a full ISO instant ("2026-08-05T19:30:00-04:00") rather
// than the bare wall-clock text Bubble stores, so clients can bind it to a real
// date/time field and format it themselves. Empty string when the event has no
// time — never a placeholder, which would break date parsing on the client.
function eventTimestamp(date: string, time: string | null): string {
  if (!time || !date) return "";
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return `${date}T${hhmmss}${detroitOffset(date)}`;
}

/** Roll a second AI call's tokens into the response's single usage block. */
function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * 148.0537 -> "+148.1", -8.83 -> "-8.8", 0 -> "0".
 * No "%" — the UI supplies its own symbol; this only carries the sign, which a
 * JSON number can't (there is no positive "+" in JSON).
 */
function signedPercent(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

// How many drivers a today/weekly response returns per day.
const MAX_DRIVERS = 5;

/**
 * Flatten a day's events + weather into the single typed list described above:
 * strongest lift first, capped at MAX_DRIVERS.
 *
 * NOTE the sort is on the raw lift_score, not its magnitude — a storm's large
 * NEGATIVE lift therefore sorts last and can fall outside the top 5. That is
 * the requested ordering ("highest on top"); switch to Math.abs here if the
 * biggest movers in EITHER direction should win the slots instead.
 */
export function flattenDrivers(drivers: DayDrivers, date: string): DemandDriver[] {
  const events: DemandDriver[] = drivers.events.map((e) => ({
    type: "event",
    daypart: e.daypart,
    name: e.name,
    venue: e.venue || NA,
    class: e.class,
    time: eventTimestamp(date, e.time),
    proximity: e.proximity,
    distance_miles: e.distance_miles,
    condition: NA,
    severity: 0,
    temp_f: 0,
    lift_score: e.lift_score,
    lift_percent: e.lift_percent ?? 0,
  }));

  const weather: DemandDriver[] = drivers.weather.map((w) => ({
    type: "weather",
    daypart: w.daypart,
    name: NA,
    venue: NA,
    class: NA,
    time: "", // empty, not "N/A" — this field is a timestamp on the client
    proximity: 0,
    distance_miles: 0,
    condition: w.condition,
    severity: w.severity,
    temp_f: w.temp_f,
    lift_score: w.weather_impact_score,
    lift_percent: w.weather_impact_percent,
  }));

  return [...events, ...weather];
}

/** Strongest lift first, capped at MAX_DRIVERS. */
export function topDrivers<T extends DemandDriver>(drivers: T[]): T[] {
  return [...drivers]
    .sort((a, b) => b.lift_score - a.lift_score)
    .slice(0, MAX_DRIVERS);
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

  const dayparts: DaypartOutlook[] = cells.map((c) => ({
    daypart: c.daypart,
    window: c.window,
    base_score: c.base_score,
    score: c.final_score,
    band: c.final_band,
    weather_percent: signedPercent(c.weather?.weather_impact_percent ?? 0),
    combined_percent: signedPercent(
      c.base_score > 0
        ? ((c.final_score - c.base_score) / c.base_score) * 100
        : 0,
    ),
  }));

  const peak = dayparts.reduce((best, d) => (d.score > best.score ? d : best));

  return {
    day: args.day,
    date: args.date,
    peak,
    dayparts,
    drivers: {
      events: cells.flatMap((c) =>
        c.events.map((e) => ({ ...e, daypart: c.daypart })),
      ),
      weather: cells.flatMap((c) =>
        c.weather ? [{ ...c.weather, daypart: c.daypart }] : [],
      ),
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

// The daily card's dayparts carry one extra field the weekly card has no use
// for: the 6-12 word caption under that daypart's tile, written by AI. Every
// daypart always gets one — it leads with how busy the daypart is and names an
// event (or notable weather) when there is one to name.
export interface TodayDaypartOutlook extends DaypartOutlook {
  event_note: string;
}

export interface TodayOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "today";
  day: Day;
  date: string;
  peak: TodayDaypartOutlook;
  dayparts: TodayDaypartOutlook[];
  drivers: DemandDriver[];
  narration: string;
  // The same two paragraphs the standalone "events" and "weather" card types
  // return, carried here as well so the daily call alone can feed all three
  // cards. event_narration talks only about events, weather_narration only
  // about weather — deliberately, so the two never say the same thing.
  event_narration: string;
  weather_narration: string;
  usage: TokenUsage;
}

export async function computeTodayOutlook(args: {
  zone: Zone;
  concept: Concept;
  coeffs: CoefficientBundle;
  now?: Date;
}): Promise<TodayOutlookResult> {
  const outlook = await resolveTodayDay(args);

  // Each daypart's band + its own events + its own weather — everything the
  // note writer needs to describe that tile, and nothing from another daypart.
  const noteContext = outlook.dayparts.map((d) => ({
    daypart: d.daypart,
    band: d.band,
    events: outlook.drivers.events.filter((e) => e.daypart === d.daypart),
    weather:
      outlook.drivers.weather.find((w) => w.daypart === d.daypart) ?? null,
  }));

  const [narration, notesResult] = await Promise.all([
    narrateTodayOutlook({
      zone: args.zone,
      concept: args.concept,
      day: outlook.day,
      date: outlook.date,
      peak: outlook.peak,
      dayparts: outlook.dayparts,
      drivers: outlook.drivers,
    }),
    narrateDaypartEventNotes({
      zone: args.zone,
      day: outlook.day,
      date: outlook.date,
      dayparts: noteContext,
    }),
  ]);

  const notes: DaypartNotes = notesResult.notes;
  const withNotes: TodayDaypartOutlook[] = outlook.dayparts.map((d) => ({
    ...d,
    event_note: notes[d.daypart],
  }));
  const peak = withNotes.find((d) => d.daypart === outlook.peak.daypart)!;

  const { text, usage } = narration;
  return {
    zone: args.zone,
    concept: args.concept,
    type: "today",
    day: outlook.day,
    date: outlook.date,
    peak,
    dayparts: withNotes,
    // Narration above still gets both raw arrays (it needs the full picture);
    // only the response is flattened + capped.
    drivers: topDrivers(flattenDrivers(outlook.drivers, outlook.date)),
    narration: text.trim(),
    event_narration: notesResult.event_narration,
    weather_narration: notesResult.weather_narration,
    // Both AI calls billed to this request, so `usage` stays the true cost.
    usage: addUsage(usage, notesResult.usage),
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

// Weekly deliberately returns NO per-day breakdown: the 7-day grid on the front
// end reads Bubble's ResolvedDemand table, not this endpoint. All 7 days are
// still resolved internally (the narration and weekPeak need them) — they just
// aren't part of the response. What ships is the week's peak, ONE top-5 driver
// list for the whole week (each entry tagged with its day/date), and the text.
// Weekly's per-day block is deliberately thin: just the weather effect on each
// of the week's 28 daypart cells. The 7-day demand grid itself comes from
// Bubble's ResolvedDemand table, so scores and bands are not repeated here —
// this exists only because the weather split is nowhere else in one call.
export interface WeekDayWeather {
  day: Day;
  date: string;
  dayparts: {
    daypart: Daypart;
    // Weather's contribution to that daypart, signed, 1 decimal, no "%".
    // "0" when the day has no WeatherSignal row yet (beyond the forecast
    // horizon the WeatherAPI plan covers).
    weather_percent: string;
  }[];
}

export interface WeekDemandDriver extends DemandDriver {
  day: Day;
  date: string;
}

export interface WeeklyOutlookResult {
  zone: Zone;
  concept: Concept;
  type: "weekly";
  weekStart: string; // Monday, "YYYY-MM-DD"
  weekEnd: string; // that week's Sunday — the card labels a date RANGE
  days: WeekDayWeather[];
  drivers: WeekDemandDriver[];
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
  const weekEnd = weekDates.Sun;

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
    weekEnd,
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
    weekEnd,
    days: days.map((d) => ({
      day: d.day,
      date: d.date,
      dayparts: d.dayparts.map((dp) => ({
        daypart: dp.daypart,
        weather_percent: dp.weather_percent,
      })),
    })),
    // One top-5 for the whole week (not per day), each tagged with its day/date.
    drivers: topDrivers(
      days.flatMap((d) =>
        flattenDrivers(d.drivers, d.date).map((x) => ({
          ...x,
          day: d.day,
          date: d.date,
        })),
      ),
    ),
    weekPeak: { day: peakDay.day, date: peakDay.date, ...peakDay.peak },
    narration: text.trim(),
    usage,
  };
}
