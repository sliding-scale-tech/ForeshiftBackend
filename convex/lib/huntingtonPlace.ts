// Huntington Place Detroit events — web-scrape client (raw fetch + normalize).
//
// Scope of THIS module: enumerate Huntington Place's published events and reduce
// each to the fields the ForeShift pipeline needs (name + date range). It does
// NOT classify magnitude and does NOT compute zone proximity — those are later
// steps in events.ts, exactly as for the Ticketmaster path (lib/ticketmaster.ts).
//
// Why scrape instead of an API: the public /events/ list page is JavaScript-
// rendered — it hydrates from a token-gated Simpleview REST endpoint
// (/includes/rest_v2/plugins_events_events_by_date/find/) that returns 403
// without a runtime-injected `core.simpleToken`. So the list page's raw HTML has
// no events and no `data-recid` markup. Instead we use two server-rendered
// surfaces that need no token:
//   1. GET /sitemap.xml — lists every current /event/<slug>/<recid>/ URL.
//   2. GET each detail page — carries a JSON-LD <script type="application/ld+json">
//      block with @type:"Event", name, startDate, endDate (DATE-ONLY, no time).
//
// Every event on this calendar is hosted AT Huntington Place (it is the venue's
// own "what's on in our building" calendar — verified across sample pages, none
// reference another address; the JSON-LD `location` names the promoter, not the
// venue). So the venue coordinate is a fixed constant, not per-event.

const SITE = "https://www.huntingtonplacedetroit.com";
const SITEMAP_URL = `${SITE}/sitemap.xml`;

// robots.txt declares `Crawl-delay: 2`. We pause this long between detail-page
// fetches. ~18 events -> ~40s added to the daily events sync (which already runs
// ~45s); comfortably inside an action's budget.
export const HUNTINGTON_CRAWL_DELAY_MS = 2000;

// Per-request ceiling so one hung fetch can't stall the whole sync.
const REQUEST_TIMEOUT_MS = 15_000;

// The site 200s for a browser UA and is flaky for unusual ones — mirror what was
// verified working during recon.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Huntington Place (former Cobo Center / TCF Center), 1 Washington Blvd, Detroit
// MI 48226 — coordinates per Wikipedia. The building is large and the locked
// proximity tiers are coarse (<=0.6mi -> 1.0, <=1.5mi -> 0.5), so sub-100m
// precision is irrelevant; flag this point AND the tier thresholds as
// owner-tunable calibration targets, same as the Ticketmaster venue coords.
export const HUNTINGTON_PLACE_VENUE = {
  name: "Huntington Place",
  lat: 42.32611,
  lng: -83.04694,
} as const;

/** An event reduced to the fields the ForeShift pipeline consumes. Mirrors
 *  ticketmaster.ts's NormalizedEvent, minus the fields this source can't give
 *  (no segment/genre, no start time, no per-event venue coords). */
export interface HuntingtonEvent {
  recid: string; // stable numeric id from the /event/<slug>/<recid>/ URL
  url: string; // canonical detail-page URL
  name: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD" — equal to startDate for a single-day event
}

async function getText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xml" },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Huntington GET ${url} -> ${res.status} ${res.statusText}: ${(
          await res.text()
        ).slice(0, 200)}`,
      );
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /sitemap.xml and pull every distinct `/event/<slug>/<recid>/` URL.
 * Returns them in document order, deduped by recid. Throws on a non-OK sitemap
 * response so the caller can decide to skip the Huntington layer for that run
 * rather than act on a partial/empty list.
 */
export async function listHuntingtonEventUrls(): Promise<
  { recid: string; url: string }[]
> {
  const xml = await getText(SITEMAP_URL);
  const out: { recid: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<loc>\s*(https?:\/\/[^<\s]+\/event\/[^<\s]+?\/(\d+)\/)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1].trim();
    const recid = m[2];
    if (seen.has(recid)) continue;
    seen.add(recid);
    out.push({ recid, url });
  }
  return out;
}

// Extract the first JSON-LD object with @type "Event" from a detail page.
// Handles a bare object, an array of objects, or an { @graph: [...] } wrapper,
// and tolerates sibling JSON-LD blocks (BreadcrumbList, Organization, ...).
function extractJsonLdEvent(
  html: string,
): { name?: string; startDate?: string; endDate?: string } | null {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "@graph" in parsed
        ? ((parsed as { "@graph": unknown[] })["@graph"] ?? [])
        : [parsed];
    for (const c of candidates) {
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        const t = o["@type"];
        const isEvent =
          t === "Event" || (Array.isArray(t) && t.includes("Event"));
        if (isEvent) {
          return {
            name: typeof o.name === "string" ? o.name : undefined,
            startDate:
              typeof o.startDate === "string" ? o.startDate : undefined,
            endDate: typeof o.endDate === "string" ? o.endDate : undefined,
          };
        }
      }
    }
  }
  return null;
}

// The source gives date-only values ("2026-09-04"); keep just the calendar date.
// Returns "" when the value isn't a leading ISO date we can trust.
function normDate(v: string | undefined): string {
  if (!v) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : "";
}

/**
 * GET one event detail page and normalize it. Returns null (not throwing) when
 * the page loads but carries no usable Event JSON-LD — a single junk page
 * shouldn't sink the whole run. Throws only on transport/HTTP failure.
 */
export async function fetchHuntingtonEvent(
  url: string,
  recid: string,
): Promise<HuntingtonEvent | null> {
  const html = await getText(url);
  const ld = extractJsonLdEvent(html);
  if (!ld) return null;
  const name = ld.name?.trim();
  const startDate = normDate(ld.startDate);
  if (!name || !startDate) return null;
  const endDate = normDate(ld.endDate) || startDate;
  return {
    recid,
    url,
    name,
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
  };
}
