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

import { type DailyForecast } from "./weatherapi";

const IDEAL_TEMP_MIN_F = 68;
const IDEAL_TEMP_MAX_F = 84;

export function severityFromForecast(f: DailyForecast): number {
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
