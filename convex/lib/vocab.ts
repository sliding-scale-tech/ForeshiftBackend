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
