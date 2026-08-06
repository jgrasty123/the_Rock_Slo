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
 *   TICKETWEB_VENUE_ID — defaults to 428495 (SLO Brew Rock / SLO Brew Live)
 *   TICKETWEB_ORG_ID   — 214563. Only used if no venue ID is set.
 *   MANUAL_SHEET_CSV   — published-to-web CSV URL of the manual shows sheet.
 *                        Optional; without it only TicketWeb shows appear.
 *
 * TWO SOURCES:
 *   1. TicketWeb — everything ticketed through them, automatic.
 *   2. A Google Sheet — shows the team adds by hand (not sold via TicketWeb).
 *   Both are normalized to the same shape and merged. If either source fails,
 *   the other still renders; the page never goes blank because one is down.
 *
 * WHY VENUE ID RATHER THAN ORG ID:
 *   orgid=214563 returns only shows The Rock books itself (15 at time of build).
 *   venueid=428495 returns everything happening in the room, including shows
 *   booked by outside promoters (21 at time of build — Soulfly, Anberlin, The
 *   Frights and others come in this way). The venue query is the real calendar.
 *   Switch back by clearing TICKETWEB_VENUE_ID if the team ever wants to list
 *   only their own promotions.
 *
 * SWAPPING TICKET PLATFORMS (my805tix):
 *   Only two things below are TicketWeb-specific: fetchTicketWeb() and
 *   normalizeTicketWeb(). Write the equivalent pair for the new provider and
 *   point the handler at them. The shape returned by normalize() is the
 *   contract the front end depends on — keep it identical and no page markup
 *   or rendering code needs to change.
 */

const TW_ENDPOINT = 'https://api.ticketweb.com/api/events';
const VENUE_ID = process.env.TICKETWEB_VENUE_ID || '428495';
const ORG_ID = process.env.TICKETWEB_ORG_ID || '214563';
const API_KEY = process.env.TICKETWEB_API_KEY || '';
const SHEET_CSV_URL = process.env.MANUAL_SHEET_CSV || '';

// TicketWeb returns a 502 error page for requests without a browser-like
// User-Agent. This is not optional — a bare fetch() fails.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_EVENTS = 200;
const CACHE_SECONDS = 900; // 15 min — new shows are announced, not minute-to-minute

/* ---------------------------------------------------------------- helpers */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

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

  // Zeller-free weekday: safe because we build the date in UTC and only read
  // the weekday, never the local hour.
  const weekday = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];

  return {
    sortKey: raw,
    weekday,
    monthYear: `${FULL_MONTHS[month - 1]} ${year}`,
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

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', eacute: '\u00E9'
};

/**
 * Event descriptions come back as HTML with entities double-encoded in places
 * (&amp;quot;). Strip tags, then decode repeatedly until stable, so the front
 * end receives plain text and its own escaping is the only escaping applied.
 */
function decodeEntities(str) {
  var prev;
  var out = str;
  for (var pass = 0; pass < 3; pass++) {
    prev = out;
    out = out
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&([a-z]+);/gi, function (m, name) {
        var key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
      });
    if (out === prev) break;
  }
  return out;
}

function stripTags(html) {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------- provider: ticketweb */

async function fetchTicketWeb() {
  const params = new URLSearchParams({
    method: 'json',
    resultsPerPage: String(MAX_EVENTS)
  });

  // Venue query returns every show in the room; org query only our own bookings.
  if (VENUE_ID) params.set('venueid', VENUE_ID);
  else params.set('orgid', ORG_ID);

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

  const { name, support } = splitBilling(decodeEntities(String(raw.eventname || '')));

  return {
    id: raw.eventid || '',
    name,
    support,
    artist: decodeEntities(String(act.artist || '')).trim(),
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
    description: stripTags(raw.description).slice(0, 400)
  };
}

/* ------------------------------------------------- provider: google sheet */

/**
 * Minimal CSV parser. Google Sheets quotes any field containing a comma and
 * escapes embedded quotes by doubling them, so a naive split(',') mangles
 * things like "Smith, Jones & Co". This handles both.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/**
 * Turn "7:00 PM", "7pm", "19:00" or "1900" into HHMMSS for the shared date
 * parser. Returns '190000' (a 7pm default) if the cell is blank, since almost
 * every show here starts at 7.
 */
function normalizeTime(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (!val) return '190000';

  const m = val.match(/^(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am|pm)?$/);
  if (!m) return '190000';

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  // No am/pm and an hour that reads like an evening show — assume PM.
  if (!meridiem && hour < 12 && hour >= 1 && hour <= 11) hour += 12;

  return String(hour).padStart(2, '0') + String(minute).padStart(2, '0') + '00';
}

/** Accepts 2026-09-14, 9/14/2026, or 09-14-26 and returns YYYYMMDD. */
function normalizeDate(raw) {
  const val = String(raw || '').trim();
  if (!val) return '';

  let iso = val.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    return iso[1] + String(+iso[2]).padStart(2, '0') + String(+iso[3]).padStart(2, '0');
  }

  const us = val.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (us) {
    let year = +us[3];
    if (year < 100) year += 2000;
    return String(year) + String(+us[1]).padStart(2, '0') + String(+us[2]).padStart(2, '0');
  }
  return '';
}

