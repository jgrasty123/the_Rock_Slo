/**
 * The Rock SLO — live events feed
 *
 * Proxies the TicketWeb Event Discovery API and returns a normalized event list.
 *
 * Why this runs server-side instead of calling TicketWeb from the browser:
 *   1. The API key stays out of client JS.
 *   2. Responses are cached at the CDN, so traffic spikes don't hit TicketWeb.
 *   3. TicketWeb 502s any request without a browser-like User-Agent (see UA below).
 *
 * Environment variables (set in Netlify → Site settings → Environment variables):
 *   TICKETWEB_API_KEY  — required for the full event list
 *   TICKETWEB_ORG_ID   — defaults to 214563 (The Rock / SLO Brew Live)
 *
 * SWAPPING TICKET PLATFORMS (my805tix):
 *   Only two things below are TicketWeb-specific: fetchTicketWeb() and
 *   normalizeTicketWeb(). Write the equivalent pair for the new provider and
 *   point the handler at them. The shape returned by normalize() is the
 *   contract the front end depends on — keep it identical and no page markup
 *   or rendering code needs to change.
 */

const TW_ENDPOINT = 'https://api.ticketweb.com/api/events';
const ORG_ID = process.env.TICKETWEB_ORG_ID || '214563';
const API_KEY = process.env.TICKETWEB_API_KEY || '';

// TicketWeb returns a 502 error page for requests without a browser-like
// User-Agent. This is not optional — a bare fetch() fails.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_EVENTS = 100;
const CACHE_SECONDS = 900; // 15 min — new shows are announced, not minute-to-minute

/* ---------------------------------------------------------------- helpers */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * TicketWeb's record for the venue still reads "SLO Brew Rock"; the site brands
 * it "SLO Brew Live". Confirmed with the team that these are the same room, so
 * display the site's name rather than surfacing two names to visitors. Any
 * other venue passes through untouched.
 */
const VENUE_LABELS = {
  'slo brew rock': 'SLO Brew Live'
};

function venueLabel(name) {
  if (!name) return '';
  return VENUE_LABELS[name.trim().toLowerCase()] || name.trim();
}

/**
 * TicketWeb dates arrive as "YYYYMMDDHHMMSS" in the venue's local time.
 * Parse the components directly — passing this through new Date() would
 * reinterpret it in the server's timezone and shift evening shows to the
 * wrong day.
 */
function parseTwDate(raw) {
  if (!raw || raw.length < 8) return null;
  const year = +raw.slice(0, 4);
  const month = +raw.slice(4, 6);
  const day = +raw.slice(6, 8);
  const hour = raw.length >= 10 ? +raw.slice(8, 10) : 0;
  const minute = raw.length >= 12 ? +raw.slice(10, 12) : 0;

  let timeLabel = '';
  if (raw.length >= 12) {
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    timeLabel = `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
  }

  return {
    sortKey: raw,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    dateLabel: `${MONTHS[month - 1]} ${day}`,
    dayLabel: String(day),
    monthLabel: MONTHS[month - 1],
    yearLabel: String(year),
    timeLabel
  };
}

/**
 * TicketWeb has no separate support-act field — openers live inside the event
 * title ("REHASH w/ special guest Makeout Reef"). Split on that pattern so the
 * headliner and support render on their own lines. If there's no match, the
 * support line stays empty rather than being padded with filler.
 */
function splitBilling(eventName) {
  const name = (eventName || '').trim();
  const match = name.match(/\s+w\/\s+(.+)$/i);
  if (!match) return { name, support: '' };
  return {
    name: name.slice(0, match.index).trim(),
    support: `w/ ${match[1].trim()}`
  };
}

function stripTags(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------- provider: ticketweb */

async function fetchTicketWeb() {
  const params = new URLSearchParams({
    orgid: ORG_ID,
    method: 'json',
    resultsPerPage: String(MAX_EVENTS)
  });
  if (API_KEY) params.set('key', API_KEY);

  const res = await fetch(`${TW_ENDPOINT}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  });

  if (!res.ok) throw new Error(`TicketWeb responded ${res.status}`);

  const body = await res.json();
  if (!body || !Array.isArray(body.events)) {
    throw new Error('TicketWeb response missing events array');
  }
  return body.events;
}

function normalizeTicketWeb(raw) {
  const dates = raw.dates || {};
  const prices = raw.prices || {};
  const images = raw.eventimages || {};
  const venue = raw.venue || {};
  const act = (raw.attractionList || [])[0] || {};

  const when = parseTwDate(dates.startdate);
  if (!when) return null;

  const { name, support } = splitBilling(raw.eventname);

  return {
    id: raw.eventid || '',
    name,
    support,
    artist: (act.artist || '').trim(),
    genre: act.genre || '',
    subgenre: act.subgenre || '',
    url: raw.eventurl || '',
    image: images.large || images.small || '',
    imageSmall: images.small || images.large || '',
    date: when,
    priceDisplay: prices.pricedisplay || '',
    ageLabel: raw.agerestrictionmessage || '',
    venue: venueLabel(venue.name),
    status: raw.status || '',
    description: stripTags(raw.description).slice(0, 300)
  };
}

/* ------------------------------------------------------------------ handler */

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const rawEvents = await fetchTicketWeb();

    // Drop anything already past, then order soonest-first. TicketWeb's own
    // ordering is not guaranteed.
    const todayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const events = rawEvents
      .map(normalizeTicketWeb)
      .filter(Boolean)
      .filter((e) => e.date.sortKey.slice(0, 8) >= todayKey)
      .sort((a, b) => a.date.sortKey.localeCompare(b.date.sortKey));

    return {
      statusCode: 200,
      headers: {
        ...headers,
        // Serve stale content while revalidating so a slow TicketWeb response
        // never blocks a visitor.
        'Cache-Control': `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=3600`
      },
      body: JSON.stringify({ ok: true, count: events.length, events })
    };
  } catch (err) {
    // Fail soft: the page shows its fallback message and a link to TicketWeb.
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: String(err.message || err), events: [] })
    };
  }
};
