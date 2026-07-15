// Event classification RULE — decides which magnitude class a Ticketmaster event
// belongs to. This is spec logic (backend spec §5 "implement the classification
// rules"), NOT owner-editable data.
//
// The canonical LIST of classes and their magnitudes lives in Convex (the
// `coefficients` table, group "event_magnitude") and is owner-editable. This rule
// only picks a class NAME; the caller validates that name against the Convex
// catalog, so code and data can't silently drift.
//
// METHOD = "B1 — segment only" (chosen 2026-07). Ticketmaster returns no venue
// capacity, so the spec's capacity tiers can't be applied; we classify purely by
// `segment`. Consequence: "Festival day" is never emitted (festivals come under the
// Music segment with no distinguishing flag). Revisit with a venue-tier list later.

// The class names this rule can emit. These MUST exist as keys in the Convex
// event_magnitude coefficient group (that table is the source of truth; this is
// just the rule's output vocabulary).
export type EventClass =
  | "Major stadium game"
  | "Concert / large show"
  | "Festival day"
  | "Minor event";

/** B1: map a Ticketmaster segment to an event class. */
export function classifyEvent(ev: { segment: string | null }): EventClass {
  switch (ev.segment) {
    case "Sports":
      return "Major stadium game";
    case "Music":
      return "Concert / large show";
    default:
      return "Minor event";
  }
}
