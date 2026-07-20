// HTTP endpoint Bubble's backend workflow calls.
//
// POST {CONVEX_SITE_URL}/ai/ask
//   Body:    {
//              "question": "How busy will Fine Dining in Greektown be this weekend?",
//              "operatorZone": "Midtown",           // optional: Operator.zone
//              "operatorConcept": "Coffee Shop"     // optional: Operator.concept_type
//            }
//            Zone/concept named in the question take precedence; operatorZone/
//            operatorConcept are the fallback when the question omits them.
//   Headers: Content-Type: application/json
//            x-foreshift-secret: <secret>   (required only if FORESHIFT_SHARED_SECRET is set)
//   Returns: the AnswerResult JSON (see lib/orchestrator.ts).

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { answerQuestion, type CoefficientBundle } from "./lib/orchestrator";
import { verifySvixSignature } from "./lib/svix";

const http = httpRouter();

// Minimal shape of the Clerk (Svix) user webhook payload we consume.
interface ClerkEmail {
  id?: string;
  email_address?: string;
}
interface ClerkUserData {
  id?: string;
  email_addresses?: ClerkEmail[];
  primary_email_address_id?: string;
  username?: string | null;
  public_metadata?: { role?: string };
}
interface ClerkWebhookEvent {
  type?: string;
  data?: ClerkUserData;
}

// POST {CONVEX_SITE_URL}/zone-demand  — Phase 1 core (spec §3 contract).
//   Body: { zone, concept, day, daypart, events:[{class,proximity}], weather_severity }
//   Returns: { zone, concept, base_score, final_score, band, event_applied }
http.route({
  path: "/zone-demand",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.FORESHIFT_SHARED_SECRET;
    if (secret && req.headers.get("x-foreshift-secret") !== secret) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      zone?: unknown;
      concept?: unknown;
      day?: unknown;
      daypart?: unknown;
      events?: unknown;
      weather_severity?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
    }

    // Required string dimensions.
    const zone = typeof body.zone === "string" ? body.zone : "";
    const concept = typeof body.concept === "string" ? body.concept : "";
    const day = typeof body.day === "string" ? body.day : "";
    const daypart = typeof body.daypart === "string" ? body.daypart : "";
    if (!zone || !concept || !day || !daypart) {
      return Response.json(
        { ok: false, error: "Missing zone, concept, day, or daypart." },
        { status: 400 },
      );
    }

    // events[] defaults to none; weather_severity defaults to 0 (neutral).
    const rawEvents = Array.isArray(body.events) ? body.events : [];
    const events: { class: string; proximity: number }[] = [];
    for (const e of rawEvents) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { class?: unknown }).class === "string" &&
        typeof (e as { proximity?: unknown }).proximity === "number"
      ) {
        const ev = e as { class: string; proximity: number };
        events.push({ class: ev.class, proximity: ev.proximity });
      } else {
        return Response.json(
          { ok: false, error: "Each event needs {class: string, proximity: number}." },
          { status: 400 },
        );
      }
    }
    const weather_severity =
      typeof body.weather_severity === "number" ? body.weather_severity : 0;

    try {
      const result = await ctx.runAction(internal.demand.computeZoneDemand, {
        zone,
        concept,
        day,
        daypart,
        events,
        weather_severity,
      });
      return Response.json(result, { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ ok: false, error: message }, { status: 400 });
    }
  }),
});

// POST /operator/week — operator dashboard's demand data layer (7-day grid +
// day-detail). Body: { zone, concept }. Returns each of the 7 days with a
// `peak` rollup (busiest daypart — drives the 7-day grid card) and the full
// 4-daypart breakdown (drives the day-detail "Score by daypart" view). Called
// live (e.g. once on operator signup); ongoing loads should read Bubble's
// ResolvedDemand table instead, kept fresh by the weekly cron.
http.route({
  path: "/operator/week",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.FORESHIFT_SHARED_SECRET;
    if (secret && req.headers.get("x-foreshift-secret") !== secret) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { zone?: unknown; concept?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
    }

    const zone = typeof body.zone === "string" ? body.zone : "";
    const concept = typeof body.concept === "string" ? body.concept : "";
    if (!zone || !concept) {
      return Response.json(
        { ok: false, error: "Missing zone or concept." },
        { status: 400 },
      );
    }

    try {
      const result = await ctx.runAction(internal.operatorWeek.computeOperatorWeek, {
        zone,
        concept,
      });
      return Response.json(result, { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ ok: false, error: message }, { status: 400 });
    }
  }),
});

