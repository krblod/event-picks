/* Event Picks: settings and data kept in browser storage, plus JSON backup export/import.
   Everything loaded or imported goes through sanitize(); the venue catalog and nightly events
   file go through cleanCatalog() / cleanSiteData(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./events.js'));
  else root.EPStore = factory(root.EPEvents);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const KEY = 'eventPicks.v1';
  const VERSION = 1;
  const PREFS = ['love', 'normal', 'low'];
  const KIND_FILTERS = ['all', 'music', 'comedy', 'other'];
  const SUGGEST_FILTERS = ['all', 'music', 'comedy'];
  const SIZES = ['small', 'mid', 'large'];
  /** Venues the user named at the start; watched on first run when the catalog has them. */
  const SEED = ['pdx-revolution-hall', 'pdx-dantes', 'pdx-helium', 'pdx-aladdin'];
  const ID_RE = /^[A-Za-z0-9:_-]{1,100}$/;

  function defaults() {
    return {
      version: VERSION,
      apiKey: '',
      seeded: false,
      city: { name: 'Portland', state: 'OR', country: 'US', lat: 45.5152, lon: -122.6784, radius: 20 },
      venues: [],
      browse: { days: 90, kind: 'all' },
      ui: { suggestKind: 'all', smallOnly: false },
      cache: { fetchedAt: 0, venueKey: '', siteAt: '', events: [], errors: [] }
    };
  }

  function clampNum(v, lo, hi, dflt) {
    const n = E.num(v);
    return n == null ? dflt : Math.min(hi, Math.max(lo, n));
  }
  function coord(v, limit) { const n = E.num(v); return n != null && Math.abs(n) <= limit ? n : null; }
  function optId(v) { return typeof v === 'string' && ID_RE.test(v) ? v : ''; }

  /** Watched venue. localId = catalog id (venue-website listings); tmId = Ticketmaster id,
      '' when looked up and not found, null when not looked up yet. */
  function cleanVenue(v) {
    if (!v || typeof v !== 'object') return null;
    const name = E.str(v.name, 200);
    const localId = optId(v.localId);
    const tmId = v.tmId === null || v.tmId === undefined ? (localId ? null : '') : optId(v.tmId);
    const id = optId(v.id) || localId || (tmId ? 'tm:' + tmId : '');
    if (!id || !name || (!localId && !tmId)) return null;
    return {
      id, name, localId, tmId,
      address: E.str(v.address, 200), city: E.str(v.city, 100), state: E.str(v.state, 10),
      lat: coord(v.lat, 90), lon: coord(v.lon, 180),
      pref: PREFS.includes(v.pref) ? v.pref : 'normal'
    };
  }

  function uniqueBy(list, keyFn) {
    const seen = new Set();
    return list.filter(x => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function sanitize(input) {
    const d = defaults();
    const src = input && typeof input === 'object' ? input : {};
    const out = d;
    out.apiKey = /^[A-Za-z0-9]{8,128}$/.test(src.apiKey) ? src.apiKey : '';
    out.seeded = src.seeded === true;

    const c = src.city && typeof src.city === 'object' ? src.city : {};
    out.city = {
      name: E.str(c.name, 100) || d.city.name,
      state: /^[A-Z]{2}$/.test(c.state) ? c.state : (c.state === '' ? '' : d.city.state),
      country: /^[A-Z]{2}$/.test(c.country) ? c.country : d.city.country,
      lat: clampNum(c.lat, -90, 90, d.city.lat),
      lon: clampNum(c.lon, -180, 180, d.city.lon),
      radius: Math.round(clampNum(c.radius, 1, 200, d.city.radius))
    };

    if (Array.isArray(src.venues)) {
      out.venues = uniqueBy(src.venues.map(cleanVenue).filter(Boolean), v => v.id).slice(0, 80);
    }
    const b = src.browse && typeof src.browse === 'object' ? src.browse : {};
    out.browse = {
      days: Math.round(clampNum(b.days, 7, 365, d.browse.days)),
      kind: KIND_FILTERS.includes(b.kind) ? b.kind : 'all'
    };
    const u = src.ui && typeof src.ui === 'object' ? src.ui : {};
    out.ui = {
      suggestKind: SUGGEST_FILTERS.includes(u.suggestKind) ? u.suggestKind : 'all',
      smallOnly: u.smallOnly === true
    };
    const ch = src.cache && typeof src.cache === 'object' ? src.cache : {};
    out.cache = {
      fetchedAt: Math.max(0, Math.floor(E.num(ch.fetchedAt) || 0)),
      venueKey: E.str(ch.venueKey, 4000),
      siteAt: E.str(ch.siteAt, 40),
      events: Array.isArray(ch.events) ? uniqueBy(ch.events.map(E.cleanEvent).filter(Boolean), e => e.id).slice(0, 3000) : [],
      errors: Array.isArray(ch.errors) ? ch.errors.map(x => E.str(x, 300)).filter(Boolean).slice(0, 50) : []
    };
    return out;
  }

  /** Watch-list fingerprint: when it changes, the cached Browse list is out of date. */
  function venueKey(venues) {
    return venues.map(v => v.id + '=' + (v.localId || '') + '/' + (v.tmId || '')).sort().join(',');
  }

  /** Validate data/venues.json. */
  function cleanCatalog(input) {
    const list = input && Array.isArray(input.venues) ? input.venues : [];
    const out = [];
    for (const v of list) {
      if (!v || typeof v !== 'object' || !/^[a-z0-9-]{1,60}$/.test(v.id)) continue;
      const name = E.str(v.name, 200);
      if (!name) continue;
      out.push({
        id: v.id, name,
        address: E.str(v.address, 200), city: E.str(v.city, 100), state: E.str(v.state, 10),
        lat: coord(v.lat, 90), lon: coord(v.lon, 180),
        kinds: (Array.isArray(v.kinds) ? v.kinds : []).filter(k => k === 'music' || k === 'comedy'),
        size: SIZES.includes(v.size) ? v.size : '',
        ticketing: E.str(v.ticketing, 40),
        hasSource: Array.isArray(v.sources) && v.sources.length > 0,
        tmLikely: v.tm === 'likely'
      });
    }
    return uniqueBy(out, v => v.id).slice(0, 500);
  }

  /** Validate data/events.json (written by the nightly job). */
  function cleanSiteData(input) {
    const src = input && typeof input === 'object' ? input : {};
    const status = {};
    if (src.venues && typeof src.venues === 'object') {
      for (const [id, s] of Object.entries(src.venues)) {
        if (!/^[a-z0-9-]{1,60}$/.test(id) || !s || typeof s !== 'object') continue;
        status[id] = { ok: s.ok === true, count: Math.max(0, Math.floor(E.num(s.count) || 0)), error: E.str(s.error, 300) };
      }
    }
    const generatedAt = typeof src.generatedAt === 'string' && !isNaN(Date.parse(src.generatedAt)) ? src.generatedAt : '';
    const events = Array.isArray(src.events)
      ? src.events.map(E.cleanEvent).filter(e => e && e.source === 'site' && e.id.startsWith('site:')) : [];
    return { generatedAt, status, events: events.slice(0, 20000) };
  }

  /** Add the starting venues once, when the catalog has loaded. Returns true when it changed state. */
  function seedVenues(state, catalog) {
    if (state.seeded || !catalog.length) return false;
    for (const id of SEED) {
      const c = catalog.find(x => x.id === id);
      if (c && !state.venues.some(v => v.localId === id)) state.venues.push(fromCatalog(c));
    }
    state.seeded = true;
    return true;
  }

  function fromCatalog(c) {
    return { id: c.id, localId: c.id, tmId: null, name: c.name, address: c.address, city: c.city, state: c.state, lat: c.lat, lon: c.lon, pref: 'normal' };
  }

  function load(storage) {
    try {
      const text = storage && storage.getItem(KEY);
      return sanitize(text ? JSON.parse(text) : null);
    } catch (e) {
      return sanitize(null);
    }
  }

  /** Returns true when saved; false when storage is unavailable or full. */
  function save(storage, state) {
    try {
      storage.setItem(KEY, JSON.stringify(sanitize(state)));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Backup file content. The API key and cached events are left out on purpose. */
  function exportData(state) {
    const s = sanitize(state);
    return JSON.stringify({
      app: 'event-picks', version: VERSION, exportedAt: new Date().toISOString(),
      seeded: s.seeded, city: s.city, venues: s.venues, browse: s.browse, ui: s.ui
    }, null, 2);
  }

  /** Parse a backup; keeps the current API key. Throws Error with a readable message. */
  function importData(text, current) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not a valid backup (not JSON).'); }
    if (!data || typeof data !== 'object' || data.app !== 'event-picks') {
      throw new Error('That file is not an Event Picks backup.');
    }
    if (typeof data.version !== 'number' || data.version > VERSION) {
      throw new Error('That backup was made by a newer version of Event Picks.');
    }
    const cur = sanitize(current);
    return sanitize({ ...data, seeded: true, apiKey: cur.apiKey, cache: cur.cache });
  }

  return { KEY, VERSION, PREFS, SEED, defaults, sanitize, venueKey, cleanCatalog, cleanSiteData, seedVenues, fromCatalog, load, save, exportData, importData };
});
