// Weather severity RULE — turns a day's forecast into a single severity number.
// This is spec logic (ForeShift_Dev_Spec_v72.md / v7.1 §5), the only doc with an
// actual forecast->severity rule. NOT owner-editable.
//
//   thunder/snow OR precip >= 70%  -> 0.5
//   rain OR precip >= 40%          -> 0.25
//   sunny AND 68-84°F              -> -0.10  (ideal-day boost; negative -> demand up)
//   else                           -> 0
//
// Used later as: weather_factor = 1 - (severity × weather_affinity), where
// weather_affinity comes from the owner-editable Convex `weatherAffinity` table.

const IDEAL_TEMP_MIN_F = 68;
const IDEAL_TEMP_MAX_F = 84;

// Narrow shape (not the full DailyForecast) so this same rule applies
// unchanged whether fed a whole day's aggregate or one daypart's hourly
// slice (DaypartWeather in weatherapi.ts) — both satisfy this structurally.
export interface SeverityInput {
  conditionText: string;
  avgTempF: number;
  chanceOfRain: number;
  chanceOfSnow: number;
}

export function severityFromForecast(f: SeverityInput): number {
  const cond = f.conditionText.toLowerCase();
  // "precip" threshold = the higher of rain/snow chance.
  const precipChance = Math.max(f.chanceOfRain, f.chanceOfSnow);

  const isThunder = cond.includes("thunder");
  const isSnow = /snow|blizzard|sleet|ice/.test(cond);
  const isRain = /rain|drizzle|shower/.test(cond);
  const isSunny = /sunny|clear/.test(cond);

  if (isThunder || isSnow || precipChance >= 70) return 0.5;
  if (isRain || precipChance >= 40) return 0.25;
  if (
    isSunny &&
    f.avgTempF >= IDEAL_TEMP_MIN_F &&
    f.avgTempF <= IDEAL_TEMP_MAX_F
  ) {
    return -0.1;
  }
  return 0;
}

// Bubble's `condition` fields (whole-day + all 4 daypart-specific ones) are
// now option sets with exactly these 7 values — WeatherAPI has ~50 distinct
// condition strings ("Patchy rain nearby", "Thundery outbreaks possible",
// "Moderate or heavy snow with thunder", ...), none of which match an option
// set value verbatim, so every condition MUST be normalized to one of these
// 7 before writing to Bubble or the write is rejected (same failure mode as
// the EventSignal.daypart casing mismatch earlier). "Cloudy" is the
// guaranteed fallback so this can never fail to match.
//
// Priority order matters: checked top to bottom, first match wins. Thunder
// before Snow/Rain so e.g. "Moderate or heavy rain with thunder" becomes
// Thunder, not Rain. Order and keyword groupings are exactly as specified.
export function simplifyWeatherCondition(conditionText: string): string {
  const cond = conditionText.toLowerCase();
  if (cond.includes("thunder")) return "Thunder";
  if (/snow|blizzard|sleet|ice/.test(cond)) return "Snow";
  if (/rain|drizzle|shower/.test(cond)) return "Rain";
  if (/fog|mist/.test(cond)) return "Fog/Mist";
  if (/sunny|clear/.test(cond)) return "Clear/Sunny";
  if (cond.includes("partly")) return "Partly Cloudy";
  return "Cloudy"; // cloudy / overcast / anything unmatched
}