// POST /demand/outlook — "Today's Demand Outlook" / "This Week's Demand
// Outlook" / "Event Demand Impact" / "Weather Demand Impact" cards. Body:
// { zone, concept, type? }. type is "today" (default), "weekly", "events",
// or "weather". "events"/"weather" are always scoped to today and isolate
// one driver each (no cross-mention of the other factor) with no percentages
// — narration text only, per product decision. See lib/outlook.ts for the
// full response shape of each type.
http.route({
  path: "/demand/outlook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.FORESHIFT_SHARED_SECRET;
    if (secret && req.headers.get("x-foreshift-secret") !== secret) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { zone?: unknown; concept?: unknown; type?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
    }

    const zone = typeof body.zone === "string" ? body.zone : "";
    const concept = typeof body.concept === "string" ? body.concept : "";
    if (!zone || !concept) {
      return Response.json(
        { ok: false, error: "Missing zone or concept." },
        { status: 400 },
      );
    }
    const type =
      body.type === "weekly" || body.type === "events" || body.type === "weather"
        ? body.type
        : "today";

    try {
      const result = await ctx.runAction(internal.outlook.getOutlook, {
        zone,
        concept,
        type,
      });
      return Response.json(result, { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[/demand/outlook] pipeline error:", message);
      return Response.json({ ok: false, error: message }, { status: 400 });
    }
  }),
});

http.route({
  path: "/ai/ask",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // Optional shared-secret gate (enforced only when the env var is set).
    const secret = process.env.FORESHIFT_SHARED_SECRET;
    if (secret && req.headers.get("x-foreshift-secret") !== secret) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      question?: unknown;
      operatorZone?: unknown;
      operatorConcept?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { ok: false, error: "Body must be JSON." },
        { status: 400 },
      );
    }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      return Response.json(
        { ok: false, error: "Missing 'question' (non-empty string)." },
        { status: 400 },
      );
    }

    const operator = {
      zone: typeof body.operatorZone === "string" ? body.operatorZone : null,
      concept:
        typeof body.operatorConcept === "string" ? body.operatorConcept : null,
    };

    try {
      const coeffs: CoefficientBundle = await ctx.runQuery(
        internal.coefficients.getAll,
        {},
      );
      const result = await answerQuestion(question, operator, coeffs);
      return Response.json(result, { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[/ai/ask] pipeline error:", message);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }),
});

// Clerk -> Convex user sync. Configure a Clerk webhook (user.created,
// user.updated, user.deleted) pointing at {CONVEX_SITE_URL}/clerk-webhook and set
// CLERK_WEBHOOK_SECRET (the endpoint's signing secret) in the Convex env. The
// account's public metadata { "role": "admin" } becomes users.role = "admin".
http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    const svixId = req.headers.get("svix-id");
    console.log("[clerk-webhook] hit", {
      hasSecret: !!secret,
      hasSvixHeaders: !!svixId,
    });
    if (!secret) {
      return new Response("CLERK_WEBHOOK_SECRET not configured", { status: 500 });
    }

    const payload = await req.text();
    const verified = await verifySvixSignature({
      secret,
      headers: {
        id: svixId,
        timestamp: req.headers.get("svix-timestamp"),
        signature: req.headers.get("svix-signature"),
      },
      payload,
    });
    if (!verified) {
      console.warn(
        "[clerk-webhook] signature verification FAILED — CLERK_WEBHOOK_SECRET " +
          "likely does not match this endpoint's signing secret",
      );
      return new Response("Invalid signature", { status: 401 });
    }

    let evt: ClerkWebhookEvent;
    try {
      evt = JSON.parse(payload) as ClerkWebhookEvent;
    } catch {
      return new Response("Body must be JSON.", { status: 400 });
    }

    const type = evt.type ?? "";
    const data = evt.data ?? {};
    console.log("[clerk-webhook] verified event", {
      type,
      clerkId: data.id,
      role: data.public_metadata?.role ?? "user",
    });

    if (type === "user.created" || type === "user.updated") {
      const clerkId = data.id;
      if (!clerkId) return new Response("Missing user id.", { status: 400 });
      const emails = data.email_addresses ?? [];
      const primary =
        emails.find((e) => e.id === data.primary_email_address_id) ?? emails[0];
      await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkId,
        email: primary?.email_address,
        username: data.username ?? undefined,
        role: data.public_metadata?.role === "admin" ? "admin" : "user",
      });
    } else if (type === "user.deleted") {
      if (data.id) {
        await ctx.runMutation(internal.users.deleteFromClerk, {
          clerkId: data.id,
        });
      }
    }

    return new Response(null, { status: 200 });
  }),
});

export default http;
