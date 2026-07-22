import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
  {
    // Zone geography — one row per Detroit zone, sourced from ForeShift's
    // foreshift_13_zones.geojson (client-delivered package; see
    // ZONE_ASSIGNMENT_BRIEF.md). Holds the full polygon/multipolygon boundary
    // (for onboarding address -> zone point-in-polygon assignment, see
    // lib/pointInPolygon.ts) plus a derived centroid (for event proximity —
    // haversine venue -> zone centroid; tiers 1.0/0.5/0, see CLAUDE.md
    // "Event ingestion — locked decisions"). Replaces the old `zones` table
    // of hand-picked approximate centroids — this is real, official boundary
    // data, not a placeholder.
    zoneGeometry: defineTable({
      name: v.string(), // canonical zone string — must match convex/lib/vocab.ts exactly
      marketIndex: v.number(),
      source: v.string(), // provenance from the GeoJSON, e.g. "drawn_box" / "official_neighborhood"
      geometryType: v.union(v.literal("Polygon"), v.literal("MultiPolygon")),
      coordinates: v.any(), // GeoJSON coordinates, [lng, lat] pairs, nested per geometryType
      centroidLat: v.number(),
      centroidLng: v.number(),
    }).index("by_name", ["name"]),

    // Owner-editable coefficients — one table per set (backend spec §4.2/§4.3/§4.4 +
    // §5.2 hard requirement). Read at compute time; edited by the owner via an admin
    // surface with no code change / redeploy. Trade-secret ([TS], §8) — read/edit
    // only through internal functions, never a public API.

    // §4.3 Event magnitude by class (dummy: 50 / 30 / 20 / 10).
    eventMagnitude: defineTable({
      eventClass: v.string(), // must match classify.ts output + EventMagnitude catalog
      magnitude: v.number(),
    }).index("by_eventClass", ["eventClass"]),

    // §4.2 Event affinity by concept (dummy: 0.50). 0..1.
    eventAffinity: defineTable({
      concept: v.string(), // must match convex/lib/vocab.ts CONCEPTS exactly
      affinity: v.number(),
    }).index("by_concept", ["concept"]),

    // §4.4 Weather affinity by concept (dummy: 0.35). 0..1.
    weatherAffinity: defineTable({
      concept: v.string(), // must match convex/lib/vocab.ts CONCEPTS exactly
      affinity: v.number(),
    }).index("by_concept", ["concept"]),

    // App users, synced FROM Clerk via webhook (source of truth = Clerk). The admin
    // console (§5.2) gates coefficient edits on role === "admin". `role` is carried
    // from the Clerk account's public metadata ({ "role": "admin" }); everyone else
    // defaults to "user". `clerkId` is the Clerk user id (JWT `sub`), used to match
    // the authenticated caller against this table.
    users: defineTable({
      clerkId: v.string(),
      email: v.optional(v.string()),
      username: v.optional(v.string()),
      role: v.union(v.literal("admin"), v.literal("user")),
    }).index("by_clerkId", ["clerkId"]),

    // One row per ResolvedDemand sync run (cron or the admin "Save to Bubble"
    // button) — lets the admin panel show "when was this last pushed" even
    // across page reloads / a closed-then-reopened tab, since it reads from
    // this table instead of in-memory client state.
    bubbleSyncLog: defineTable({
      trigger: v.union(v.literal("admin"), v.literal("cron")),
      triggeredBy: v.optional(v.string()), // admin email/username; unset for cron
      startedAt: v.number(),
      finishedAt: v.number(),
      status: v.union(v.literal("success"), v.literal("error")),
      total: v.number(),
      created: v.number(),
      updated: v.number(),
      deleted: v.number(),
      error: v.optional(v.string()),
    }).index("by_trigger_and_finishedAt", ["trigger", "finishedAt"]),
  },
  { schemaValidation: true }
);
