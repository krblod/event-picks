// Readers for venue websites (used by the nightly job, Node only).
// Each reader turns one response into items: { sid, name, start, url, price, venueName, category, status, acts }.
'use strict';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

function decode(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

const pad = n => String(n).padStart(2, '0');

/** Date/time string -> { date, time } as wall-clock time in tz.
    No offset: taken as local already. With Z or an offset: converted to tz. */
function parseWhen(s, tz) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i);
  if (!m) return null;
  const [, y, mo, d, h, mi, , off] = m;
  if (h === undefined) return { date: `${y}-${mo}-${d}`, time: '' };
  if (!off) return { date: `${y}-${mo}-${d}`, time: pad(h) + ':' + mi };
  let offMin = 0;
  if (off.toUpperCase() !== 'Z') {
    const om = off.match(/([+-])(\d{1,2}):?(\d{2})?/);
    offMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
  }
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi) - offMin * 60000;
  if (!Number.isFinite(utc)) return null;
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(utc))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

function priceOf(min, max) {
  const a = typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : null;
  const b = typeof max === 'number' && Number.isFinite(max) && max >= 0 ? max : null;
  if (a == null && b == null) return null;
  const lo = a == null ? b : a, hi = b == null ? a : b;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/** "$25 - $30", "Free", "Free – $15.28", "$7.00 (includes fees)" -> { min, max } or null. */
function priceFromText(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const nums = [...s.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map(m => Number(m[1]));
  if (/\bfree\b/i.test(s)) nums.push(0);
  if (!nums.length) return null;
  return priceOf(Math.min(...nums), Math.max(...nums));
}

function statusOf(s) {
  const t = String(s || '').toLowerCase();
  if (/cancel/.test(t)) return 'cancelled';
  if (/postpon/.test(t)) return 'postponed';
  if (/reschedul/.test(t)) return 'rescheduled';
  if (/sold.?out/.test(t)) return 'soldout';
  return '';
}

// ---- wlcr: WordPress /wp-json/wlcr/v1/events/raw (Revolution Hall, Mississippi Studios, Aladdin) ----
function readWlcr(json) {
  if (!Array.isArray(json)) throw new Error('unexpected wlcr response');
  return json.filter(e => e && typeof e === 'object' && e.listed !== false).map(e => {
    const t = e.ticket_availability || {};
    return {
      sid: String(e.id),
      name: decode(e.name && (e.name.text || e.name.html)),
      start: e.start && e.start.local,
      url: e.url,
      price: priceOf(t.minimum_ticket_price && t.minimum_ticket_price.value, t.maximum_ticket_price && t.maximum_ticket_price.value),
      venueName: decode(e.venue && e.venue.name),
      status: t.is_sold_out ? 'soldout' : statusOf(e.status || (e.event_sales_status && e.event_sales_status.sales_status))
    };
  });
}

// ---- tribe: The Events Calendar REST /wp-json/tribe/events/v1/events (Crystal Ballroom) ----
function readTribe(json) {
  if (!json || !Array.isArray(json.events)) throw new Error('unexpected Events Calendar response');
  return json.events.filter(e => e && typeof e === 'object').map(e => {
    const cd = e.cost_details && Array.isArray(e.cost_details.values) ? e.cost_details.values.map(Number).filter(Number.isFinite) : [];
    return {
      sid: String(e.id),
      name: decode(e.title),
      start: e.all_day ? String(e.start_date || '').slice(0, 10) : e.start_date,
      url: e.website || e.url,
      price: cd.length ? priceOf(Math.min(...cd), Math.max(...cd)) : priceFromText(e.cost),
      venueName: decode(e.venue && e.venue.venue),
      category: (e.categories || []).map(c => decode(c && c.name)).filter(Boolean).join(', '),
      status: statusOf(e.title)
    };
  });
}

// ---- holocene: /api/events ----
function readHolocene(json) {
  if (!Array.isArray(json)) throw new Error('unexpected Holocene response');
  return json.filter(e => e && typeof e === 'object').map(e => ({
    sid: String(e.id),
    name: decode(e.displayTitle || e.name),
    start: e.dateTime,
    url: e.ticketUrl,
    price: priceOf(e.priceFrom, e.priceTo) || priceFromText(e.priceDisplay),
    category: decode(e.category),
    status: statusOf(e.availability && e.availability.status),
    acts: e.support ? [decode(e.support)] : []
  }));
}

// ---- crowdwork: https://crowdwork.com/api/v2/<theatre>/shows (Curious Comedy, Kickstand) ----
function readCrowdwork(json) {
  if (!json || !Array.isArray(json.data)) throw new Error('unexpected Crowdwork response');
  const out = [];
  for (const s of json.data) {
    if (!s || typeof s !== 'object' || (s.status && s.status !== 'active')) continue;
    const tiers = (Array.isArray(s.cost_tiers) ? s.cost_tiers : [])
      .map(t => t && Number(t.cost_after_fees)).filter(c => Number.isFinite(c) && c > 0).map(c => c / 100);
    const price = tiers.length ? priceOf(Math.min(...tiers), Math.max(...tiers)) : priceFromText(s.cost && s.cost.formatted);
    for (const d of Array.isArray(s.dates) ? s.dates : []) {
      out.push({ sid: s.id + '-' + String(d).slice(0, 16), name: decode(s.name), start: d, url: s.url, price, category: 'Comedy', status: '' });
    }
  }
  return out;
}

// ---- jsonld: schema.org Event objects embedded in a web page (Helium, Laurelthirst) ----
function readJsonLd(html) {
  if (typeof html !== 'string') throw new Error('unexpected page');
  const found = [];
  const walk = (node, depth) => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    const types = [].concat(node['@type'] || []).map(String);
    if (types.some(t => /Event$/.test(t)) && node.startDate) { found.push(node); return; }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim()), 0); } catch (e) { /* skip broken blocks */ }
  }
  return found.map(e => {
    const offers = [].concat(e.offers || []).filter(o => o && typeof o === 'object');
    const nums = [];
    for (const o of offers) for (const k of ['price', 'lowPrice', 'highPrice']) {
      const n = Number(o[k]);
      if (o[k] !== undefined && o[k] !== '' && Number.isFinite(n)) nums.push(n);
    }
    const performers = [].concat(e.performer || []).map(p => decode(p && (p.name || p))).filter(Boolean);
    return {
      sid: String(e.url || e['@id'] || (e.name + '@' + e.startDate)),
      name: decode(e.name),
      start: e.startDate,
      url: e.url,
      price: nums.length ? priceOf(Math.min(...nums), Math.max(...nums)) : null,
      venueName: decode(e.location && e.location.name),
      status: statusOf(e.eventStatus),
      acts: performers
    };
  });
}

