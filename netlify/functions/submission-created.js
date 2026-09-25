/**
 * Tripleseat lead sync for The Rock SLO.
 *
 * Netlify runs any function named `submission-created` automatically after
 * every verified (non-spam) form submission. It has no public URL and can't
 * be called from the browser.
 *
 * Only the `event-quote` form (private-events.html) is sent to Tripleseat.
 * Every other form (contact, band booking) is ignored here and keeps working
 * exactly as before in the Netlify dashboard and notification emails.
 *
 * If the Tripleseat call fails, the submission is still saved in Netlify,
 * so no inquiry is ever lost. Failures are written to the function log.
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *   TRIPLESEAT_PUBLIC_KEY    required  Tripleseat Settings → API → public key
 *   TRIPLESEAT_LOCATION_ID   optional  defaults to 14218 (The Rock SLO)
 *   TRIPLESEAT_LEAD_FORM_ID  optional  only set this for a Tripleseat lead
 *                                      form with the captcha/robot check OFF;
 *                                      a captcha-enabled form rejects every
 *                                      server-side lead
 *   TRIPLESEAT_DRY_RUN       optional  "true" = Tripleseat validates the lead
 *                                      but does not save it (for testing)
 */

const TRIPLESEAT_URL = 'https://api.tripleseat.com/v1/leads.json';
const SYNCED_FORMS = new Set(['event-quote']);
const DEFAULT_LOCATION_ID = 14218;

const SPACE_NAMES = {
  rockroom: 'The Rock Room',
  garden: 'Beer Garden',
  barrel: 'Barrel Room',
  terrace: 'Terrace Patio',
  taproom: 'Tap Room',
  full: 'Full Venue Buyout',
};

const clean = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

// "Under 25" → 25, "120 – 200" → 200. Tripleseat takes one number, so we send
// the top of the range (safer for capacity planning) and keep the range text
// in the notes.
function guestCountFrom(range) {
  const nums = clean(range).match(/\d+/g);
  return nums ? parseInt(nums[nums.length - 1], 10) : undefined;
}

// <input type="date"> already posts YYYY-MM-DD; reject anything else rather
// than have Tripleseat refuse the whole lead over a bad date.
function isoDate(v) {
  const s = clean(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

export function buildLead(data) {
  const eventType = clean(data['event-type']);
  const space = SPACE_NAMES[clean(data.space)] || clean(data.space);
  const guestRange = clean(data.guests);
  const referral = clean(data.referral);
  const message = clean(data.message);

  const notes = [
    message,
    '',
    '— Website inquiry details —',
    space && `Preferred space: ${space}`,
    guestRange && `Guest range: ${guestRange}`,
    referral && `How they heard about us: ${referral}`,
    'Submitted via therockslo.com',
  ]
    .filter((line) => line !== false && line !== undefined)
    .join('\n')
    .trim();

  const lead = {
    first_name: clean(data['first-name']),
    last_name: clean(data['last-name']),
    email_address: clean(data.email),
    phone_number: clean(data.phone),
    event_description: [eventType, space].filter(Boolean).join(' — ') || 'Website event inquiry',
    event_date: isoDate(data['preferred-date']),
    guest_count: guestCountFrom(guestRange),
    additional_information: notes,
    location_id: parseInt(process.env.TRIPLESEAT_LOCATION_ID || DEFAULT_LOCATION_ID, 10),
    // Only true when the visitor ticked the required consent checkbox.
    gdpr_consent_granted: clean(data['gdpr-consent']) !== '',
  };

  // Drop empty values so optional fields never trip Tripleseat validation.
  Object.keys(lead).forEach((k) => {
    if (lead[k] === '' || lead[k] === undefined || Number.isNaN(lead[k])) delete lead[k];
  });
  return lead;
}

export const handler = async (event) => {
  let payload;
  try {
    ({ payload } = JSON.parse(event.body || '{}'));
  } catch (err) {
    console.error('[tripleseat] could not parse submission body', err);
    return { statusCode: 200, body: 'ignored' };
  }

  const formName = payload?.form_name;
  if (!SYNCED_FORMS.has(formName)) {
    return { statusCode: 200, body: `form "${formName}" not synced` };
  }

  const key = process.env.TRIPLESEAT_PUBLIC_KEY;
  if (!key) {
    console.error('[tripleseat] TRIPLESEAT_PUBLIC_KEY is not set — lead NOT sent (still saved in Netlify)');
    return { statusCode: 200, body: 'missing key' };
  }

  const lead = buildLead(payload.data || {});
  const params = new URLSearchParams({ public_key: key, simple_error_messages: 'true' });
  if (process.env.TRIPLESEAT_LEAD_FORM_ID) params.set('lead_form_id', process.env.TRIPLESEAT_LEAD_FORM_ID);
  if (String(process.env.TRIPLESEAT_DRY_RUN).toLowerCase() === 'true') params.set('validate_only', 'true');

  const who = `${lead.first_name || ''} ${lead.last_name || ''} <${lead.email_address || 'no email'}>`.trim();

  try {
    const res = await fetch(`${TRIPLESEAT_URL}?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lead }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!res.ok || (body.errors && body.errors.length)) {
      console.error(`[tripleseat] lead REJECTED for ${who} (HTTP ${res.status}):`, JSON.stringify(body));
      return { statusCode: 200, body: 'tripleseat rejected lead' };
    }

    console.log(`[tripleseat] lead ${body.lead_id ?? '(dry run)'} created for ${who}: ${body.success_message || 'ok'}`);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error(`[tripleseat] request FAILED for ${who}:`, err);
    return { statusCode: 200, body: 'tripleseat unreachable' };
  }
};
