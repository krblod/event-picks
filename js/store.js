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
      browse: defaultBrowse(),
      ui: { suggestKind: 'all', smallOnly: false, iosHintDone: false },
      digest: defaultDigest(),
      profile: { ratings: {}, likes: [], hidden: [], mixHint: -1 },
      cache: { fetchedAt: 0, venueKey: '', siteAt: '', events: [], errors: [] }
    };
  }

  const INTERVALS = ['weekly', 'biweekly', 'monthly', 'custom'];
  const WHENS = ['all', 'tonight', 'weekend', '7', '30'];
  const STARTS = ['any', 'matinee', 'by8', 'by9', 'late'];
  const PRICES = [0, 10, 20, 30, 50, 75, 100];

  /** Browse list settings. `days` = how far ahead to load; `weekdays` = day-of-week filter. */
  function defaultBrowse() {
    return { days: 90, kind: 'all', sort: 'date', when: 'all', venues: [], weekdays: [], start: 'any',
      maxPrice: 0, keepUnpriced: true, hideSoldOut: false, hideDisliked: false, likedOnly: false };
  }

  function cleanBrowse(b, d) {
    const src = b && typeof b === 'object' ? b : {};
    return {
      days: Math.round(clampNum(src.days, 7, 365, d.days)),
      kind: KIND_FILTERS.includes(src.kind) ? src.kind : 'all',
      sort: src.sort === 'venue' ? 'venue' : 'date',
      when: WHENS.includes(src.when) ? src.when : 'all',
      venues: [...new Set((Array.isArray(src.venues) ? src.venues : []).filter(v => typeof v === 'string' && ID_RE.test(v)))].slice(0, 80),
      weekdays: [...new Set((Array.isArray(src.weekdays) ? src.weekdays : []).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort(),
      start: STARTS.includes(src.start) ? src.start : 'any',
      maxPrice: PRICES.includes(src.maxPrice) ? src.maxPrice : 0,
      keepUnpriced: src.keepUnpriced !== false,
      hideSoldOut: src.hideSoldOut === true,
      hideDisliked: src.hideDisliked === true,
      likedOnly: src.likedOnly === true
    };
  }
  function defaultDigest() {
    return { interval: 'monthly', customDays: 30, size: 10, musicShare: 50, latestStart: '', lastAt: 0, seen: {}, current: null };
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ACT_RE = /^[a-z0-9 ]{1,120}$/;

  /** seen: { groupKey: last show date shown }. Old format (array of keys) counts as seen for the
      whole 60-day digest window, so earlier picks do not come back. */
  function cleanSeen(src, today) {
    const out = {};
    if (Array.isArray(src)) {
      const until = E.localDate(Date.parse(today + 'T12:00:00') + 60 * 86400000);
      for (const k of src) { const key = E.str(k, 300); if (key) out[key] = until; }
    } else if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        const key = E.str(k, 300);
        if (key && DATE_RE.test(v) && v >= today) out[key] = v;   // past runs no longer matter
      }
    }
    const entries = Object.entries(out).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 3000);
    return Object.fromEntries(entries);
  }

  function cleanProfile(src) {
    const s = src && typeof src === 'object' ? src : {};
    const ratings = {};
    const list = s.ratings && typeof s.ratings === 'object' ? Object.entries(s.ratings) : [];
    for (const [k, r] of list) {
      if (!ACT_RE.test(k) || !r || typeof r !== 'object' || (r.v !== 1 && r.v !== -1)) continue;
      ratings[k] = {
        name: E.str(r.name, 200) || k, v: r.v,
        kind: ['music', 'comedy', 'other'].includes(r.kind) ? r.kind : 'other',
        at: Math.max(0, Math.floor(E.num(r.at) || 0)),
        genres: (Array.isArray(r.genres) ? r.genres : []).map(g => E.str(g, 60)).filter(Boolean).slice(0, 6),
        words: (Array.isArray(r.words) ? r.words : []).filter(w => typeof w === 'string' && /^[a-z0-9]{1,40}$/.test(w)).slice(0, 12),
        venue: optId(r.venue)
      };
    }
    const kept = Object.entries(ratings).sort((a, b) => b[1].at - a[1].at).slice(0, 2000);
    const likes = uniqueBy((Array.isArray(s.likes) ? s.likes : [])
      .map(l => (l && typeof l === 'object' ? { name: E.str(l.name, 100), at: Math.max(0, Math.floor(E.num(l.at) || 0)) } : null))
      .filter(l => l && l.name), l => l.name.toLowerCase()).slice(0, 200);
    const hidden = [...new Set((Array.isArray(s.hidden) ? s.hidden : []).map(x => E.str(x, 100)).filter(Boolean))].slice(-2000);
    const mh = E.num(s.mixHint);
    return { ratings: Object.fromEntries(kept), likes, hidden, mixHint: mh != null && mh >= 0 && mh <= 100 ? mh : -1 };
  }

  function cleanPick(p) {
    if (!p || typeof p !== 'object') return null;
    const key = E.str(p.key, 300), name = E.str(p.name, 200);
    const shows = (Array.isArray(p.shows) ? p.shows : []).map(E.cleanEvent).filter(Boolean).slice(0, 20);
    if (!key || !name || !shows.length) return null;
    return {
      key, name, shows,
      act: typeof p.act === 'string' && ACT_RE.test(p.act) ? p.act : '',
      kind: p.kind === 'comedy' ? 'comedy' : 'music',
      watchId: E.str(p.watchId, 100), venueName: E.str(p.venueName, 200),
      score: E.num(p.score) || 0,
      reasons: (Array.isArray(p.reasons) ? p.reasons : []).map(r => E.str(r, 60)).filter(Boolean).slice(0, 5),
      recurring: p.recurring === true
    };
  }

  function cleanDigest(src) {
    const d = defaultDigest();
    const s = src && typeof src === 'object' ? src : {};
    d.interval = INTERVALS.includes(s.interval) ? s.interval : 'monthly';
    d.customDays = Math.round(clampNum(s.customDays, 1, 180, 30));
    d.size = Math.round(clampNum(s.size, 3, 30, 10));
    d.musicShare = Math.round(clampNum(s.musicShare, 0, 100, 50) / 10) * 10;
    d.latestStart = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.latestStart) ? s.latestStart : '';
    d.lastAt = Math.max(0, Math.floor(E.num(s.lastAt) || 0));
    d.seen = cleanSeen(s.seen, E.localDate(Date.now()));
    const c = s.current && typeof s.current === 'object' ? s.current : null;
    if (c) {
      const n = o => Math.max(0, Math.floor(E.num(o) || 0));
      const counts = c.counts && typeof c.counts === 'object' ? c.counts : {}, want = c.want && typeof c.want === 'object' ? c.want : {};
      d.current = {
        createdAt: n(c.createdAt),
        picks: (Array.isArray(c.picks) ? c.picks : []).map(cleanPick).filter(Boolean).slice(0, 30),
        counts: { music: n(counts.music), comedy: n(counts.comedy) },
        want: { music: n(want.music), comedy: n(want.comedy) },
        short: (Array.isArray(c.short) ? c.short : []).filter(k => k === 'music' || k === 'comedy')
      };
    }
    return d;
  }

  /** Days between digests, for spreading picks. */
  function intervalDays(d) {
    return d.interval === 'weekly' ? 7 : d.interval === 'biweekly' ? 14 : d.interval === 'custom' ? d.customDays : 30;
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
    out.browse = cleanBrowse(src.browse, d.browse);
    const u = src.ui && typeof src.ui === 'object' ? src.ui : {};
    out.ui = {
      suggestKind: SUGGEST_FILTERS.includes(u.suggestKind) ? u.suggestKind : 'all',
      smallOnly: u.smallOnly === true,
      iosHintDone: u.iosHintDone === true
    };
    out.digest = cleanDigest(src.digest);
    out.profile = cleanProfile(src.profile);
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
      seeded: s.seeded, city: s.city, venues: s.venues, browse: s.browse, ui: s.ui,
      digest: { ...s.digest, current: null }, profile: s.profile
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
    const digest = data.digest && typeof data.digest === 'object' ? { ...data.digest, current: cur.digest.current } : cur.digest;
    return sanitize({ ...data, digest, seeded: true, apiKey: cur.apiKey, cache: cur.cache });
  }

  return { KEY, VERSION, PREFS, SEED, INTERVALS, PRICES, defaultBrowse, defaults, sanitize, cleanDigest, cleanProfile, cleanSeen, intervalDays, venueKey, cleanCatalog, cleanSiteData, seedVenues, fromCatalog, load, save, exportData, importData };
});