const READERS = {
  wlcr: { format: 'json', read: readWlcr },
  tribe: { format: 'json', read: readTribe },
  holocene: { format: 'json', read: readHolocene },
  crowdwork: { format: 'json', read: readCrowdwork },
  jsonld: { format: 'html', read: readJsonLd }
};

const COMEDY_RE = /\b(comedy|comedian|comic|stand[- ]?up|improv|sketch|roast)\b/i;

/** Pick music / comedy / other from the item and the venue's kinds. */
function kindFor(item, venue) {
  const cat = String(item.category || '');
  const kinds = Array.isArray(venue.kinds) ? venue.kinds : [];
  if (/comedy/i.test(cat) || COMEDY_RE.test(item.name)) return 'comedy';
  if (kinds.length === 1 && kinds[0] === 'comedy') return 'comedy';
  if (/podcast|talk|lecture|film|trivia|market/i.test(cat)) return 'other';
  if (kinds.includes('music')) return 'music';
  return 'other';
}

/** Reader item -> event in the shape EPEvents.cleanEvent accepts. */
function toEvent(item, venue, sourceType) {
  if (!item || !item.name || !item.sid) return null;
  const when = parseWhen(item.start, venue.tz);
  if (!when) return null;
  let url = '';
  try { const u = new URL(item.url); if (u.protocol === 'https:') url = u.href; } catch (e) { /* none */ }
  // "SOLD OUT: Band" / "CANCELLED - Band" -> status tag + clean name
  let name = item.name, status = item.status || '';
  const pre = name.match(/^\s*(sold[- ]?out|cancel+ed|postponed|rescheduled)\s*[:!\-–—|]+\s*/i);
  if (pre && pre[0].length < name.length) { status = statusOf(pre[1]) || status; name = name.slice(pre[0].length); }
  const genres = String(item.category || '').split(',').map(s => s.trim())
    .filter(g => g && !/^(comedy|music|club|events?|shows?|january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(g)).slice(0, 3);
  return {
    id: 'site:' + venue.id + ':' + String(item.sid).slice(0, 80),
    name: name.slice(0, 200),
    url, date: when.date, time: when.time,
    status,
    venueId: venue.id, venueName: venue.name,
    kind: kindFor(item, venue), genres,
    acts: (item.acts || []).filter(Boolean).slice(0, 5).map(n => ({ id: '', name: String(n).slice(0, 200), upcoming: 0 })),
    price: item.price ? { min: Math.round(item.price.min * 100) / 100, max: Math.round(item.price.max * 100) / 100, currency: 'USD' } : null,
    source: 'site',
    via: sourceType
  };
}

function sameVenueName(a, b) {
  const n = s => decode(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n(a) === n(b);
}

module.exports = { decode, parseWhen, priceFromText, priceOf, statusOf, readWlcr, readTribe, readHolocene, readCrowdwork, readJsonLd, READERS, kindFor, toEvent, sameVenueName };
