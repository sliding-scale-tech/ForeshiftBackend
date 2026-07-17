// Bubble Data API client — fetches rows from the DemandScore (WIDE) table.
//
// Convex is the orchestrator, so it queries Bubble directly using the structured
// query that AI #1 produced. Reads config from Convex env vars:
//   BUBBLE_API_BASE   e.g. https://yourapp.bubbleapps.io/api/1.1/obj
//                     (use the /version-test/... base while developing)
//   BUBBLE_API_TOKEN  a Bubble API token (Settings -> API). Sent as Bearer.
//   BUBBLE_DEMAND_TABLE  optional, defaults to "DemandScore" (Bubble type name).
//
// Docs: Bubble Data API uses ?constraints=<json> with { key, constraint_type, value }.

import {
  DAYPARTS,
  WIDE_FIELDS,
  type Zone,
  type Concept,
  type Day,
  type Daypart,
} from "./vocab";

export interface DaypartCell {
  daypart: Daypart;
  window: string;
  base_score: number;
  base_band: string;
}

// One normalized DemandScore row (a WIDE row = one zone/concept/day, 4 dayparts).
export interface DemandRecord {
  zone: string;
  concept: string;
  day: string;
  dayparts: DaypartCell[];
}

interface BubbleListResponse {
  response?: {
    results?: Record<string, unknown>[];
    cursor?: number;
    remaining?: number;
    count?: number;
  };
}

interface Constraint {
  key: string;
  constraint_type: "in" | "equals";
  value: string[] | string;
}

function config() {
  const base = process.env.BUBBLE_API_BASE;
  const token = process.env.BUBBLE_API_TOKEN;
  if (!base || !token) {
    throw new Error(
      "Bubble is not configured. Set BUBBLE_API_BASE and BUBBLE_API_TOKEN via `npx convex env set`.",
    );
  }
  const table = process.env.BUBBLE_DEMAND_TABLE ?? "DemandScore";
  return { base: base.replace(/\/$/, ""), token, table };
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(toStr(v));
  return Number.isFinite(n) ? n : 0;
}

// Safe string coercion for values of unknown type coming back from Bubble.
function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

// Bubble `date` fields must be sent as a value Date.parse() can read unambiguously.
// A bare "YYYY-MM-DD" string was fine while these fields were `text`, but now that
// they're real `date` fields, sending it un-anchored risks Bubble parsing it in the
// app's local timezone instead of UTC — shifting the stored day by one and breaking
// "is on date" filters. Anchor explicitly to UTC midnight.
function toBubbleDate(localDate: string): string {
  return `${localDate}T00:00:00.000Z`;
}

// Inverse: normalize whatever Bubble's Data API echoes back for a `date` field
// (ISO string or ms timestamp) to the "YYYY-MM-DD" shape the rest of the code uses.
function fromBubbleDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const d = new Date(v as string | number);
  if (Number.isNaN(d.getTime())) return toStr(v);
  return d.toISOString().slice(0, 10);
}

function normalize(row: Record<string, unknown>): DemandRecord {
  const dayparts: DaypartCell[] = DAYPARTS.map((dp) => {
    const f = WIDE_FIELDS[dp];
    return {
      daypart: dp,
      window: "",
      base_score: toNumber(row[f.score]),
      base_band: toStr(row[f.band]),
    };
  });
  return {
    zone: toStr(row["zone"]),
    concept: toStr(row["concept"]),
    day: toStr(row["day"]),
    dayparts,
  };
}

// ---------------------------------------------------------------------------
// EventSignal write client (upsert weekly event×zone rows into Bubble).
// The Bubble EventSignal type has these 10 fields (snake_case). Magnitude is NOT
// stored — it is resolved from the owner-editable coefficient store at compute time.
// ---------------------------------------------------------------------------

const EVENT_SIGNAL_TABLE = "EventSignal";

export interface BubbleEventSignal {
  signal_key: string; // `${eventId}__${zone}` — unique upsert key
  event_id: string;
  name: string;
  venue_name: string | null;
  event_class: string;
  zone: string; // option-set value — must match Bubble's Zone options exactly
  proximity: number;
  date: string; // "YYYY-MM-DD"
  day: string | null; // option-set value (Mon..Sun) — omitted if null
  daypart: string | null; // option-set value (morning..late) — omitted if null
}

