/**
 * Upcoming shows feed for The Rock SLO.
 *
 *   1. Events come from My805Tix, the venue's ticketing platform.
 *   2. Responses are cached at the CDN, so traffic spikes don't hit them.
 *   3. One failing enrichment never removes a show from the calendar.
 *
 * Two calls per refresh path:
 *
 *   list   /events/events_by_organization/{pid}/{oid}/...  → every event for
 *          the organisation, with slug, date, venue and artwork. No pricing.
 *   detail /e/{slug}/tickets                               → schema.org
 *          JSON-LD with the ticket offers, which is where price and
 *          availability live.
 *
 * Neither endpoint is formally documented — the list URL was read out of
 * My805Tix's own events widget. It needs no key and is the same call their
 * embeddable calendar makes, but if they change it this feed is what breaks.
 * The `sources` field in the response says which half failed.
 */

const MY805_HOST = 'https://www.my805tix.com';
const MY805_PID = process.env.MY805TIX_PID || '5f8de510-7f70-4c3f-ab9c-2f830ad1e040';
const MY805_OID = process.env.MY805TIX_ORG_ID || '6a567026-1b68-4240-af2a-1dcb0a1e60fd';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_EVENTS = 200;
const CACHE_SECONDS = 900; // 15 min — shows are announced, not minute-to-minute
const DETAIL_CONCURRENCY = 6;
const DETAIL_TIMEOUT_MS = 6000;

/* ---------------------------------------------------------------- helpers */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/**
 * My805Tix records the room as "The Rock" or "Rod & Hammer Rock"; the site
 * brands the music room "SLO Brew Live". Same room — show the site's name
 * rather than surfacing three names to visitors.
 */
const VENUE_LABELS = {
  'the rock': 'SLO Brew Live',
  'rod & hammer rock': 'SLO Brew Live',
  'slo brew rock': 'SLO Brew Live'
};

function venueLabel(name) {
  if (!name) return '';
  return VENUE_LABELS[name.trim().toLowerCase()] || name.trim();
}

/**
 * My805Tix returns "2026-09-11 19:00:00" already in the venue's local time.
 * Parse the components directly — passing this through new Date() would
 * reinterpret it in the server's timezone and shift evening shows a day.
 */
function parseM8Date(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;

  const year = +m[1], month = +m[2], day = +m[3];
  const hour = m[4] == null ? null : +m[4];
  const minute = m[5] == null ? 0 : +m[5];

  let timeLabel = '';
  if (hour != null) {
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    timeLabel = `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const sortKey =
    `${year}${pad(month)}${pad(day)}${pad(hour == null ? 0 : hour)}${pad(minute)}00`;

  const weekday = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];

  return {
    sortKey,
    weekday,
    monthYear: `${FULL_MONTHS[month - 1]} ${year}`,
    iso: `${year}-${pad(month)}-${pad(day)}`,
    dateLabel: `${MONTHS[month - 1]} ${day}`,
    dayLabel: String(day),
    monthLabel: MONTHS[month - 1],
    yearLabel: String(year),
    timeLabel
  };
}

/**
 * My805Tix has no separate support-act field — openers live inside the event
 * title ("THE BENDS w/ special guest Margot Sinclair"). Split on that pattern
 * so the headliner and support render on their own lines. No match leaves the
 * support line empty rather than padding it with filler.
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

function decodeEntities(str) {
  var prev;
  var out = String(str == null ? '' : str);
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

/**
 * Event descriptions are author-written HTML from the My805Tix editor. They're
 * rendered into our own details modal, so everything outside a small allowlist
 * is stripped: no scripts, no styles, no event handlers, no javascript: URLs.
 * Live summaries only use p/br/span/strong/em/img/hr.
 */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'hr', 'ul', 'ol', 'li', 'h3', 'h4', 'img', 'a']);

function sanitizeHtml(input) {
  if (!input) return '';

  let out = String(input)
    // Drop whole dangerous elements including their contents.
    .replace(/<\s*(script|style|iframe|object|embed|form|input|svg)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|svg)\b[^>]*\/?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  out = out.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (match, close, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (close) return `</${tag}>`;

    // Rebuild from scratch — only these attributes survive, and only https.
    let kept = '';
    if (tag === 'img') {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (!src || !/^https:\/\//i.test(src[1])) return '';
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs);
      kept = ` src="${src[1].replace(/"/g, '&quot;')}" alt="${(alt ? alt[1] : '').replace(/"/g, '&quot;')}" loading="lazy"`;
    } else if (tag === 'a') {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (!href || !/^https?:\/\//i.test(href[1])) return '';
      kept = ` href="${href[1].replace(/"/g, '&quot;')}" target="_blank" rel="noopener nofollow"`;
    }
    return `<${tag}${kept}>`;
  });

  // Collapse the runs of empty paragraphs the editor leaves behind.
  return out.replace(/(?:\s*<p>\s*(?:&nbsp;|\s)*<\/p>\s*){2,}/gi, '<p></p>').trim();
}

function money(n) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/* --------------------------------------------------- provider: My805Tix */

