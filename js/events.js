/* Event Picks: pure helpers for Ticketmaster data (normalise, classify, format, distance).
   UMD: window.EPEvents in the browser, require() in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EPEvents = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BUILD = '0.6.0';   // keep equal to VERSION in sw.js

  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 300) : ''; }
  function num(v) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }
  function httpsUrl(v) {
    if (typeof v !== 'string') return '';
    try { const u = new URL(v); return u.protocol === 'https:' ? u.href : ''; } catch (e) { return ''; }
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;
  const KINDS = ['music', 'comedy', 'other'];
  const SOURCES = ['tm', 'site', 'both'];
  const IGNORED_GENRES = ['undefined', 'other', 'miscellaneous', ''];

  /** 'comedy' if any classification says Comedy, else 'music' for the Music segment, else 'other'. */
  function kindOf(classifications) {
    const list = Array.isArray(classifications) ? classifications : [];
    let kind = 'other';
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const seg = str(c.segment && c.segment.name).toLowerCase();
      const genre = str(c.genre && c.genre.name).toLowerCase();
      const sub = str(c.subGenre && c.subGenre.name).toLowerCase();
      if (genre === 'comedy' || sub === 'comedy') return 'comedy';
      if (seg === 'music') kind = 'music';
    }
    return kind;
  }

  function genresOf(classifications) {
    const out = [];
    for (const c of Array.isArray(classifications) ? classifications : []) {
      if (!c || typeof c !== 'object') continue;
      for (const part of [c.genre, c.subGenre]) {
        const name = str(part && part.name, 60);
        if (!IGNORED_GENRES.includes(name.toLowerCase()) && !out.includes(name)) out.push(name);
      }
    }
    return out.slice(0, 6);
  }

  /** Raw Discovery API event -> small, trusted shape (or null when unusable). */
  function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id, 100);
    const dates = raw.dates && typeof raw.dates === 'object' ? raw.dates : {};
    const start = dates.start && typeof dates.start === 'object' ? dates.start : {};
    const date = DATE_RE.test(start.localDate) ? start.localDate : '';
    if (!id || !date) return null;
    const time = typeof start.localTime === 'string' && TIME_RE.test(start.localTime.slice(0, 5)) ? start.localTime.slice(0, 5) : '';
    const emb = raw._embedded && typeof raw._embedded === 'object' ? raw._embedded : {};
    const venue = (Array.isArray(emb.venues) && emb.venues[0]) || {};
    const acts = (Array.isArray(emb.attractions) ? emb.attractions : [])
      .filter(a => a && typeof a === 'object')
      .map(a => ({ id: str(a.id, 100), name: str(a.name, 200), upcoming: num(a.upcomingEvents && a.upcomingEvents._total) || 0 }))
      .filter(a => a.name).slice(0, 10);
    let min = null, max = null, currency = '';
    for (const p of Array.isArray(raw.priceRanges) ? raw.priceRanges : []) {
      if (!p || typeof p !== 'object') continue;
      const lo = num(p.min), hi = num(p.max);
      if (lo != null && lo >= 0 && (min == null || lo < min)) min = lo;
      if (hi != null && hi >= 0 && (max == null || hi > max)) max = hi;
      if (!currency && /^[A-Z]{3}$/.test(p.currency)) currency = p.currency;
    }
    if (min == null && max != null) min = max;
    if (max == null && min != null) max = min;
    return cleanEvent({
      id, name: str(raw.name, 200), url: httpsUrl(raw.url), date, time, source: 'tm',
      status: str(dates.status && dates.status.code, 30).toLowerCase(),
      venueId: str(venue.id, 100), venueName: str(venue.name, 200),
      kind: kindOf(raw.classifications), genres: genresOf(raw.classifications), acts,
      price: min == null ? null : { min, max, currency: currency || 'USD' }
    });
  }

  /** Re-validate an already normalised event (used for cached and imported data). */
  function cleanEvent(e) {
    if (!e || typeof e !== 'object') return null;
    const id = str(e.id, 100), date = DATE_RE.test(e.date) ? e.date : '';
    if (!id || !date) return null;
    let price = null;
    if (e.price && typeof e.price === 'object') {
      const min = num(e.price.min), max = num(e.price.max);
      if (min != null && max != null && min >= 0 && max >= min) {
        price = { min, max, currency: /^[A-Z]{3}$/.test(e.price.currency) ? e.price.currency : 'USD' };
      }
    }
    return {
      id, date,
      name: str(e.name, 200) || 'Untitled event',
      url: httpsUrl(e.url),
      time: TIME_RE.test(e.time) ? e.time : '',
      status: /^[a-z]{0,30}$/.test(e.status) ? e.status : '',
      venueId: str(e.venueId, 100), venueName: str(e.venueName, 200),
      watchId: str(e.watchId, 100),
      source: SOURCES.includes(e.source) ? e.source : (id.startsWith('site:') ? 'site' : 'tm'),
      kind: KINDS.includes(e.kind) ? e.kind : 'other',
      genres: (Array.isArray(e.genres) ? e.genres : []).map(g => str(g, 60)).filter(Boolean).slice(0, 6),
      acts: (Array.isArray(e.acts) ? e.acts : []).filter(a => a && typeof a === 'object')
        .map(a => ({ id: str(a.id, 100), name: str(a.name, 200), upcoming: Math.max(0, Math.floor(num(a.upcoming) || 0)) }))
        .filter(a => a.name).slice(0, 10),
      price
    };
  }

  /** Raw Discovery API venue -> small shape. */
  function normalizeVenue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id, 100), name = str(raw.name, 200);
    if (!id || !name) return null;
    const loc = raw.location && typeof raw.location === 'object' ? raw.location : {};
    const upcoming = raw.upcomingEvents && typeof raw.upcomingEvents === 'object' ? num(raw.upcomingEvents._total) : null;
    return {
      id, name,
      address: str(raw.address && raw.address.line1, 200),
      city: str(raw.city && raw.city.name, 100),
      state: str(raw.state && raw.state.stateCode, 10),
      lat: num(loc.latitude), lon: num(loc.longitude),
      upcoming: upcoming == null ? null : Math.max(0, Math.floor(upcoming))
    };
  }

  function distanceMiles(lat1, lon1, lat2, lon2) {
    if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
    const rad = d => d * Math.PI / 180, R = 3958.8;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Geohash of a point (the Discovery API's geoPoint parameter). */
  function geohash(lat, lon, precision) {
    const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    const latR = [-90, 90], lonR = [-180, 180];
    let hash = '', bit = 0, ch = 0, even = true;
    while (hash.length < (precision || 9)) {
      const r = even ? lonR : latR, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
      if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch = ch << 1; r[1] = mid; }
      even = !even;
      if (++bit === 5) { hash += B32[ch]; bit = 0; ch = 0; }
    }
    return hash;
  }

  function tokens(s) {
    return str(s, 200).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  }
  const GENERIC = ['the', 'theater', 'theatre', 'hall', 'club', 'comedy', 'music', 'venue', 'ballroom', 'lounge', 'bar', 'pdx', 'portland'];

  /** Search keywords to try in order: as typed, without punctuation, then the distinctive word(s). */
  function nameVariants(name) {
    const out = [];
    const add = v => { v = v.trim(); if (v && !out.some(o => o.toLowerCase() === v.toLowerCase())) out.push(v); };
    add(str(name, 200));
    const t = tokens(name);
    add(t.join(' '));
    const core = t.filter(w => !GENERIC.includes(w));
    if (core.length && core.length < t.length) add(core.join(' '));
    return out;
  }

  /** 0..1: share of the wanted name's words found in the venue name (punctuation and case ignored). */
  function nameMatch(wanted, venueName) {
    const w = tokens(wanted), v = tokens(venueName);
    if (!w.length || !v.length) return 0;
    if (w.join('') === v.join('')) return 1;
    const hits = w.filter(x => v.includes(x)).length;
    return hits / Math.max(w.length, 1) * 0.9;
  }

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatDate(date) {
    if (!DATE_RE.test(date)) return '';
    const [y, m, d] = date.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return DAYS[wd] + ', ' + MONTHS[m - 1] + ' ' + d;
  }

  function formatTime(time) {
    if (!TIME_RE.test(time)) return 'Time TBA';
    let [h, m] = time.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  function money(n, currency) {
    const v = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return currency === 'USD' ? '$' + v : v + ' ' + currency;
  }

  function formatPrice(price) {
    if (!price) return 'Price not listed';
    if (price.min === price.max) return money(price.min, price.currency);
    return money(price.min, price.currency) + '–' + money(price.max, price.currency);
  }

  /** Sort key for date then time (TBA last within a day). */
  function whenKey(e) { return e.date + 'T' + (e.time || '99:99'); }

  /** Same show listed by two sources? Same watched venue and date are checked by the caller. */
  function sameShow(a, b) {
    const m = Math.max(nameMatch(a.name, b.name), nameMatch(b.name, a.name));
    if (a.time && b.time) return a.time === b.time && m >= 0.3;
    return m >= 0.6;
  }

  /** Events for the watched venues between two YYYY-MM-DD dates. Venue-site events come first;
      a Ticketmaster listing of the same show fills in missing price/link/time instead of repeating it. */
  function mergeEvents(venues, siteEvents, tmEvents, fromDate, toDate) {
    const byLocal = new Map(), byTm = new Map();
    for (const v of venues || []) {
      if (v.localId) byLocal.set(v.localId, v);
      if (v.tmId) byTm.set(v.tmId, v);
    }
    const out = [], slots = new Map();
    const inRange = e => e.date >= fromDate && e.date <= toDate && e.status !== 'cancelled';
    for (const raw of siteEvents || []) {
      const v = byLocal.get(raw.venueId);
      if (!v || !inRange(raw)) continue;
      const e = { ...raw, watchId: v.id, venueName: v.name, source: 'site' };
      out.push(e);
      const k = v.id + '|' + e.date;
      if (!slots.has(k)) slots.set(k, []);
      slots.get(k).push(e);
    }
    for (const raw of tmEvents || []) {
      const v = byTm.get(raw.venueId);
      if (!v || !inRange(raw)) continue;
      const twin = (slots.get(v.id + '|' + raw.date) || []).find(s => s.source !== 'both' && sameShow(s, raw));
      if (twin) {
        twin.source = 'both';
        if (!twin.price && raw.price) twin.price = raw.price;
        if (!twin.url) twin.url = raw.url;
        if (!twin.time) twin.time = raw.time;
        if (!twin.genres.length) twin.genres = raw.genres;
        if (twin.kind === 'other' && raw.kind !== 'other') twin.kind = raw.kind;
        if (!twin.acts.length) twin.acts = raw.acts;
        continue;
      }
      out.push({ ...raw, watchId: v.id, venueName: v.name, source: 'tm' });
    }
    return out.sort((a, b) => (whenKey(a) < whenKey(b) ? -1 : whenKey(a) > whenKey(b) ? 1 : 0));
  }

  /** Local calendar date YYYY-MM-DD for a timestamp (browser's time zone). */
  function localDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  return {
    BUILD, kindOf, genresOf, normalizeEvent, cleanEvent, normalizeVenue, distanceMiles, geohash,
    nameVariants, nameMatch, formatDate, formatTime, formatPrice, whenKey, sameShow, mergeEvents, localDate, str, num
  };
});
