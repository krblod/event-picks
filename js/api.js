/* Event Picks: Ticketmaster Discovery API v2 client.
   Throttled to stay under 5 requests/second; retries on HTTP 429. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./events.js'));
  else root.EPApi = factory(root.EPEvents);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const BASE = 'https://app.ticketmaster.com/discovery/v2/';
  const PAGE_SIZE = 200;
  const MAX_DEEP = 1000; // the API refuses size * page beyond 1000

  class ApiError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; }
  }

  /** ISO time without milliseconds, as the API requires: 2026-11-21T08:00:00Z */
  function isoNoMillis(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  function buildUrl(path, params, apiKey) {
    const u = new URL(path, BASE);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    u.searchParams.set('apikey', apiKey);
    return u.href;
  }

  function createClient(opts) {
    const apiKey = opts && opts.apiKey;
    const fetchFn = (opts && opts.fetch) || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const sleep = (opts && opts.sleep) || (ms => new Promise(r => setTimeout(r, ms)));
    const now = (opts && opts.now) || Date.now;
    const gapMs = opts && typeof opts.gapMs === 'number' ? opts.gapMs : 250;
    let lastAt = -Infinity;

    async function get(path, params) {
      if (!apiKey) throw new ApiError('key', 'Add your Ticketmaster API key in Settings first.');
      const url = buildUrl(path, params, apiKey);
      for (let attempt = 0; ; attempt++) {
        const wait = lastAt + gapMs - now();
        if (wait > 0) await sleep(wait);
        lastAt = now();
        let res;
        try {
          res = await fetchFn(url, { headers: { Accept: 'application/json' }, referrerPolicy: 'no-referrer' });
        } catch (e) {
          throw new ApiError('network', 'Could not reach Ticketmaster. Check your connection and try again.');
        }
        if (res.status === 429 && attempt < 2) { await sleep(1200 * (attempt + 1)); continue; }
        if (res.status === 401 || res.status === 403) {
          throw new ApiError('key', 'Ticketmaster did not accept the API key. Check it in Settings.', res.status);
        }
        if (res.status === 429) throw new ApiError('rate', 'Ticketmaster says too many requests. Wait a minute and try again.', 429);
        if (!res.ok) throw new ApiError('http', 'Ticketmaster returned an error (HTTP ' + res.status + ').', res.status);
        try { return await res.json(); } catch (e) {
          throw new ApiError('bad', 'Ticketmaster sent a response that could not be read.', res.status);
        }
      }
    }

    /** Quick key check: one tiny request. */
    async function testKey() {
      await get('events.json', { size: 1 });
      return true;
    }

    /** mode 'near': around the city centre (crosses state lines); mode 'state': whole state. */
    async function searchVenues(keyword, city, mode) {
      const params = { keyword, size: 50, countryCode: city.country };
      if (mode === 'state') params.stateCode = city.state;
      else Object.assign(params, { geoPoint: E.geohash(city.lat, city.lon, 9), radius: city.radius, unit: 'miles' });
      const data = await get('venues.json', params);
      const list = data && data._embedded && Array.isArray(data._embedded.venues) ? data._embedded.venues : [];
      return list.map(E.normalizeVenue).filter(Boolean);
    }

    /** Try name variants until a venue within the radius turns up. Candidates best match first.
        The distance is always re-checked here, whatever the API did with geoPoint. */
    async function findVenue(wanted, city) {
      const tried = [];
      const modes = city.state ? ['near', 'state'] : ['near'];
      for (const keyword of E.nameVariants(wanted)) {
        for (const mode of modes) {
          tried.push(keyword);
          const found = await searchVenues(keyword, city, mode);
          const near = found.map(v => ({ ...v, miles: E.distanceMiles(city.lat, city.lon, v.lat, v.lon) }))
            .filter(v => v.miles == null ? (v.state === city.state && !!city.state) : v.miles <= city.radius)
            .map(v => ({ ...v, match: E.nameMatch(wanted, v.name) }))
            .sort((a, b) => b.match - a.match || (a.miles ?? 999) - (b.miles ?? 999));
          if (near.length) return { wanted, tried: [...new Set(tried)], candidates: near.slice(0, 8) };
        }
      }
      return { wanted, tried: [...new Set(tried)], candidates: [] };
    }

    /** Every Ticketmaster venue within the radius, nearest first. */
    async function nearbyVenues(city) {
      const seen = new Map();
      for (let page = 0; page < 3; page++) {
        const data = await get('venues.json', {
          size: 100, page, countryCode: city.country,
          geoPoint: E.geohash(city.lat, city.lon, 9), radius: city.radius, unit: 'miles'
        });
        const list = data && data._embedded && Array.isArray(data._embedded.venues) ? data._embedded.venues : [];
        for (const raw of list) {
          const v = E.normalizeVenue(raw);
          if (!v) continue;
          const miles = E.distanceMiles(city.lat, city.lon, v.lat, v.lon);
          if (miles != null && miles <= city.radius) seen.set(v.id, { ...v, miles });
        }
        const totalPages = data && data.page && E.num(data.page.totalPages);
        if (!list.length || totalPages == null || page + 1 >= totalPages) break;
      }
      return [...seen.values()].sort((a, b) => a.miles - b.miles);
    }

    /** Ticketmaster id for a known venue: '' when there is no confident match nearby. */
    async function linkVenue(venue, city) {
      const r = await findVenue(venue.name, city);
      const best = r.candidates.find(c => c.match >= 0.8 &&
        (venue.lat == null || c.lat == null || E.distanceMiles(venue.lat, venue.lon, c.lat, c.lon) <= 0.3));
      return best ? best.id : '';
    }

    async function eventsForVenue(venueId, range) {
      const out = [];
      for (let page = 0; (page + 1) * PAGE_SIZE <= MAX_DEEP; page++) {
        const data = await get('events.json', {
          venueId, size: PAGE_SIZE, page, sort: 'date,asc',
          startDateTime: isoNoMillis(range.from), endDateTime: isoNoMillis(range.to)
        });
        const list = data && data._embedded && Array.isArray(data._embedded.events) ? data._embedded.events : [];
        for (const raw of list) { const e = E.normalizeEvent(raw); if (e) out.push(e); }
        const info = data && data.page;
        const totalPages = info && E.num(info.totalPages);
        if (!list.length || totalPages == null || page + 1 >= totalPages) break;
      }
      return out;
    }

    /** All upcoming events at the given venues. A key problem stops everything; other errors are per venue. */
    async function eventsForVenues(venues, range) {
      const byId = new Map(), errors = [];
      for (const v of venues) {
        try {
          for (const e of await eventsForVenue(v.id, range)) {
            if (!e.venueName) e.venueName = v.name;
            if (!e.venueId) e.venueId = v.id;
            byId.set(e.id, e);
          }
        } catch (err) {
          if (err instanceof ApiError && (err.code === 'key' || err.code === 'network')) throw err;
          errors.push(v.name + ': ' + err.message);
        }
      }
      const events = [...byId.values()]
        .filter(e => e.status !== 'cancelled')
        .sort((a, b) => E.whenKey(a) < E.whenKey(b) ? -1 : E.whenKey(a) > E.whenKey(b) ? 1 : 0);
      return { events, errors };
    }

    return { get, testKey, searchVenues, findVenue, nearbyVenues, linkVenue, eventsForVenue, eventsForVenues };
  }

  return { BASE, ApiError, createClient, buildUrl, isoNoMillis };
});