async function fetchManualSheet() {
  if (!SHEET_CSV_URL) return [];

  const res = await fetch(SHEET_CSV_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Sheet responded ${res.status}`);

  const rows = parseCsv(await res.text());
  if (rows.length < 2) return [];

  // Match columns by header name so the team can reorder or add columns in the
  // sheet without breaking anything.
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const idx = {
    date: col('date'),
    time: col('time'),
    name: col('show name'),
    support: col('support'),
    price: col('price'),
    url: col('ticket link'),
    image: col('image url'),
    age: col('age'),
    publish: col('publish')
  };

  return rows.slice(1).map((r) => {
    const get = (k) => (idx[k] >= 0 && r[idx[k]] != null ? String(r[idx[k]]).trim() : '');
    return {
      date: get('date'),
      time: get('time'),
      name: get('name'),
      support: get('support'),
      price: get('price'),
      url: get('url'),
      image: get('image'),
      age: get('age'),
      publish: get('publish')
    };
  });
}

function normalizeManual(row) {
  // "Publish" must be an explicit yes — so a half-finished row sitting in the
  // sheet never appears on the site.
  if (!/^(y|yes|true|1|live)$/i.test(row.publish || '')) return null;
  if (!row.name) return null;

  const day = normalizeDate(row.date);
  if (!day) return null;

  const when = parseTwDate(day + normalizeTime(row.time));
  if (!when) return null;

  return {
    id: 'manual-' + day + '-' + row.name.slice(0, 20).replace(/\W+/g, '-').toLowerCase(),
    name: row.name,
    support: row.support,
    artist: '',
    genre: '',
    subgenre: '',
    url: row.url || '',
    image: row.image || '',
    imageSmall: row.image || '',
    date: when,
    priceDisplay: row.price || '',
    ageLabel: row.age || '',
    venue: 'SLO Brew Live',
    status: 'manual',
    description: ''
  };
}

/* ------------------------------------------------------------------ handler */

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  // Pull both sources independently. One failing must not take out the other.
  const [twResult, sheetResult] = await Promise.allSettled([
    fetchTicketWeb(),
    fetchManualSheet()
  ]);

  const sources = {
    ticketweb: twResult.status === 'fulfilled' ? 'ok' : String(twResult.reason && twResult.reason.message),
    sheet: SHEET_CSV_URL
      ? (sheetResult.status === 'fulfilled' ? 'ok' : String(sheetResult.reason && sheetResult.reason.message))
      : 'not configured'
  };

  const fromTw = twResult.status === 'fulfilled'
    ? twResult.value.map(normalizeTicketWeb).filter(Boolean)
    : [];
  const fromSheet = sheetResult.status === 'fulfilled'
    ? sheetResult.value.map(normalizeManual).filter(Boolean)
    : [];

  // If a show was added by hand and later appears in TicketWeb, TicketWeb wins
  // — it has the live ticket link and real artwork. Matched on date + a
  // loosened title so small wording differences still collapse.
  const key = (e) =>
    e.date.sortKey.slice(0, 8) + '|' + e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
  const seen = new Set(fromTw.map(key));
  const merged = fromTw.concat(fromSheet.filter((e) => !seen.has(key(e))));

  const todayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const events = merged
    .filter((e) => e.date.sortKey.slice(0, 8) >= todayKey)
    .sort((a, b) => a.date.sortKey.localeCompare(b.date.sortKey));

  const anySource = twResult.status === 'fulfilled' || sheetResult.status === 'fulfilled';

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Cache-Control': anySource
        ? `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=3600`
        : 'no-store'
    },
    body: JSON.stringify({
      ok: events.length > 0 || anySource,
      count: events.length,
      sources,
      events
    })
  };
};
