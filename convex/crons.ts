import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Weekly refresh of the live-signal layers into Bubble. Only the first stage
// (event sync) is cron-triggered; it chains into weather sync, which chains into
// resolved-demand sync, each via ctx.scheduler.runAfter once the previous stage's
// action has actually finished (see the `finally` blocks in events.ts / weather.ts)
// instead of three independent crons at fixed clock-time offsets. This removes the
// old fixed 30-min buffers (which were a guess at "surely done by now") in favor of
// running each stage exactly when the previous one completes — chain runs in
// minutes instead of the old ~60-minute wall-clock spread. A failure in one stage
// is logged but still schedules the next stage (see try/finally), so one bad run
// doesn't block the others. The resolved-demand stage additionally retries its
// Bubble reads a couple of times if they come back empty, since Bubble's
// search/constraint reads aren't guaranteed instantly consistent with a write that
// just completed (see fetchWithIndexLagRetry in operatorWeek.ts). All outbound
// Bubble calls are also paced under Bubble's 1000 requests/min cap (see
// bubbleFetch in lib/bubble.ts), and weather->resolved-demand has an explicit
// 2-min buffer since resolved-demand alone issues ~850 requests on its own.
const crons = cronJobs();

// Ticketmaster -> classify -> proximity -> EventSignal. Chains into weather sync
// on completion (events.ts), which chains into resolved-demand sync (weather.ts).
crons.cron(
  "weekly event signal sync",
  "55 3 * * 1", // 03:55 UTC every Monday
  internal.events.syncEventSignalsToBubble,
  { deleteStale: true },
);

export default crons;