// Build the Bubble request body. Null option-set fields (day/daypart) are omitted
// rather than sent as null, which Bubble would reject.
function eventSignalBody(s: BubbleEventSignal): Record<string, unknown> {
  const body: Record<string, unknown> = {
    signal_key: s.signal_key,
    event_id: s.event_id,
    name: s.name,
    venue_name: s.venue_name ?? "",
    event_class: s.event_class,
    zone: s.zone,
    proximity: s.proximity,
    date: toBubbleDate(s.date),
  };
  if (s.day) body.day = s.day;
  if (s.daypart) body.daypart = s.daypart;
  return body;
}

/** List existing EventSignal rows -> Map of signal_key -> Bubble _id (paginated). */
export async function listEventSignalIds(): Promise<Map<string, string>> {
  const { base, token } = config();
  const map = new Map<string, string>();
  let cursor = 0;
  for (let guard = 0; guard < 500; guard++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("cursor", String(cursor));
    const res = await fetch(`${base}/${EVENT_SIGNAL_TABLE}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Bubble list EventSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as BubbleListResponse;
    const page = data.response?.results ?? [];
    for (const row of page) {
      const key = row["signal_key"];
      const id = row["_id"];
      if (typeof key === "string" && typeof id === "string") map.set(key, id);
    }
    const remaining = data.response?.remaining ?? 0;
    cursor += page.length;
    if (page.length === 0 || remaining <= 0) break;
  }
  return map;
}

export async function createEventSignal(s: BubbleEventSignal): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${EVENT_SIGNAL_TABLE}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(eventSignalBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble create EventSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function updateEventSignal(
  bubbleId: string,
  s: BubbleEventSignal,
): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${EVENT_SIGNAL_TABLE}/${bubbleId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(eventSignalBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble update EventSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function deleteEventSignal(bubbleId: string): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${EVENT_SIGNAL_TABLE}/${bubbleId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Bubble delete EventSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// WeatherSignal write client (upsert weekly per-zone weather rows into Bubble).
// One forecast fetched for Detroit, stored per zone×date so the grain matches
// EventSignal. Severity is stored; weather_affinity stays in Convex.
// ---------------------------------------------------------------------------

const WEATHER_SIGNAL_TABLE = "WeatherSignal";

export interface BubbleWeatherSignal {
  signal_key: string; // `${zone}__${date}` — unique upsert key
  zone: string;
  date: string; // "YYYY-MM-DD"
  day: string | null; // option-set value (Mon..Sun) — omitted if null
  severity: number; // 0 / 0.25 / 0.5 / -0.10
  condition: string; // e.g. "Sunny"
  precip_chance: number; // %
  temp_f: number;
}

function weatherSignalBody(s: BubbleWeatherSignal): Record<string, unknown> {
  const body: Record<string, unknown> = {
    signal_key: s.signal_key,
    zone: s.zone,
    date: toBubbleDate(s.date),
    severity: s.severity,
    condition: s.condition,
    precip_chance: s.precip_chance,
    temp_f: s.temp_f,
  };
  if (s.day) body.day = s.day;
  return body;
}

/** List existing WeatherSignal rows -> Map of signal_key -> Bubble _id (paginated). */
export async function listWeatherSignalIds(): Promise<Map<string, string>> {
  const { base, token } = config();
  const map = new Map<string, string>();
  let cursor = 0;
  for (let guard = 0; guard < 500; guard++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("cursor", String(cursor));
    const res = await fetch(
      `${base}/${WEATHER_SIGNAL_TABLE}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      throw new Error(
        `Bubble list WeatherSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as BubbleListResponse;
    const page = data.response?.results ?? [];
    for (const row of page) {
      const key = row["signal_key"];
      const id = row["_id"];
      if (typeof key === "string" && typeof id === "string") map.set(key, id);
    }
    const remaining = data.response?.remaining ?? 0;
    cursor += page.length;
    if (page.length === 0 || remaining <= 0) break;
  }
  return map;
}

export async function createWeatherSignal(s: BubbleWeatherSignal): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${WEATHER_SIGNAL_TABLE}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(weatherSignalBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble create WeatherSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function updateWeatherSignal(
  bubbleId: string,
  s: BubbleWeatherSignal,
): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${WEATHER_SIGNAL_TABLE}/${bubbleId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(weatherSignalBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble update WeatherSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function deleteWeatherSignal(bubbleId: string): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${WEATHER_SIGNAL_TABLE}/${bubbleId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Bubble delete WeatherSignal ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

// Generic paginated GET of a Bubble table with constraints. Empty constraints =
// all rows. Used by the signal readers below.
async function fetchTableRows(
  table: string,
  constraints: Constraint[],
  maxRows: number,
): Promise<Record<string, unknown>[]> {
  const { base, token } = config();
  const results: Record<string, unknown>[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 50; guard++) {
    const params = new URLSearchParams();
    if (constraints.length) params.set("constraints", JSON.stringify(constraints));
    params.set("limit", "100");
    params.set("cursor", String(cursor));
    const res = await fetch(`${base}/${table}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Bubble ${table} read ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as BubbleListResponse;
    const page = data.response?.results ?? [];
    for (const row of page) results.push(row);
    const remaining = data.response?.remaining ?? 0;
    cursor += page.length;
    if (page.length === 0 || remaining <= 0 || results.length >= maxRows) break;
  }
  return results;
}

function zoneDayConstraints(zones: string[], days: string[]): Constraint[] {
  const c: Constraint[] = [];
  if (zones.length) c.push({ key: "zone", constraint_type: "in", value: zones });
  if (days.length) c.push({ key: "day", constraint_type: "in", value: days });
  return c;
}

export interface EventSignalRead {
  zone: string;
  day: string;
  daypart: string;
  event_class: string;
  proximity: number;
  name: string;
  venue_name: string;
}

/** Read EventSignal rows for the given zones/days (empty = all). */
export async function fetchEventSignals(args: {
  zones: string[];
  days: string[];
}): Promise<EventSignalRead[]> {
  const rows = await fetchTableRows(
    "EventSignal",
    zoneDayConstraints(args.zones, args.days),
    5000,
  );
  return rows.map((r) => ({
    zone: toStr(r["zone"]),
    day: toStr(r["day"]),
    daypart: toStr(r["daypart"]),
    event_class: toStr(r["event_class"]),
    proximity: toNumber(r["proximity"]),
    name: toStr(r["name"]),
    venue_name: toStr(r["venue_name"]),
  }));
}

export interface WeatherSignalRead {
  zone: string;
  day: string;
  date: string; // "YYYY-MM-DD"
  severity: number;
  condition: string;
  temp_f: number;
  precip_chance: number;
}

/**
 * Read WeatherSignal rows for the given zones/days (empty = all). WeatherSignal
 * carries both a calendar `date` and a `day` (day_of_week) option-set field that
 * the sync populates from the date; we constrain on zone + day, same as
 * EventSignal, so the weekly demand table joins cleanly by zone|day.
 */
export async function fetchWeatherSignals(args: {
  zones: string[];
  days: string[];
}): Promise<WeatherSignalRead[]> {
  const rows = await fetchTableRows(
    "WeatherSignal",
    zoneDayConstraints(args.zones, args.days),
    5000,
  );
  return rows.map((r) => ({
    zone: toStr(r["zone"]),
    day: toStr(r["day"]),
    date: fromBubbleDate(r["date"]),
    severity: toNumber(r["severity"]),
    condition: toStr(r["condition"]),
    temp_f: toNumber(r["temp_f"]),
    precip_chance: toNumber(r["precip_chance"]),
  }));
}

/**
 * Fetch matching DemandScore rows. Empty arrays mean "no filter on this
 * dimension" (i.e. all values). Paginates through Bubble's cursor.
 */
export async function fetchDemandRecords(args: {
  zones: Zone[];
  concepts: Concept[];
  days: Day[];
}): Promise<DemandRecord[]> {
  const { base, token, table } = config();

  const constraints: Constraint[] = [];
  if (args.zones.length)
    constraints.push({ key: "zone", constraint_type: "in", value: args.zones });
  if (args.concepts.length)
    constraints.push({
      key: "concept",
      constraint_type: "in",
      value: args.concepts,
    });
  if (args.days.length)
    constraints.push({ key: "day", constraint_type: "in", value: args.days });

  const results: DemandRecord[] = [];
  let cursor = 0;
  const pageSize = 100;
  // Hard cap so a misconfigured (unfiltered) query can't pull unbounded rows.
  const maxRows = 819; // full wide table = 13 x 9 x 7

  for (let guard = 0; guard < 20; guard++) {
    const params = new URLSearchParams();
    if (constraints.length)
      params.set("constraints", JSON.stringify(constraints));
    params.set("limit", String(pageSize));
    params.set("cursor", String(cursor));

    const res = await fetch(`${base}/${table}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Bubble Data API error ${res.status}: ${detail.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as BubbleListResponse;
    const page = data.response?.results ?? [];
    for (const row of page) results.push(normalize(row));

    const remaining = data.response?.remaining ?? 0;
    cursor += page.length;
    if (page.length === 0 || remaining <= 0 || results.length >= maxRows) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// ResolvedDemand write client (upsert weekly zone×concept×day rows into Bubble).
// WIDE format, same convention as DemandScore: one row per zone+concept+day, 4
// dayparts as columns, plus a peak_* rollup (that day's busiest daypart) for the
// 7-day grid. Keyed by zone+concept+day — NOT per operator — because the
// resolved demand doesn't depend on which restaurant asks: two operators sharing
// a zone+concept get identical numbers, so one row set serves both.
// ---------------------------------------------------------------------------

const RESOLVED_DEMAND_TABLE = "ResolvedDemand";

export interface BubbleResolvedDemand {
  signal_key: string; // `${zone}__${concept}__${day}` — unique upsert key
  zone: string;
  concept: string;
  day: string;
  date: string; // "YYYY-MM-DD" for this day within the current forecast week
  peak_daypart: string;
  peak_score: number;
  peak_band: string;
  morning_score: number;
  morning_band: string;
  midday_score: number;
  midday_band: string;
  dinner_score: number;
  dinner_band: string;
  late_score: number;
  late_band: string;
}

function resolvedDemandBody(s: BubbleResolvedDemand): Record<string, unknown> {
  const { date, ...rest } = s;
  const body: Record<string, unknown> = { ...rest };
  // date can be "" when no matching WeatherSignal row was found for this zone/day
  // (shouldn't happen post-sync); omit rather than send an invalid date value.
  if (date) body.date = toBubbleDate(date);
  return body;
}

/** List existing ResolvedDemand rows -> Map of signal_key -> Bubble _id (paginated). */
export async function listResolvedDemandIds(): Promise<Map<string, string>> {
  const { base, token } = config();
  const map = new Map<string, string>();
  let cursor = 0;
  for (let guard = 0; guard < 500; guard++) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("cursor", String(cursor));
    const res = await fetch(
      `${base}/${RESOLVED_DEMAND_TABLE}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      throw new Error(
        `Bubble list ResolvedDemand ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as BubbleListResponse;
    const page = data.response?.results ?? [];
    for (const row of page) {
      const key = row["signal_key"];
      const id = row["_id"];
      if (typeof key === "string" && typeof id === "string") map.set(key, id);
    }
    const remaining = data.response?.remaining ?? 0;
    cursor += page.length;
    if (page.length === 0 || remaining <= 0) break;
  }
  return map;
}

export async function createResolvedDemand(s: BubbleResolvedDemand): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${RESOLVED_DEMAND_TABLE}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(resolvedDemandBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble create ResolvedDemand ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function updateResolvedDemand(
  bubbleId: string,
  s: BubbleResolvedDemand,
): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${RESOLVED_DEMAND_TABLE}/${bubbleId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(resolvedDemandBody(s)),
  });
  if (!res.ok) {
    throw new Error(
      `Bubble update ResolvedDemand ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function deleteResolvedDemand(bubbleId: string): Promise<void> {
  const { base, token } = config();
  const res = await fetch(`${base}/${RESOLVED_DEMAND_TABLE}/${bubbleId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Bubble delete ResolvedDemand ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}
