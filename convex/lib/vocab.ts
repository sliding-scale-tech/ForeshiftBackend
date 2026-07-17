// ForeShift demand vocabulary + shared helpers.
//
// These are the exact, canonical dimension values used by the base-demand data
// (see FORESHIFT_DATA_STRUCTURE.md). AI #1 is constrained to these values so the
// query it builds always matches what exists in Bubble's DemandScore table.

export const ZONES = [
  "Core City / Woodbridge",
  "Corktown",
  "Downtown Detroit (Core)",
  "Eastern Market",
  "Financial District",
  "Foxtown / Stadium District",
  "Greektown / Casino District",
  "Mexicantown",
  "Midtown",
  "New Center / North End",
  "Riverfront / RiverWalk",
  "Southwest Detroit",
  "Woodward Core",
] as const;

export const CONCEPTS = [
  "Breakfast / Brunch Cafe",
  "Casual Dining",
  "Cocktail Lounge",
  "Coffee Shop",
  "Fast Casual",
  "Fine Dining",
  "Neighborhood / Casual Bar",
  "Sports Bar",
  "Upscale Casual",
] as const;

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const DAYPARTS = ["morning", "midday", "dinner", "late"] as const;

export type Zone = (typeof ZONES)[number];
export type Concept = (typeof CONCEPTS)[number];
export type Day = (typeof DAYS)[number];
export type Daypart = (typeof DAYPARTS)[number];

// Clock window per daypart (informational; `late` crosses midnight).
export const DAYPART_WINDOWS: Record<Daypart, string> = {
  morning: "06:00-11:00",
  midday: "11:00-16:00",
  dinner: "16:00-21:00",
  late: "21:00-02:00",
};

// Maps each daypart to the WIDE table's column names in Bubble's DemandScore.
// If your Bubble field slugs differ, this is the ONE place to adjust them.
export const WIDE_FIELDS: Record<Daypart, { score: string; band: string }> = {
  morning: { score: "morning_base_score", band: "morning_base_band" },
  midday: { score: "midday_base_score", band: "midday_base_band" },
  dinner: { score: "dinner_base_score", band: "dinner_base_band" },
  late: { score: "late_base_score", band: "late_base_band" },
};

export type Band =
  | "Minimal"
  | "Light"
  | "Moderate"
  | "High"
  | "Peak"
  | "Exceptional";

// Score -> band, using the thresholds documented in FORESHIFT_DATA_STRUCTURE.md.
// Used to re-band a score AFTER event/weather layers are applied.
export function scoreToBand(score: number): Band {
  if (score >= 110) return "Exceptional";
  if (score >= 85) return "Peak";
  if (score >= 65) return "High";
  if (score >= 40) return "Moderate";
  if (score >= 20) return "Light";
  return "Minimal";
}

// Map a Ticketmaster localDate ("YYYY-MM-DD") to our 3-letter day (Mon..Sun).
// Parsed at noon UTC to avoid timezone date-shift. Returns null if unparseable.
export function dayFromLocalDate(localDate: string): Day | null {
  if (!localDate) return null;
  const d = new Date(`${localDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return DAYS[(d.getUTCDay() + 6) % 7]; // getUTCDay: 0=Sun -> shift so Mon=0
}

// Calendar date (YYYY-MM-DD) of the Monday that starts the UTC week containing
// `now`. Anchor point for the weekly sync so it always targets one coherent
// Monday..Sunday week, never a rolling window that can straddle two weeks.
export function mondayOfWeek(now: Date): string {
  const sinceMonday = (now.getUTCDay() + 6) % 7; // 0 if `now` is already Monday
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday),
  );
  return monday.toISOString().slice(0, 10);
}

// The 7 calendar dates (YYYY-MM-DD) for Mon..Sun of the week containing `now`,
// keyed by day name. Lets a day-of-week row (e.g. ResolvedDemand's "Mon") always
// carry the correct date for THIS week, independent of whether a live signal
// (event/weather) happens to exist for that day.
export function currentWeekDates(now: Date): Record<Day, string> {
  const monday = new Date(`${mondayOfWeek(now)}T00:00:00Z`);
  const out = {} as Record<Day, string>;
  DAYS.forEach((day, i) => {
    out[day] = new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10);
  });
  return out;
}

// Days remaining from `now` through the upcoming Monday (inclusive of today,
// exclusive of that Monday) — caps a sync's fetch window so it never reaches
// into next week's Mon/Tue/Wed. On a run that starts exactly on Monday this is
// 7 (the full week); on a mid-week run it's whatever's left of the current week.
export function daysUntilNextMonday(now: Date): number {
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  return 7 - sinceMonday;
}

// Map a Ticketmaster localTime ("HH:MM:SS") to a daypart, using the windows in
// DAYPART_WINDOWS. Returns null for closed hours (02:00–06:00) or missing time.
export function daypartFromLocalTime(localTime: string | null): Daypart | null {
  if (!localTime) return null;
  const hour = parseInt(localTime.slice(0, 2), 10);
  if (Number.isNaN(hour)) return null;
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "dinner";
  if (hour >= 21 || hour < 2) return "late"; // 21:00–02:00 wraps midnight
  return null; // 02:00–06:00 = closed
}

// Keep only values that exist in the given vocabulary (defends against the model
// hallucinating a zone/concept/day that isn't real, which would break the query).
export function keepKnown<T extends string>(
  values: string[] | undefined,
  allowed: readonly T[],
): T[] {
  if (!values) return [];
  const set = new Set<string>(allowed);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of values) {
    if (set.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v as T);
    }
  }
  return out;
}
