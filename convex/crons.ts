import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Weekly refresh of the live-signal layers into Bubble. Each run fetches the next
// 7 days and upserts by signal_key (deleteStale=true removes last week's rows).
// Scheduled Monday morning UTC (~1-2 AM Detroit, off-peak) so signals are fresh for
// the week. Staggered 30 min apart to avoid hitting the Bubble API concurrently.
const crons = cronJobs();

// Ticketmaster -> classify -> proximity -> EventSignal
crons.cron(
  "weekly event signal sync",
  "0 6 * * 1", // 06:00 UTC every Monday
  internal.events.syncEventSignalsToBubble,
  { deleteStale: true },
);

// WeatherAPI -> severity -> per-zone WeatherSignal
crons.cron(
  "weekly weather signal sync",
  "30 6 * * 1", // 06:30 UTC every Monday
  internal.weather.syncWeatherSignalsToBubble,
  { deleteStale: true },
);

// Resolved weekly demand (peak + 4-daypart breakdown per zone×concept×day) ->
// Bubble ResolvedDemand. Runs 30 min after BOTH signal syncs above so it always
// reads this week's freshest EventSignal/WeatherSignal rows.
crons.cron(
  "weekly resolved demand sync",
  "0 7 * * 1", // 07:00 UTC every Monday
  internal.operatorWeek.syncResolvedDemandToBubble,
  { deleteStale: true },
);

export default crons;
