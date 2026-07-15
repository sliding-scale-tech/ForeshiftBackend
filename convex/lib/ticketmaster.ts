// Ticketmaster Discovery API client (raw fetch + normalize).
//
// Scope of THIS module: connect to Ticketmaster, pull events for a geo + date
// window, and reduce each event to the fields our pipeline needs. It does NOT
// classify events into magnitude classes and does NOT compute zone proximity —
// those are separate, later steps.
//
// Docs basis: v7.1 §4 "query by geo_center + radius and date"; v8 §10.1 "Source:
// Ticketmaster API ... for the relevant dates and the operator's zone vicinity".

const DISCOVERY_URL = "https://app.ticketmaster.com/discovery/v2/events.json";

// Ticketmaster caps page size at 200 and deep paging at (size * page) < 1000.
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

/** An event reduced to the fields the ForeShift pipeline consumes. */
export interface NormalizedEvent {
  id: string; // Ticketmaster event id (stable; used to dedupe/upsert)
  name: string;
  segment: string | null; // classifications[0].segment.name (e.g. "Sports", "Music")
  genre: string | null; // classifications[0].genre.name
  localDate: string; // dates.start.localDate ("YYYY-MM-DD")
  localTime: string | null; // dates.start.localTime ("HH:MM:SS") — may be absent
  venueName: string | null;
  venueLat: number | null; // event venue latitude (drives proximity later)
  venueLng: number | null;
}

export interface FetchArgs {
  apiKey: string;
  latlong: string; // "lat,lng" center of the search
  radiusMiles: number; // search radius in miles
  startDateTime: string; // ISO8601 UTC, e.g. "2026-07-13T00:00:00Z"
  endDateTime: string; // ISO8601 UTC
}

// --- Minimal shapes for the parts of the Discovery response we read ---
interface TmClassification {
  segment?: { name?: string };
  genre?: { name?: string };
}
interface TmVenue {
  name?: string;
  location?: { latitude?: string; longitude?: string };
}
interface TmEvent {
  id: string;
  name: string;
  dates?: { start?: { localDate?: string; localTime?: string } };
  classifications?: TmClassification[];
  _embedded?: { venues?: TmVenue[] };
}
interface TmResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalPages?: number; number?: number };
}

function normalize(ev: TmEvent): NormalizedEvent {
  const cls = ev.classifications?.[0];
  const venue = ev._embedded?.venues?.[0];
  const latRaw = venue?.location?.latitude;
  const lngRaw = venue?.location?.longitude;
  const lat = latRaw != null ? Number(latRaw) : NaN;
  const lng = lngRaw != null ? Number(lngRaw) : NaN;
  return {
    id: ev.id,
    name: ev.name,
    segment: cls?.segment?.name ?? null,
    genre: cls?.genre?.name ?? null,
    localDate: ev.dates?.start?.localDate ?? "",
    localTime: ev.dates?.start?.localTime ?? null,
    venueName: venue?.name ?? null,
    venueLat: Number.isFinite(lat) ? lat : null,
    venueLng: Number.isFinite(lng) ? lng : null,
  };
}

/**
 * Fetch all events in the given geo + date window, following pagination.
 * Returns normalized events. Throws on a non-OK HTTP response so the caller
 * can surface a clear error (bad key, rate limit, etc.).
 */
export async function fetchTicketmasterEvents(
  args: FetchArgs,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      apikey: args.apiKey,
      latlong: args.latlong,
      radius: String(args.radiusMiles),
      unit: "miles",
      startDateTime: args.startDateTime,
      endDateTime: args.endDateTime,
      size: String(PAGE_SIZE),
      page: String(page),
      sort: "date,asc",
    });

    const res = await fetch(`${DISCOVERY_URL}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Ticketmaster ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as TmResponse;
    const events = data._embedded?.events ?? [];
    for (const ev of events) out.push(normalize(ev));

    const totalPages = data.page?.totalPages ?? 1;
    if (page + 1 >= totalPages) break; // no more pages
  }

  return out;
}