async function fetchMy805Events() {
  // Trailing args: oid / start / end / topic / inclcal / incltopic /
  // incldateless / inclThumbnail — mirroring their widget's own call.
  const url =
    `${MY805_HOST}/events/events_by_organization/${MY805_PID}/${MY805_OID}` +
    '/0/0/0/true/true/true/true';

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`My805Tix list ${res.status}`);

  const body = await res.json();
  if (body.status !== 'success') throw new Error(`My805Tix list status: ${body.status}`);

  // `data` is keyed by event id rather than being an array.
  const raw = body.data;
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  return list.slice(0, MAX_EVENTS);
}

/**
 * Price and availability aren't in the list response. Each event page carries
 * schema.org JSON-LD with an `offers` array, which is the cheapest reliable
 * source for both. Returns null on any failure so the show still renders.
 */
async function fetchOffers(slug) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DETAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`${MY805_HOST}/e/${encodeURIComponent(slug)}/tickets`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: ctl.signal
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Pages carry more than one JSON-LD block, and the shape varies: some are
    // a flat Event, others wrap nodes in @graph. Scan every block for offers
    // rather than assuming the first one is the event.
    const blocks = [...html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
    )];

    let offers = null;
    for (const b of blocks) {
      let data;
      try { data = JSON.parse(b[1].trim()); } catch { continue; }
      const nodes = []
        .concat(data)
        .concat(Array.isArray(data['@graph']) ? data['@graph'] : []);
      for (const n of nodes) {
        if (n && n.offers) { offers = n.offers; break; }
      }
      if (offers) break;
    }
    if (!offers) return null;
    if (!Array.isArray(offers)) offers = [offers];

    const priced = offers
      .map((o) => ({
        price: parseFloat(o.price),
        inStock: !/soldout|outofstock/i.test(String(o.availability || ''))
      }))
      .filter((o) => Number.isFinite(o.price));

    if (!priced.length) return null;

    const values = priced.map((o) => o.price);
    const min = Math.min(...values);
    const max = Math.max(...values);

    return {
      priceDisplay: min === max ? money(min) : `${money(min)} – ${money(max)}`,
      soldOut: priced.every((o) => !o.inStock)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Small pool so a busy calendar doesn't fire 20 requests at once. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function normalizeMy805(entry) {
  const E = (entry && entry.Event) || {};
  const when = parseM8Date(E.start);

  // Dateless and unticketed records exist on the platform (standing offers,
  // drafts). They aren't shows and must not reach the calendar.
  if (!when || !E.name || E.tickets_active === false) return null;

  const { name, support } = splitBilling(decodeEntities(E.name));
  const slug = String(E.slug || '').trim();

  // Some records are listings only — the sale happens on TicketWeb, a
  // promoter's site, etc. Those can't open in the modal (there is no
  // My805Tix checkout behind them), so they get a plain outbound link.
  const external = String(E.tickets_url || '').trim();

  return {
    id: E.id || slug,
    name,
    support,
    artist: '',
    genre: (entry.EventTopic && entry.EventTopic.name) || '',
    subgenre: '',
    // Where "More Info" goes: the My805Tix event page.
    url: slug ? `${MY805_HOST}/e/${slug}` : '',
    // Set only when the sale lives on another site.
    externalTicketUrl: external,
    image: (entry.Logo && entry.Logo.url) || (entry.Masthead && entry.Masthead.url) || '',
    imageSmall: (entry.Logo && entry.Logo.url) || '',
    date: when,
    priceDisplay: '',
    soldOut: false,
    ageLabel: '',
    venue: venueLabel(E.location),
    status: '',
    description: stripTags(E.summary).slice(0, 400),
    // Full description for the details modal, sanitized above.
    descriptionHtml: sanitizeHtml(E.summary),
    // Password-protected events can't sell through the modal, so they get a
    // plain link to the event page instead.
    ticketSlug: (E.password_protected || external) ? '' : slug
  };
}

/* --------------------------------------------------------------- handler */

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  let events = [];
  let listStatus = 'ok';
  let detailStatus = 'ok';

  try {
    const raw = await fetchMy805Events();
    events = raw.map(normalizeMy805).filter(Boolean);

    const todayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    events = events
      .filter((e) => e.date.sortKey.slice(0, 8) >= todayKey)
      .sort((a, b) => a.date.sortKey.localeCompare(b.date.sortKey));

    // Same show occasionally exists twice (e.g. re-created under a new org).
    // Collapse on date + loosened title, first occurrence wins.
    const seen = new Set();
    events = events.filter((e) => {
      const k = e.date.sortKey.slice(0, 8) + '|' +
        e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Enrich with pricing. Failures here degrade the card, never drop it.
    // Only events that actually sell on My805Tix have offers to look up.
    const withSlug = events.filter((e) => e.ticketSlug);
    const offers = await mapPool(withSlug, DETAIL_CONCURRENCY, (e) => fetchOffers(e.ticketSlug));
    offers.forEach((o, idx) => {
      if (!o) return;
      withSlug[idx].priceDisplay = o.priceDisplay;
      withSlug[idx].soldOut = o.soldOut;
    });

    const missed = offers.filter((o) => !o).length;
    if (missed) detailStatus = `${missed} of ${withSlug.length} events missing pricing`;
  } catch (err) {
    listStatus = String((err && err.message) || err);
    detailStatus = 'skipped';
  }

  const ok = listStatus === 'ok';

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Cache-Control': ok
        ? `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=3600`
        : 'no-store'
    },
    body: JSON.stringify({
      ok,
      count: events.length,
      sources: { my805tix: listStatus, pricing: detailStatus },
      events
    })
  };
};
