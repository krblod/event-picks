// Unit tests: node test/run-tests.js
'use strict';
const assert = require('assert');
const E = require('../js/events.js');
const S = require('../js/store.js');
const A = require('../js/api.js');
const F = require('./fixtures.js');

const R = require('../tools/readers.js');
const FE = require('../tools/fetch-events.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const CATALOG = { venues: [
  { id: 'pdx-revolution-hall', name: 'Revolution Hall', address: '1300 SE Stark St', city: 'Portland', state: 'OR', lat: 45.51913, lon: -122.65211, tz: 'America/Los_Angeles', kinds: ['music', 'comedy'], size: 'mid',
    sources: [{ type: 'wlcr', url: 'https://rh.example/wp-json/wlcr/v1/events/raw', venueName: 'Revolution Hall' }] },
  { id: 'pdx-show-bar', name: 'Show Bar at Revolution Hall', address: '1300 SE Stark St', city: 'Portland', state: 'OR', lat: 45.51913, lon: -122.65211, tz: 'America/Los_Angeles', kinds: ['music'], size: 'small',
    sources: [{ type: 'wlcr', url: 'https://rh.example/wp-json/wlcr/v1/events/raw', venueName: 'Show Bar at Revolution Hall' }] },
  { id: 'pdx-helium', name: 'Helium Comedy Club', address: '1510 SE 9th Ave', city: 'Portland', state: 'OR', lat: 45.51193, lon: -122.65643, tz: 'America/Los_Angeles', kinds: ['comedy'], size: 'small',
    sources: [{ type: 'jsonld', url: 'https://helium.example/events' }] },
  { id: 'pdx-dantes', name: "Dante's", address: '350 W Burnside St', city: 'Portland', state: 'OR', lat: 45.52294, lon: -122.67369, tz: 'America/Los_Angeles', kinds: ['music'], size: 'small', tm: 'likely', ticketing: 'TicketWeb', sources: [] }
] };

function siteEvent(sid, venueId, date, time, name, extra) {
  return { id: 'site:' + venueId + ':' + sid, name, date, time, url: '', status: '', venueId, venueName: '', kind: 'music', genres: [], acts: [], price: null, source: 'site', ...(extra || {}) };
}

// ---------- events.js ----------
test('kindOf: comedy beats segment, music segment, otherwise other', () => {
  assert.strictEqual(E.kindOf(F.COMEDY), 'comedy');
  assert.strictEqual(E.kindOf([{ segment: { name: 'Music' }, genre: { name: 'Rock' } }]), 'music');
  assert.strictEqual(E.kindOf([{ segment: { name: 'Music' } }, { genre: { name: 'Comedy' } }]), 'comedy');
  assert.strictEqual(E.kindOf(F.TALK), 'other');
  assert.strictEqual(E.kindOf(undefined), 'other');
  assert.strictEqual(E.kindOf([null, 5]), 'other');
});

test('genresOf skips Undefined/Other and duplicates', () => {
  assert.deepStrictEqual(E.genresOf([{ genre: { name: 'Rock' }, subGenre: { name: 'Indie Rock' } }, { genre: { name: 'Rock' } }]), ['Rock', 'Indie Rock']);
  assert.deepStrictEqual(E.genresOf(F.TALK), ['Spectacular']);
});

test('normalizeEvent: full event', () => {
  const raw = F.event('ev1', 'Band A', '2026-12-05', '19:30:00', F.venues.revolution, {
    priceRanges: [{ type: 'standard', currency: 'USD', min: 25, max: 45 }, { type: 'vip', currency: 'USD', min: 80, max: 120 }],
    attractions: [{ id: 'a1', name: 'Band A', upcomingEvents: { _total: 30 } }, { id: 'a2', name: 'Opener B' }]
  });
  const e = E.normalizeEvent(raw);
  assert.strictEqual(e.id, 'ev1');
  assert.strictEqual(e.time, '19:30');
  assert.strictEqual(e.kind, 'music');
  assert.deepStrictEqual(e.price, { min: 25, max: 120, currency: 'USD' });
  assert.strictEqual(e.venueId, 'KovZpZA1');
  assert.strictEqual(e.acts.length, 2);
  assert.strictEqual(e.acts[0].upcoming, 30);
  assert.strictEqual(e.acts[1].upcoming, 0);
  assert.strictEqual(e.status, 'onsale');
});

test('normalizeEvent: missing time, price, url; bad input', () => {
  const e = E.normalizeEvent(F.event('ev2', 'Comic C', '2026-12-06', undefined, F.venues.helium, { classifications: F.COMEDY, url: 'http://insecure.example/x' }));
  assert.strictEqual(e.time, '');
  assert.strictEqual(e.price, null);
  assert.strictEqual(e.url, '');
  assert.strictEqual(e.kind, 'comedy');
  assert.strictEqual(E.normalizeEvent(null), null);
  assert.strictEqual(E.normalizeEvent({ id: 'x' }), null);
  assert.strictEqual(E.normalizeEvent({ id: 'x', dates: { start: { localDate: '12/05/2026' } } }), null);
  const jsUrl = E.normalizeEvent(F.event('ev3', 'X', '2026-12-06', '20:00:00', F.venues.helium, { url: 'javascript:alert(1)' }));
  assert.strictEqual(jsUrl.url, '');
});

test('normalizeEvent: only min or only max price', () => {
  const a = E.normalizeEvent(F.event('p1', 'X', '2026-12-06', '20:00:00', F.venues.dantes, { priceRanges: [{ currency: 'USD', min: 20 }] }));
  assert.deepStrictEqual(a.price, { min: 20, max: 20, currency: 'USD' });
  const b = E.normalizeEvent(F.event('p2', 'X', '2026-12-06', '20:00:00', F.venues.dantes, { priceRanges: [{ currency: 'USD', max: '35.5' }] }));
  assert.deepStrictEqual(b.price, { min: 35.5, max: 35.5, currency: 'USD' });
  const c = E.normalizeEvent(F.event('p3', 'X', '2026-12-06', '20:00:00', F.venues.dantes, { priceRanges: [{ currency: 'USD', min: -5 }] }));
  assert.strictEqual(c.price, null);
});

test('cleanEvent rejects junk and keeps valid cached events', () => {
  const e = E.normalizeEvent(F.event('ev1', 'Band A', '2026-12-05', '19:30:00', F.venues.revolution));
  assert.deepStrictEqual(E.cleanEvent(JSON.parse(JSON.stringify(e))), e);
  const bad = E.cleanEvent({ ...e, kind: 'evil', time: '25:99:00', url: 'data:text/html,x', price: { min: 10, max: 5 }, status: '<b>' });
  assert.strictEqual(bad.kind, 'other');
  assert.strictEqual(bad.time, '');
  assert.strictEqual(bad.url, '');
  assert.strictEqual(bad.price, null);
  assert.strictEqual(bad.status, '');
});

test('normalizeVenue', () => {
  const v = E.normalizeVenue(F.venues.dantes);
  assert.deepStrictEqual(v, { id: 'KovZpZA2', name: "Dante's", address: '350 W Burnside St', city: 'Portland', state: 'OR', lat: 45.5231, lon: -122.6729, upcoming: 22 });
  assert.strictEqual(E.normalizeVenue({ id: 'x' }), null);
  const noCount = E.normalizeVenue({ id: 'v', name: 'V' });
  assert.strictEqual(noCount.upcoming, null);
  assert.strictEqual(noCount.lat, null);
});

test('distanceMiles: Portland to Vancouver WA about 8 miles; missing coords', () => {
  const d = E.distanceMiles(45.5152, -122.6784, 45.6387, -122.6615);
  assert.ok(d > 8 && d < 9.5, String(d));
  assert.strictEqual(E.distanceMiles(45, -122, null, 1), null);
});

test('geohash known value', () => {
  assert.strictEqual(E.geohash(57.64911, 10.40744, 9), 'u4pruydqq');
  assert.strictEqual(E.geohash(45.5152, -122.6784, 5), 'c20fb');
});

test('nameVariants and nameMatch', () => {
  assert.deepStrictEqual(E.nameVariants("Dante's"), ["Dante's", 'dantes']);
  assert.deepStrictEqual(E.nameVariants('Helium Comedy Club'), ['Helium Comedy Club', 'helium']);
  assert.deepStrictEqual(E.nameVariants('Nova PDX'), ['Nova PDX', 'nova']);
  assert.deepStrictEqual(E.nameVariants('Revolution Hall'), ['Revolution Hall', 'revolution']);
  assert.strictEqual(E.nameMatch("Dante's", 'Dantes'), 1);
  assert.ok(E.nameMatch('Helium Comedy Club', 'Helium Comedy Club - Portland') > 0.8);
  assert.strictEqual(E.nameMatch('Aladdin Theater', 'Crystal Ballroom'), 0);
});

test('formatDate, formatTime, formatPrice', () => {
  assert.strictEqual(E.formatDate('2026-12-05'), 'Sat, Dec 5');
  assert.strictEqual(E.formatDate('bad'), '');
  assert.strictEqual(E.formatTime('19:30'), '7:30 PM');
  assert.strictEqual(E.formatTime('00:05'), '12:05 AM');
  assert.strictEqual(E.formatTime('12:00'), '12:00 PM');
  assert.strictEqual(E.formatTime(''), 'Time TBA');
  assert.strictEqual(E.formatPrice(null), 'Price not listed');
  assert.strictEqual(E.formatPrice({ min: 25, max: 25, currency: 'USD' }), '$25');
  assert.strictEqual(E.formatPrice({ min: 25, max: 39.5, currency: 'USD' }), '$25–$39.50');
  assert.strictEqual(E.formatPrice({ min: 30, max: 30, currency: 'CAD' }), '30 CAD');
});

// ---------- store.js ----------
function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

test('defaults: Portland, 20 miles, nothing watched until seeded', () => {
  const s = S.load(memStorage());
  assert.strictEqual(s.city.name, 'Portland');
  assert.strictEqual(s.city.radius, 20);
  assert.strictEqual(s.venues.length, 0);
  assert.strictEqual(s.seeded, false);
});

test('save/load round trip keeps venue sources', () => {
  const st = memStorage();
  const s = S.defaults();
  s.apiKey = 'abcDEF1234567890';
  s.venues.push({ id: 'pdx-revolution-hall', localId: 'pdx-revolution-hall', tmId: null, name: 'Revolution Hall', pref: 'love', lat: 45.5, lon: -122.6 });
  s.venues.push({ id: 'tm:KovZ1', localId: '', tmId: 'KovZ1', name: 'Some Club' });
  s.venues.push({ id: 'pdx-x', localId: 'pdx-x', tmId: '', name: 'Not on TM' });
  assert.ok(S.save(st, s));
  const back = S.load(st);
  assert.strictEqual(back.apiKey, 'abcDEF1234567890');
  assert.strictEqual(back.venues[0].pref, 'love');
  assert.strictEqual(back.venues[0].tmId, null);
  assert.strictEqual(back.venues[1].tmId, 'KovZ1');
  assert.strictEqual(back.venues[2].tmId, '');
});

test('cleanVenue: needs a source; old-style TM venue gets an id', () => {
  const s = S.sanitize({ venues: [
    { id: 'x', name: 'No source' },
    { name: 'TM only', tmId: 'K1' },
    { id: 'bad id!', localId: 'pdx-a', name: 'A' }
  ] });
  assert.deepStrictEqual(s.venues.map(v => v.id), ['tm:K1', 'pdx-a']);
});

test('seedVenues: watches the named venues once, only those in the catalog', () => {
  const cat = S.cleanCatalog(CATALOG);
  const s = S.defaults();
  assert.strictEqual(S.seedVenues(s, cat), true);
  assert.deepStrictEqual(s.venues.map(v => v.id), ['pdx-revolution-hall', 'pdx-dantes', 'pdx-helium']);
  assert.strictEqual(s.venues[0].tmId, null);
  s.venues = [];
  assert.strictEqual(S.seedVenues(s, cat), false);
  assert.strictEqual(s.venues.length, 0);
  assert.strictEqual(S.seedVenues(S.defaults(), []), false);
});

test('cleanCatalog validates entries', () => {
  const cat = S.cleanCatalog({ venues: [
    ...CATALOG.venues,
    { id: 'Bad ID', name: 'x' }, { id: 'no-name' }, null,
    { id: 'pdx-odd', name: 'Odd', kinds: ['music', 'opera'], size: 'huge', lat: 999, sources: 'nope', tm: 'yes' }
  ] });
  assert.strictEqual(cat.length, CATALOG.venues.length + 1);
  const odd = cat.find(c => c.id === 'pdx-odd');
  assert.deepStrictEqual(odd.kinds, ['music']);
  assert.strictEqual(odd.size, '');
  assert.strictEqual(odd.lat, null);
  assert.strictEqual(odd.hasSource, false);
  assert.strictEqual(odd.tmLikely, false);
  assert.strictEqual(cat.find(c => c.id === 'pdx-helium').hasSource, true);
  assert.strictEqual(cat.find(c => c.id === 'pdx-dantes').tmLikely, true);
});

test('cleanSiteData keeps only site events and valid status', () => {
  const d = S.cleanSiteData({
    generatedAt: '2026-11-21T11:30:00.000Z',
    venues: { 'pdx-helium': { ok: true, count: 2 }, 'BAD': { ok: true }, 'pdx-x': { ok: false, count: 0, error: 'HTTP 500' } },
    events: [siteEvent('a', 'pdx-helium', '2026-12-01', '19:00', 'Comic'), { ...siteEvent('b', 'pdx-helium', '2026-12-01', '19:00', 'X'), id: 'tmlike' }, { junk: 1 }]
  });
  assert.strictEqual(d.generatedAt, '2026-11-21T11:30:00.000Z');
  assert.deepStrictEqual(Object.keys(d.status), ['pdx-helium', 'pdx-x']);
  assert.strictEqual(d.status['pdx-x'].error, 'HTTP 500');
  assert.deepStrictEqual(d.events.map(e => e.id), ['site:pdx-helium:a']);
  assert.strictEqual(S.cleanSiteData(null).events.length, 0);
});

test('load survives corrupt JSON and throwing storage', () => {
  const st = memStorage();
  st.setItem(S.KEY, '{not json');
  assert.strictEqual(S.load(st).city.name, 'Portland');
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.strictEqual(S.load(boom).city.radius, 20);
  assert.strictEqual(S.save(boom, S.defaults()), false);
});

test('sanitize clamps and drops bad values', () => {
  const s = S.sanitize({
    apiKey: 'has spaces!', city: { name: 'X', state: 'oregon', lat: 999, lon: 'a', radius: 5000 },
    venues: [{ id: 'a', localId: 'a', name: 'A', pref: 'adore' }, { id: 'a', localId: 'a', name: 'dup' }, { name: 'no id' }, 'junk'],
    browse: { days: 3, kind: 'jazz' }, ui: { suggestKind: 'opera', smallOnly: 'yes' },
    cache: { events: [{ id: 'e', date: '2026-12-01', name: 'ok' }, { id: 'f' }], fetchedAt: -5 }
  });
  assert.deepStrictEqual(s.ui, { suggestKind: 'all', smallOnly: false });
  assert.strictEqual(s.apiKey, '');
  assert.strictEqual(s.city.state, 'OR');
  assert.strictEqual(s.city.lat, 90);
  assert.strictEqual(s.city.lon, -122.6784);
  assert.strictEqual(s.city.radius, 200);
  assert.strictEqual(s.venues.length, 1);
  assert.strictEqual(s.venues[0].pref, 'normal');
  assert.deepStrictEqual(s.browse, { days: 7, kind: 'all' });
  assert.strictEqual(s.cache.events.length, 1);
  assert.strictEqual(s.cache.fetchedAt, 0);
});

test('export leaves out the API key and cache; import keeps the current key', () => {
  const s = S.defaults();
  s.apiKey = 'SECRETkey12345678';
  s.venues.push({ id: 'pdx-dantes', localId: 'pdx-dantes', tmId: 'K2', name: 'Dantes', pref: 'low' });
  s.cache.events.push({ id: 'e', date: '2026-12-01', name: 'x' });
  const text = S.exportData(s);
  assert.ok(!text.includes('SECRETkey'));
  assert.ok(!text.includes('"cache"'));
  const other = S.defaults();
  other.apiKey = 'OTHERkey987654321';
  const merged = S.importData(text, other);
  assert.strictEqual(merged.apiKey, 'OTHERkey987654321');
  assert.strictEqual(merged.venues[0].name, 'Dantes');
  assert.strictEqual(merged.venues[0].pref, 'low');
  assert.strictEqual(merged.venues[0].tmId, 'K2');
  assert.strictEqual(merged.seeded, true, 'import never re-seeds');
});

test('import rejects non-backups and newer versions', () => {
  assert.throws(() => S.importData('nope', S.defaults()), /not JSON/);
  assert.throws(() => S.importData('{"venues":[]}', S.defaults()), /not an Event Picks backup/);
  assert.throws(() => S.importData('{"app":"event-picks","version":99}', S.defaults()), /newer version/);
});

// ---------- api.js ----------
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const r = await handler(u, calls.length);
    const status = r.status || 200;
    return { status, ok: status >= 200 && status < 300, json: async () => { if (r.badJson) throw new SyntaxError('x'); return r.body; } };
  };
  fn.calls = calls;
  return fn;
}
const noSleep = { sleep: async () => {}, gapMs: 0 };
const CITY = { name: 'Portland', state: 'OR', country: 'US', lat: 45.5152, lon: -122.6784, radius: 20 };

test('isoNoMillis and buildUrl', () => {
  assert.strictEqual(A.isoNoMillis(Date.UTC(2026, 10, 21, 8, 0, 0, 123)), '2026-11-21T08:00:00Z');
  const u = new URL(A.buildUrl('events.json', { venueId: 'X', empty: '', none: null }, 'KEY'));
  assert.strictEqual(u.origin + u.pathname, 'https://app.ticketmaster.com/discovery/v2/events.json');
  assert.strictEqual(u.searchParams.get('apikey'), 'KEY');
  assert.strictEqual(u.searchParams.has('empty'), false);
});

test('no key: clear error, no request', async () => {
  const f = fakeFetch(() => ({ body: {} }));
  const c = A.createClient({ apiKey: '', fetch: f, ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'key');
  assert.strictEqual(f.calls.length, 0);
});

test('401 means bad key; 500 is an http error; bad JSON is reported', async () => {
  let c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ status: 401, body: { fault: {} } })), ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'key' && /did not accept/.test(e.message));
  c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ status: 500, body: {} })), ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'http' && e.status === 500);
  c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ badJson: true })), ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'bad');
});

test('network failure is reported as network error', async () => {
  const c = A.createClient({ apiKey: 'K', fetch: async () => { throw new TypeError('Failed to fetch'); }, ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'network');
});

test('429 is retried, then succeeds', async () => {
  const slept = [];
  const f = fakeFetch((u, n) => (n === 1 ? { status: 429, body: {} } : { body: F.eventsPage([]) }));
  const c = A.createClient({ apiKey: 'K', fetch: f, gapMs: 0, sleep: async ms => { slept.push(ms); } });
  assert.strictEqual(await c.testKey(), true);
  assert.strictEqual(f.calls.length, 2);
  assert.ok(slept.includes(1200));
});

test('429 three times gives a rate error', async () => {
  const f = fakeFetch(() => ({ status: 429, body: {} }));
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  await assert.rejects(c.testKey(), e => e.code === 'rate');
  assert.strictEqual(f.calls.length, 3);
});

test('requests are spaced by gapMs', async () => {
  let t = 1000;
  const slept = [];
  const f = fakeFetch(() => ({ body: F.eventsPage([]) }));
  const c = A.createClient({ apiKey: 'K', fetch: f, gapMs: 250, now: () => t, sleep: async ms => { slept.push(ms); t += ms; } });
  await c.testKey();
  t += 100;
  await c.testKey();
  assert.deepStrictEqual(slept, [150]);
});

test('findVenue: near search, filters by distance, best match first', async () => {
  const f = fakeFetch(u => {
    assert.strictEqual(u.pathname, '/discovery/v2/venues.json');
    return { body: F.venuesPage([F.venues.heliumPhilly, F.venues.revolution, F.venues.helium]) };
  });
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const r = await c.findVenue('Helium Comedy Club', CITY);
  assert.strictEqual(r.candidates[0].id, 'KovZpZA3');
  assert.ok(!r.candidates.some(v => v.id === 'KovZpZA9'), 'Philadelphia is out of range');
  assert.ok(r.candidates[0].miles < 5);
  const q = f.calls[0].searchParams;
  assert.strictEqual(q.get('keyword'), 'Helium Comedy Club');
  assert.strictEqual(q.get('geoPoint'), E.geohash(CITY.lat, CITY.lon, 9));
  assert.strictEqual(q.get('radius'), '20');
  assert.strictEqual(q.get('unit'), 'miles');
  assert.strictEqual(q.has('stateCode'), false);
});

test('findVenue: keeps a Vancouver WA venue inside the radius', async () => {
  const f = fakeFetch(() => ({ body: F.venuesPage([F.venues.vancouver]) }));
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const r = await c.findVenue('Revolution Hall Annex', CITY);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].state, 'WA');
});

test('findVenue: falls back to state search, then to simpler names', async () => {
  const f = fakeFetch(u => {
    const q = u.searchParams;
    if (q.get('keyword') === 'dantes' && q.get('stateCode') === 'OR') return { body: F.venuesPage([F.venues.dantes]) };
    return { body: {} };
  });
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const r = await c.findVenue("Dante's", CITY);
  assert.strictEqual(r.candidates[0].name, "Dante's");
  assert.deepStrictEqual(f.calls.map(u => [u.searchParams.get('keyword'), u.searchParams.has('stateCode')]),
    [["Dante's", false], ["Dante's", true], ['dantes', false], ['dantes', true]]);
  assert.deepStrictEqual(r.tried, ["Dante's", 'dantes']);
});

test('findVenue: nothing found lists what was tried', async () => {
  const c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ body: { page: { totalElements: 0 } } })), ...noSleep });
  const r = await c.findVenue('Nova PDX', CITY);
  assert.deepStrictEqual(r.candidates, []);
  assert.deepStrictEqual(r.tried, ['Nova PDX', 'nova']);
});

test('eventsForVenue pages through results with the right parameters', async () => {
  const v = F.venues.revolution;
  const f = fakeFetch(u => {
    const page = Number(u.searchParams.get('page'));
    return { body: F.eventsPage([F.event('e' + page, 'Show ' + page, '2026-12-0' + (page + 1), '20:00:00', v)], page, 3) };
  });
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const list = await c.eventsForVenue(v.id, { from: Date.UTC(2026, 10, 21), to: Date.UTC(2027, 1, 19) });
  assert.deepStrictEqual(list.map(e => e.id), ['e0', 'e1', 'e2']);
  const q = f.calls[0].searchParams;
  assert.strictEqual(q.get('venueId'), v.id);
  assert.strictEqual(q.get('size'), '200');
  assert.strictEqual(q.get('sort'), 'date,asc');
  assert.strictEqual(q.get('startDateTime'), '2026-11-21T00:00:00Z');
  assert.strictEqual(q.get('endDateTime'), '2027-02-19T00:00:00Z');
});

test('eventsForVenue stops at the API deep-paging limit', async () => {
  const v = F.venues.revolution;
  const f = fakeFetch(u => {
    const page = Number(u.searchParams.get('page'));
    return { body: F.eventsPage([F.event('e' + page, 'S', '2026-12-01', '20:00:00', v)], page, 50) };
  });
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  await c.eventsForVenue(v.id, { from: 0, to: 1 });
  assert.strictEqual(f.calls.length, 5);
});

test('eventsForVenues merges, sorts, drops cancelled, keeps per-venue errors', async () => {
  const f = fakeFetch(u => {
    const id = u.searchParams.get('venueId');
    if (id === F.venues.revolution.id) return { body: F.eventsPage([
      F.event('b', 'Late', '2026-12-05', '21:00:00', F.venues.revolution),
      F.event('x', 'Gone', '2026-12-04', '20:00:00', F.venues.revolution, { status: 'cancelled' })]) };
    if (id === F.venues.helium.id) return { body: F.eventsPage([
      F.event('a', 'Comic', '2026-12-05', '19:00:00', F.venues.helium, { classifications: F.COMEDY }),
      F.event('c', 'TBA show', '2026-12-05', undefined, F.venues.helium)]) };
    return { status: 500, body: {} };
  });
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const r = await c.eventsForVenues([{ id: F.venues.revolution.id, name: 'Revolution Hall' }, { id: F.venues.helium.id, name: 'Helium' }, { id: 'bad', name: 'Broken Venue' }], { from: 0, to: 1 });
  assert.deepStrictEqual(r.events.map(e => e.id), ['a', 'b', 'c']);
  assert.strictEqual(r.events[0].kind, 'comedy');
  assert.strictEqual(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith('Broken Venue:'));
});

test('eventsForVenues stops on a key error', async () => {
  const c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ status: 401, body: {} })), ...noSleep });
  await assert.rejects(c.eventsForVenues([{ id: 'v', name: 'V' }], { from: 0, to: 1 }), e => e.code === 'key');
});

test('nearbyVenues: within radius, nearest first, geo parameters', async () => {
  const f = fakeFetch(() => ({ body: F.venuesPage([F.venues.heliumPhilly, F.venues.aladdin, F.venues.dantes, F.venues.vancouver]) }));
  const c = A.createClient({ apiKey: 'K', fetch: f, ...noSleep });
  const list = await c.nearbyVenues(CITY);
  assert.deepStrictEqual(list.map(v => v.name), ["Dante's", 'Aladdin Theater', 'Revolution Hall Annex']);
  const q = f.calls[0].searchParams;
  assert.strictEqual(q.get('radius'), '20');
  assert.strictEqual(q.has('keyword'), false);
});

test('linkVenue: confident nearby match only', async () => {
  const c = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ body: F.venuesPage([F.venues.helium]) })), ...noSleep });
  assert.strictEqual(await c.linkVenue({ name: 'Helium Comedy Club', lat: 45.51193, lon: -122.65643 }, CITY), 'KovZpZA3');
  assert.strictEqual(await c.linkVenue({ name: 'Helium Comedy Club', lat: 45.56, lon: -122.70 }, CITY), '', 'too far from the known address');
  const c2 = A.createClient({ apiKey: 'K', fetch: fakeFetch(() => ({ body: F.venuesPage([F.venues.revolution]) })), ...noSleep });
  assert.strictEqual(await c2.linkVenue({ name: 'Show Bar at Revolution Hall', lat: 45.5195, lon: -122.6527 }, CITY), '', 'different room, weak name match');
});

// ---------- merging ----------
test('mergeEvents: site + Ticketmaster twin merged, others kept, filtered to watched and dates', () => {
  const venues = [
    { id: 'pdx-revolution-hall', localId: 'pdx-revolution-hall', tmId: 'TMRH', name: 'Revolution Hall' },
    { id: 'tm:TMD', localId: '', tmId: 'TMD', name: "Dante's" }
  ];
  const site = [
    siteEvent('1', 'pdx-revolution-hall', '2026-12-05', '20:00', 'Haley Heynderickx w/ Chamberlain'),
    siteEvent('2', 'pdx-revolution-hall', '2026-12-06', '20:00', 'Another Show', { price: { min: 20, max: 20, currency: 'USD' } }),
    siteEvent('3', 'pdx-helium', '2026-12-05', '19:00', 'Not watched'),
    siteEvent('4', 'pdx-revolution-hall', '2027-06-01', '20:00', 'Too far ahead')
  ];
  const tm = [
    { ...E.normalizeEvent(F.event('t1', 'Haley Heynderickx', '2026-12-05', '20:00:00', { id: 'TMRH', name: 'Revolution Hall' }, { priceRanges: [{ currency: 'USD', min: 40, max: 46 }] })) },
    { ...E.normalizeEvent(F.event('t2', 'Late Show', '2026-12-05', '22:30:00', { id: 'TMRH', name: 'Revolution Hall' })) },
    { ...E.normalizeEvent(F.event('t3', 'Punk Night', '2026-12-05', '21:00:00', { id: 'TMD', name: "Dante's" })) },
    { ...E.normalizeEvent(F.event('t4', 'Elsewhere', '2026-12-05', '21:00:00', { id: 'OTHER', name: 'X' })) }
  ];
  const out = E.mergeEvents(venues, site, tm, '2026-11-21', '2027-02-19');
  assert.deepStrictEqual(out.map(e => e.name), ['Haley Heynderickx w/ Chamberlain', 'Punk Night', 'Late Show', 'Another Show']);
  const twin = out[0];
  assert.strictEqual(twin.source, 'both');
  assert.deepStrictEqual(twin.price, { min: 40, max: 46, currency: 'USD' });
  assert.ok(twin.url.includes('ticketmaster'));
  assert.strictEqual(out[1].watchId, 'tm:TMD');
  assert.strictEqual(out[1].source, 'tm');
  assert.strictEqual(out[3].price.min, 20);
});

test('sameShow: early and late shows are different; missing time needs a closer name', () => {
  const a = { name: 'Comic Name', time: '19:00' }, b = { name: 'Comic Name', time: '21:30' };
  assert.strictEqual(E.sameShow(a, b), false);
  assert.strictEqual(E.sameShow(a, { name: 'Comic Name Live', time: '19:00' }), true);
  assert.strictEqual(E.sameShow({ name: 'Band', time: '' }, { name: 'Band', time: '20:00' }), true);
  assert.strictEqual(E.sameShow({ name: 'Band One', time: '' }, { name: 'Other Two', time: '20:00' }), false);
});

// ---------- readers (nightly job) ----------
test('parseWhen: local, UTC, offsets, odd offsets, date only, DST', () => {
  const tz = 'America/Los_Angeles';
  assert.deepStrictEqual(R.parseWhen('2026-11-21T19:30:00', tz), { date: '2026-11-21', time: '19:30' });
  assert.deepStrictEqual(R.parseWhen('2026-11-21 20:00:00', tz), { date: '2026-11-21', time: '20:00' });
  assert.deepStrictEqual(R.parseWhen('2026-11-22T03:00:00Z', tz), { date: '2026-11-21', time: '19:00' });
  assert.deepStrictEqual(R.parseWhen('2026-11-21T21:00:00-08:00', tz), { date: '2026-11-21', time: '21:00' });
  assert.deepStrictEqual(R.parseWhen('2026-11-25T21:30:00.000-08:00', tz), { date: '2026-11-25', time: '21:30' });
  assert.deepStrictEqual(R.parseWhen('2026-11-21T13:00-8:00', tz), { date: '2026-11-21', time: '13:00' });
  assert.deepStrictEqual(R.parseWhen('2026-07-04T03:00:00Z', tz), { date: '2026-07-03', time: '20:00' });
  assert.deepStrictEqual(R.parseWhen('2026-11-21', tz), { date: '2026-11-21', time: '' });
  assert.strictEqual(R.parseWhen('Nov 21', tz), null);
  assert.strictEqual(R.parseWhen(undefined, tz), null);
});

test('priceFromText and decode', () => {
  assert.deepStrictEqual(R.priceFromText('$25 - $30'), { min: 25, max: 30 });
  assert.deepStrictEqual(R.priceFromText('Free – $15.28'), { min: 0, max: 15.28 });
  assert.deepStrictEqual(R.priceFromText('$7.00 (includes fees)'), { min: 7, max: 7 });
  assert.deepStrictEqual(R.priceFromText('FREE'), { min: 0, max: 0 });
  assert.strictEqual(R.priceFromText('Multiple prices'), null);
  assert.strictEqual(R.priceFromText(''), null);
  assert.strictEqual(R.decode('90&#8217;s <b>Dance</b> &amp; Flashback'), '90’s Dance & Flashback');
});

const WLCR = [
  { listed: true, start: { utc: '2026-11-22T03:30:00Z', local: '2026-11-21T19:30:00' }, name: { text: 'The Teacher Show: Comedy from the Classroom' }, url: 'https://www.etix.com/ticket/p/1/x',
    venue: { name: 'Polaris Hall' }, id: 1, ticket_availability: { minimum_ticket_price: { value: 32.36 }, maximum_ticket_price: { value: 32.36 }, is_sold_out: false }, status: 'onSale' },
  { listed: true, start: { local: '2026-11-22T20:00:00' }, name: { text: 'SOLD OUT: Haley Heynderickx w/ Chamberlain' }, url: 'https://www.etix.com/ticket/p/2/y',
    venue: { name: 'Revolution Hall' }, id: 2, ticket_availability: { minimum_ticket_price: { value: 40.29 }, maximum_ticket_price: { value: 45.93 } }, status: 'onSale' },
  { listed: true, start: { local: '2026-11-23T19:00:00' }, name: { text: 'Jazz Trio' }, url: 'https://www.etix.com/ticket/p/3/z',
    venue: { name: 'Show Bar at Revolution Hall' }, id: 3, ticket_availability: {}, status: 'cancelled' },
  { listed: false, start: { local: '2026-11-24T19:00:00' }, name: { text: 'Private' }, id: 4, venue: { name: 'Revolution Hall' } }
];

test('readWlcr', () => {
  const items = R.readWlcr(WLCR);
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items[0].price, { min: 32.36, max: 32.36 });
  assert.strictEqual(items[0].venueName, 'Polaris Hall');
  assert.strictEqual(items[2].status, 'cancelled');
  assert.throws(() => R.readWlcr({}), /unexpected/);
});

test('readTribe', () => {
  const items = R.readTribe({ events: [
    { id: 13051, title: '90&#8217;s Dance Flashback', start_date: '2026-11-21 20:00:00', all_day: false, cost: '', cost_details: { values: [] }, url: 'https://www.crystalballroompdx.com/events/1/', categories: [{ name: 'November' }] },
    { id: 13052, title: 'Band', start_date: '2026-11-22 20:00:00', cost: '$25 – $30', cost_details: { values: ['25', '30'] }, url: 'https://x.example/e', website: 'https://tickets.example/e' },
    { id: 13053, title: 'Festival', start_date: '2026-11-23 00:00:00', all_day: true, cost: 'Free' }
  ] });
  assert.strictEqual(items[0].name, '90’s Dance Flashback');
  assert.strictEqual(items[0].price, null);
  assert.deepStrictEqual(items[1].price, { min: 25, max: 30 });
  assert.strictEqual(items[1].url, 'https://tickets.example/e');
  assert.strictEqual(items[2].start, '2026-11-23');
  assert.deepStrictEqual(items[2].price, { min: 0, max: 0 });
});

test('readHolocene', () => {
  const items = R.readHolocene([
    { id: 80717807, name: 'Laffy Taffy - 21+', displayTitle: 'Laffy Taffy', dateTime: '2026-11-21T21:00:00-08:00', priceFrom: 0, priceTo: 15.28, priceDisplay: 'Free – $15.28', category: 'Club', ticketUrl: 'https://www.etix.com/ticket/p/80717807/x', availability: { status: 'available' }, support: 'Reserv' },
    { id: 2, name: 'Comedy Night', dateTime: '2026-11-22T20:00:00-08:00', priceFrom: null, priceTo: null, priceDisplay: '$12', category: 'Comedy', availability: { status: 'soldOut' } }
  ]);
  assert.strictEqual(items[0].name, 'Laffy Taffy');
  assert.deepStrictEqual(items[0].price, { min: 0, max: 15.28 });
  assert.deepStrictEqual(items[0].acts, ['Reserv']);
  assert.deepStrictEqual(items[1].price, { min: 12, max: 12 });
  assert.strictEqual(items[1].status, 'soldout');
});

test('readCrowdwork: one item per date, prices from tiers after fees, skips inactive', () => {
  const items = R.readCrowdwork({ data: [
    { id: 8880, name: 'Open Court - Improv Jam', status: 'active', dates: ['2026-11-25T21:30:00.000-08:00', '2026-12-02T21:30:00.000-08:00'],
      cost: { formatted: '$7.00 (includes fees)' }, cost_tiers: [{ cost: 500, cost_after_fees: 700 }], url: 'https://www.crowdwork.com/e/open-court' },
    { id: 9, name: 'Multi', status: 'active', dates: ['2026-11-26T19:00:00.000-08:00'], cost: { formatted: 'Multiple prices' },
      cost_tiers: [{ cost_after_fees: 700 }, { name: 'STUDENT', cost_after_fees: 0 }, { cost_after_fees: 1500 }], url: 'https://www.crowdwork.com/e/multi' },
    { id: 10, name: 'Old', status: 'inactive', dates: ['2026-11-26T19:00:00.000-08:00'] }
  ] });
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items[0].price, { min: 7, max: 7 });
  assert.notStrictEqual(items[0].sid, items[1].sid);
  assert.deepStrictEqual(items[2].price, { min: 7, max: 15 });
});

const HELIUM_HTML = '<html><head></head><body><section><script type="application/ld+json">' + JSON.stringify({
  ':@context': 'http://schema.org', '@type': 'Place', name: 'Helium Comedy Club',
  Events: [
    { '@type': 'Event', name: 'Special Event: K Trevor Wilson', startDate: '2026-11-22T03:00:00Z', url: 'https://portland.heliumcomedy.com/shows/389107', location: { '@type': 'Place', name: 'Helium Comedy Club' } },
    { '@type': 'ComedyEvent', name: 'Late &amp; Loud', startDate: '2026-11-22T05:30:00Z', url: 'https://portland.heliumcomedy.com/shows/389108', offers: [{ price: '25' }, { lowPrice: 20, highPrice: '35' }], eventStatus: 'https://schema.org/EventPostponed', performer: [{ name: 'A Comic' }] }
  ]
}) + '</script><script type="application/ld+json">{broken</script></section></body></html>';

test('readJsonLd: nested Events key, offers, status, broken blocks ignored', () => {
  const items = R.readJsonLd(HELIUM_HTML);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].sid, 'https://portland.heliumcomedy.com/shows/389107');
  assert.strictEqual(items[1].name, 'Late & Loud');
  assert.deepStrictEqual(items[1].price, { min: 20, max: 35 });
  assert.strictEqual(items[1].status, 'postponed');
  assert.deepStrictEqual(items[1].acts, ['A Comic']);
  assert.deepStrictEqual(R.readJsonLd('<p>no data</p>'), []);
});

test('toEvent: time zone, sold-out prefix, kind, https-only links, shape accepted by cleanEvent', () => {
  const venue = CATALOG.venues[0];
  const [polaris, soldOut] = R.readWlcr(WLCR);
  const a = R.toEvent(polaris, venue, 'wlcr');
  assert.strictEqual(a.kind, 'comedy');
  assert.strictEqual(a.time, '19:30');
  const b = R.toEvent(soldOut, venue, 'wlcr');
  assert.strictEqual(b.name, 'Haley Heynderickx w/ Chamberlain');
  assert.strictEqual(b.status, 'soldout');
  assert.strictEqual(b.kind, 'music');
  assert.strictEqual(b.id, 'site:pdx-revolution-hall:2');
  const clean = E.cleanEvent(JSON.parse(JSON.stringify(b)));
  assert.strictEqual(clean.source, 'site');
  assert.strictEqual(clean.status, 'soldout');
  const helium = R.toEvent(R.readJsonLd(HELIUM_HTML)[0], CATALOG.venues[2], 'jsonld');
  assert.deepStrictEqual([helium.date, helium.time, helium.kind], ['2026-11-21', '19:00', 'comedy']);
  assert.strictEqual(R.toEvent({ sid: 'x', name: 'Y', start: '2026-11-21T20:00:00', url: 'http://insecure.example/' }, venue, 'wlcr').url, '');
  assert.strictEqual(R.toEvent({ sid: 'x', name: 'Y', start: 'soon' }, venue, 'wlcr'), null);
  assert.strictEqual(R.toEvent({ sid: 'x', name: 'SOLD OUT', start: '2026-11-21T20:00:00' }, venue, 'wlcr').name, 'SOLD OUT');
});

test('robotsAllows', () => {
  const txt = 'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*?s=\n\nUser-agent: BadBot\nDisallow: /';
  assert.strictEqual(FE.robotsAllows(txt, '/wp-json/wlcr/v1/events/raw'), true);
  assert.strictEqual(FE.robotsAllows(txt, '/wp-admin/x'), false);
  assert.strictEqual(FE.robotsAllows(txt, '/wp-admin/admin-ajax.php'), true);
  assert.strictEqual(FE.robotsAllows(txt, '/page?s=hello'), false);
  assert.strictEqual(FE.robotsAllows('', '/anything'), true);
  assert.strictEqual(FE.robotsAllows('User-agent: EventPicksBot\nDisallow: /\n\nUser-agent: *\nAllow: /', '/x'), false);
  assert.strictEqual(FE.robotsAllows('User-agent: *\nDisallow:', '/x'), true);
});

function siteFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return routes.robots ? routes.robots(u) : { ok: false, status: 404, text: async () => '' };
    for (const [prefix, h] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const r = h(u);
        return { ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.body, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

test('fetch-events build: shared feed read once, split by venue, past/cancelled dropped, failures recorded', async () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0);
  const fetchFn = siteFetch({
    'https://rh.example/': () => ({ body: [...WLCR, { listed: true, start: { local: '2026-11-01T20:00:00' }, name: { text: 'Past' }, id: 9, venue: { name: 'Revolution Hall' } }] }),
    'https://helium.example/': () => ({ status: 503, body: 'down' })
  });
  const out = await FE.build(CATALOG, fetchFn, now);
  assert.strictEqual(fetchFn.calls.filter(u => u.includes('rh.example/wp-json')).length, 1, 'shared URL fetched once');
  assert.deepStrictEqual(out.venues['pdx-revolution-hall'], { ok: true, count: 1 });
  assert.deepStrictEqual(out.venues['pdx-show-bar'], { ok: true, count: 0 }, 'cancelled show dropped');
  assert.strictEqual(out.venues['pdx-helium'].ok, false);
  assert.ok(out.venues['pdx-helium'].error.includes('503'));
  assert.strictEqual(out.venues['pdx-dantes'], undefined, 'no sources, not listed');
  assert.deepStrictEqual(out.events.map(e => e.name), ['Haley Heynderickx w/ Chamberlain']);
  const browser = S.cleanSiteData(JSON.parse(JSON.stringify(out)));
  assert.strictEqual(browser.events.length, 1);
});

test('fetch-events build: robots.txt disallow is honoured', async () => {
  const fetchFn = siteFetch({
    robots: () => ({ ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /events' }),
    'https://rh.example/': () => ({ body: WLCR }),
    'https://helium.example/': () => ({ body: HELIUM_HTML })
  });
  const out = await FE.build(CATALOG, fetchFn, Date.UTC(2026, 10, 21));
  assert.strictEqual(out.venues['pdx-helium'].ok, false);
  assert.ok(out.venues['pdx-helium'].error.includes('robots.txt'));
  assert.ok(!fetchFn.calls.includes('https://helium.example/events'));
  assert.strictEqual(out.venues['pdx-revolution-hall'].ok, true);
});

test('fetch-events build: tribe pages followed on the same site only', async () => {
  const cat = { venues: [{ id: 'pdx-crystal', name: 'Crystal Ballroom', tz: 'America/Los_Angeles', kinds: ['music'], sources: [{ type: 'tribe', url: 'https://cb.example/wp-json/tribe/events/v1/events' }] }] };
  const fetchFn = siteFetch({
    'https://cb.example/': u => u.searchParams.get('page') === '2'
      ? { body: { events: [{ id: 2, title: 'Two', start_date: '2026-12-02 20:00:00' }], next_rest_url: 'https://evil.example/next' } }
      : { body: { events: [{ id: 1, title: 'One', start_date: '2026-12-01 20:00:00' }], next_rest_url: 'https://cb.example/wp-json/tribe/events/v1/events?page=2' } }
  });
  const out = await FE.build(cat, fetchFn, Date.UTC(2026, 10, 21));
  assert.deepStrictEqual(out.events.map(e => e.name), ['One', 'Two']);
  assert.ok(fetchFn.calls[1].includes('start_date=2026-11-21'));
  assert.ok(!fetchFn.calls.some(u => u.includes('evil.example')));
});

test('sameContent ignores generatedAt', () => {
  assert.ok(FE.sameContent({ generatedAt: 'a', events: [1] }, { generatedAt: 'b', events: [1] }));
  assert.ok(!FE.sameContent({ generatedAt: 'a', events: [1] }, { generatedAt: 'a', events: [2] }));
});

test('real catalog file is valid and every source type has a reader', () => {
  const raw = require('../data/venues.json');
  const cat = S.cleanCatalog(raw);
  assert.strictEqual(cat.length, raw.venues.length);
  for (const v of raw.venues) for (const s of v.sources) {
    assert.ok(R.READERS[s.type], v.id + ' uses unknown type ' + s.type);
    assert.ok(s.url.startsWith('https://'), v.id);
  }
  for (const id of S.SEED) assert.ok(cat.some(c => c.id === id), 'seed venue missing: ' + id);
});

// ---------- ranking and digest ----------
const Rk = require('../js/rank.js');

function ev(id, venue, date, time, name, kind, extra) {
  return { id, name, date, time, url: 'https://t.example/' + id, status: '', venueId: venue, watchId: venue, venueName: venue, kind, genres: [], acts: [], price: null, source: 'site', ...(extra || {}) };
}

test('isParticipatory: open mics, jams, classes, tours out; bands and world tours stay', () => {
  for (const n of ['Curious Comedy Open Mic', 'OPEN MIC hosted by JOHNNY', 'Open Court - Improv Jam', 'The Kickstand Improv Jam (for students & performers)',
    "The People's Jam (FREE)", 'Helium Comedy Academy: Stand-Up Workshop', 'An Improv Class Performance', 'Crystal Ballroom History & Art Tour', 'Bluegrass Jam Session', 'Karaoke From Hell']) {
    assert.ok(Rk.isParticipatory(n), n);
  }
  for (const n of ['Buffalo Traffic Jam', 'Pearl Jam Tribute', 'The Future Is Vintage World Tour', 'Sheryl Underwood: I Need A Job Tour', 'Jam Band Night Out', 'Classical Guitar Night']) {
    assert.ok(!Rk.isParticipatory(n), n);
  }
});

test('actKey and displayName group repeat shows', () => {
  assert.strictEqual(Rk.actKey('Special Event: K Trevor Wilson'), Rk.actKey('K Trevor Wilson'));
  assert.strictEqual(Rk.actKey('The Storm Large Holiday Ordeal (Night 1)'), Rk.actKey('The Storm Large Holiday Ordeal (Night 2)'));
  assert.strictEqual(Rk.actKey('Comic - 21+'), Rk.actKey('Comic'));
  assert.strictEqual(Rk.actKey('Comic (Late Show)'), Rk.actKey('Comic (Early Show)'));
  assert.notStrictEqual(Rk.actKey('Band A'), Rk.actKey('Band B'));
  assert.strictEqual(Rk.displayName('Special Event: Rhys Darby'), 'Rhys Darby');
  assert.strictEqual(Rk.displayName('The Storm Large Holiday Ordeal (Night 1)'), 'The Storm Large Holiday Ordeal');
});

const TODAY = '2026-11-21';
const VENUES = [{ id: 'rh', pref: 'normal' }, { id: 'he', pref: 'normal' }, { id: 'al', pref: 'normal' }];

test('buildDigest: groups repeats, drops sold out / late / participatory / other / seen / outside window', () => {
  const events = [
    ev('1', 'he', '2026-11-27', '19:00', 'Special Event: Rhys Darby', 'comedy'),
    ev('2', 'he', '2026-11-27', '21:30', 'Special Event: Rhys Darby', 'comedy'),
    ev('3', 'he', '2026-11-28', '19:00', 'Special Event: Rhys Darby', 'comedy'),
    ev('4', 'rh', '2026-11-25', '20:00', 'Sold Out Band', 'music', { status: 'soldout' }),
    ev('5', 'rh', '2026-11-26', '22:30', 'Late Band', 'music'),
    ev('6', 'he', '2026-11-26', '20:00', 'Open Mic Night', 'comedy'),
    ev('7', 'al', '2026-11-26', '20:00', 'Podcast Live', 'other'),
    ev('8', 'al', '2026-11-29', '20:00', 'Seen Before', 'music'),
    ev('9', 'al', '2027-03-01', '20:00', 'Far Away', 'music'),
    ev('10', 'al', '2026-11-30', '', 'Time TBA Band', 'music')
  ];
  const d = Rk.buildDigest({ events, venues: VENUES, today: TODAY, windowDays: 60, size: 10, musicShare: 50, latestStart: '22:00', seen: { 'al|seen before': '2026-11-29' } });
  assert.deepStrictEqual(d.picks.map(p => p.name), ['Rhys Darby', 'Time TBA Band']);
  assert.strictEqual(d.picks[0].shows.length, 3);
  assert.deepStrictEqual(d.picks[0].reasons, ['Special event']);
  assert.deepStrictEqual(d.short.sort(), ['comedy', 'music']);
});

test('buildDigest: honours the music/comedy ratio even with one comedy venue', () => {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(ev('m' + i, i % 2 ? 'rh' : 'al', '2026-12-' + String(1 + i).padStart(2, '0'), '20:00', 'Band ' + i, 'music'));
  for (let i = 0; i < 12; i++) events.push(ev('c' + i, 'he', '2026-12-' + String(1 + i).padStart(2, '0'), '19:00', 'Comic ' + i, 'comedy'));
  for (const share of [0, 30, 50, 80, 100]) {
    const d = Rk.buildDigest({ events, venues: VENUES, today: TODAY, windowDays: 60, intervalDays: 7, size: 10, musicShare: share });
    assert.deepStrictEqual(d.counts, { music: share / 10, comedy: 10 - share / 10 }, 'share ' + share);
    assert.deepStrictEqual(d.short, []);
  }
});

test('buildDigest: a kind running short is filled with the other kind', () => {
  const events = [ev('c1', 'he', '2026-12-01', '19:00', 'Comic', 'comedy')];
  for (let i = 0; i < 9; i++) events.push(ev('m' + i, 'rh', '2026-12-0' + (1 + i), '20:00', 'Band ' + i, 'music'));
  const d = Rk.buildDigest({ events, venues: VENUES, today: TODAY, windowDays: 60, intervalDays: 7, size: 6, musicShare: 0 });
  assert.deepStrictEqual(d.counts, { music: 5, comedy: 1 });
  assert.deepStrictEqual(d.short, ['comedy']);
});

test('buildDigest: favourite venue and bigger shows rank higher; low venue and weekly residencies lower', () => {
  const venues = [{ id: 'rh', pref: 'love' }, { id: 'al', pref: 'low' }, { id: 'he', pref: 'normal' }];
  const events = [
    ev('a', 'al', '2026-11-22', '20:00', 'Low Venue Band', 'music'),
    ev('b', 'rh', '2026-12-10', '20:00', 'Loved Venue Band', 'music'),
    ev('c', 'he', '2026-11-23', '20:00', 'Cheap Band', 'music', { price: { min: 10, max: 10, currency: 'USD' } }),
    ev('d', 'he', '2026-11-24', '20:00', 'Big Band', 'music', { price: { min: 60, max: 80, currency: 'USD' }, acts: [{ id: 'x', name: 'Big Band', upcoming: 40 }] }),
    ev('r1', 'he', '2026-11-25', '20:00', 'House Show', 'music'), ev('r2', 'he', '2026-12-02', '20:00', 'House Show', 'music'),
    ev('r3', 'he', '2026-12-09', '20:00', 'House Show', 'music'), ev('r4', 'he', '2026-12-16', '20:00', 'House Show', 'music')
  ];
  const d = Rk.buildDigest({ events, venues, today: TODAY, windowDays: 60, intervalDays: 7, size: 5, musicShare: 100 });
  const order = [...d.picks].sort((a, b) => b.score - a.score).map(p => p.name);
  assert.deepStrictEqual(order, ['Big Band', 'Loved Venue Band', 'Cheap Band', 'Low Venue Band', 'House Show']);
  const big = d.picks.find(p => p.name === 'Big Band');
  assert.deepStrictEqual(big.reasons, ['Touring act']);
  assert.ok(d.picks.find(p => p.name === 'House Show').recurring);
  assert.deepStrictEqual(d.picks.find(p => p.name === 'Loved Venue Band').reasons, ['Favourite venue']);
});

test('buildDigest: monthly interval spreads picks over the weeks; at most 2 a night', () => {
  const events = [];
  for (let day = 22; day <= 30; day++) for (let k = 0; k < 3; k++) events.push(ev('n' + day + k, ['rh', 'al', 'he'][k], '2026-11-' + day, '20:00', 'Soon ' + day + k, 'music'));
  for (let i = 0; i < 10; i++) events.push(ev('l' + i, 'rh', '2026-12-' + String(5 + i * 2).padStart(2, '0'), '20:00', 'Later ' + i, 'music'));
  const monthly = Rk.buildDigest({ events, venues: VENUES, today: TODAY, windowDays: 60, intervalDays: 30, size: 10, musicShare: 100 });
  const weeks = new Set(monthly.picks.map(p => Math.floor((Date.parse(p.shows[0].date) - Date.parse(TODAY)) / 6048e5)));
  assert.ok(weeks.size >= 4, 'spread over weeks: ' + [...weeks]);
  const nights = {};
  for (const p of monthly.picks) nights[p.shows[0].date] = (nights[p.shows[0].date] || 0) + 1;
  assert.ok(Object.values(nights).every(n => n <= 2));
});

test('nextDue / isDue for each interval', () => {
  const t = new Date(2026, 0, 31, 9, 0).getTime();
  assert.strictEqual(Rk.nextDue(t, 'weekly'), t + 7 * 864e5);
  assert.strictEqual(Rk.nextDue(t, 'biweekly'), t + 14 * 864e5);
  assert.strictEqual(Rk.nextDue(t, 'custom', 3), t + 3 * 864e5);
  assert.strictEqual(Rk.nextDue(t, 'monthly'), new Date(2026, 1, 28, 9, 0).getTime(), 'Jan 31 -> Feb 28');
  assert.strictEqual(Rk.nextDue(new Date(2026, 10, 21, 8).getTime(), 'monthly'), new Date(2026, 11, 21, 8).getTime());
  assert.strictEqual(Rk.isDue(0, 'monthly', 30, t), true);
  assert.strictEqual(Rk.isDue(t, 'weekly', 30, t + 6 * 864e5), false);
  assert.strictEqual(Rk.isDue(t, 'weekly', 30, t + 7 * 864e5), true);
});

test('digest settings sanitised; current digest kept; seen capped; backup carries settings', () => {
  const ok = Rk.buildDigest({ events: [ev('1', 'rh', '2026-12-01', '20:00', 'Band', 'music')], venues: VENUES, today: TODAY, windowDays: 60, size: 5, musicShare: 50 });
  const s = S.sanitize({ digest: {
    interval: 'hourly', customDays: 0, size: 99, musicShare: 77, latestStart: '25:00', lastAt: 5, seen: Array.from({ length: 3100 }, (_, i) => 'k' + i),
    current: { createdAt: 5, picks: [...ok.picks, { key: 'x', name: 'no shows', shows: [] }], counts: ok.counts, want: ok.want, short: ['music', 'evil'] }
  } });
  const d = s.digest;
  assert.strictEqual(d.interval, 'monthly');
  assert.strictEqual(d.customDays, 1);
  assert.strictEqual(d.size, 30);
  assert.strictEqual(d.musicShare, 80);
  assert.strictEqual(d.latestStart, '');
  assert.strictEqual(Object.keys(d.seen).length, 3000, 'old array format converted and capped');
  assert.ok(Object.values(d.seen)[0] > E.localDate(Date.now() + 59 * 864e5), 'old entries count as seen for the 60-day window');
  assert.strictEqual(d.current.picks.length, 1);
  assert.strictEqual(d.current.picks[0].shows[0].name, 'Band');
  assert.deepStrictEqual(d.current.short, ['music']);
  assert.strictEqual(S.intervalDays({ interval: 'biweekly' }), 14);
  const text = S.exportData(s);
  assert.ok(text.includes('"seen"') && !text.includes('"createdAt": 5'));
  const back = S.importData(text, s);
  assert.strictEqual(back.digest.size, 30);
  assert.strictEqual(back.digest.current.picks.length, 1, 'current digest on this device kept');
});

// ---------- learning (phase 3) ----------
const NOW = Date.UTC(2026, 10, 21, 12);
function rating(name, v, extra) {
  return [Rk.actKey(name), { name, v, kind: 'music', at: NOW, genres: [], words: Rk.titleWords(name), venue: '', ...(extra || {}) }];
}
function digestWith(events, profileSrc, extra) {
  return Rk.buildDigest({ events, venues: VENUES, today: TODAY, windowDays: 60, intervalDays: 7, size: 10, musicShare: 50,
    profile: Rk.buildProfile(profileSrc, NOW), ...(extra || {}) });
}

test('titleWords skips filler and numbers', () => {
  assert.deepStrictEqual(Rk.titleWords('Special Event: A Tribute to Prince (Night 2) - 21+'), ['tribute', 'prince']);
  assert.deepStrictEqual(Rk.titleWords('The Holiday Drag Brunch 2026'), ['holiday', 'drag', 'brunch']);
});

test('liked act: big boost and reason, at any venue', () => {
  const events = [ev('a', 'he', '2026-12-10', '20:00', 'Special Event: Taylor Tomlinson', 'comedy'), ev('b', 'he', '2026-11-22', '20:00', 'Other Comic', 'comedy')];
  const d = digestWith(events, { ratings: Object.fromEntries([rating('Taylor Tomlinson', 1, { kind: 'comedy', venue: 'al' })]) }, { size: 1, musicShare: 0 });
  assert.deepStrictEqual(d.picks.map(p => p.name), ['Taylor Tomlinson']);
  assert.strictEqual(d.picks[0].reasons[0], 'You liked Taylor Tomlinson');
});

test('thumbs down: act never picked, even if it is the only one', () => {
  const events = [ev('a', 'he', '2026-12-10', '20:00', 'Bad Comic', 'comedy'), ev('b', 'he', '2026-12-11', '20:00', 'Special Event: Bad Comic', 'comedy')];
  const d = digestWith(events, { ratings: Object.fromEntries([rating('Bad Comic', -1)]) });
  assert.deepStrictEqual(d.picks, []);
});

test('Likes list: matches inside longer titles and attraction names', () => {
  const prof = Rk.buildProfile({ likes: [{ name: 'Pink Martini' }, { name: 'Rhys Darby' }] }, NOW);
  assert.ok(Rk.likedBy(prof, ['Pink Martini: Holiday Show']));
  assert.ok(Rk.likedBy(prof, ['A Night of Comedy', 'Rhys Darby']));
  assert.ok(!Rk.likedBy(prof, ['Pink Floyd Tribute']));
  const d = digestWith([ev('a', 'rh', '2026-12-20', '20:00', 'Pink Martini: Holiday Show', 'music'), ev('b', 'rh', '2026-11-22', '20:00', 'Some Band', 'music')], { likes: [{ name: 'pink martini' }] }, { size: 1, musicShare: 100 });
  assert.strictEqual(d.picks[0].name, 'Pink Martini: Holiday Show');
  assert.ok(d.picks[0].reasons.includes('On your Likes list'));
});

test('title words count after two ratings; disliked words push shows down', () => {
  const one = { ratings: Object.fromEntries([rating('A Tribute to Prince', 1)]) };
  const two = { ratings: Object.fromEntries([rating('A Tribute to Prince', 1), rating('Bowie Tribute Night', 1)]) };
  const g = { act: 'x', name: 'Fleetwood Mac Tribute', watchId: 'rh', shows: [ev('t', 'rh', '2026-12-01', '20:00', 'Fleetwood Mac Tribute', 'music')] };
  assert.strictEqual(Rk.learned(Rk.buildProfile(one, NOW), g).score, 0);
  const l2 = Rk.learned(Rk.buildProfile(two, NOW), g);
  assert.ok(l2.score > 1);
  assert.ok(l2.reasons.includes('Like other “tribute” shows you liked'));
  const bad = { ratings: Object.fromEntries([rating('Podcast Live One', -1), rating('Podcast Live Two', -1)]) };
  assert.ok(Rk.learned(Rk.buildProfile(bad, NOW), { ...g, name: 'Big Podcast Taping' }).score < -1);
});

test('genre and venue learning, with reasons', () => {
  const src = { ratings: Object.fromEntries([
    rating('Band A', 1, { genres: ['Indie Rock'], venue: 'al' }), rating('Band B', 1, { genres: ['Indie Rock'], venue: 'al' }),
    rating('Band C', 1, { genres: ['Folk'], venue: 'al' }), rating('Band D', 1, { genres: ['Metal'], venue: 'al' }),
    rating('Band E', 1, { venue: 'al' })]) };
  const prof = Rk.buildProfile(src, NOW);
  const g = { act: 'new band', name: 'New Band', watchId: 'al', shows: [ev('n', 'al', '2026-12-01', '20:00', 'New Band', 'music', { genres: ['Indie Rock'] })] };
  const l = Rk.learned(prof, g);
  assert.ok(l.reasons.includes('You like Indie Rock'));
  assert.ok(l.reasons.includes('You liked shows here'));
  assert.ok(l.score > 2);
});

test('older ratings count less (half weight after 6 months)', () => {
  const old = { ratings: Object.fromEntries([rating('A Tribute', 1, { at: NOW - 365 * 864e5 }), rating('B Tribute', 1, { at: NOW - 365 * 864e5 })]) };
  const w = Rk.buildProfile(old, NOW).words.get('tribute');
  assert.ok(Math.abs(w - 0.5) < 0.01, String(w));
});

test('seen: shows after the last date shown count as new; earlier ones do not', () => {
  const events = [ev('1', 'he', '2026-11-27', '19:00', 'Comic', 'comedy'), ev('2', 'he', '2027-01-10', '19:00', 'Comic', 'comedy')];
  const d = digestWith(events, {}, { seen: { 'he|comic': '2026-11-28' } });
  assert.strictEqual(d.picks.length, 1);
  assert.deepStrictEqual(d.picks[0].shows.map(s => s.date), ['2027-01-10']);
  assert.strictEqual(digestWith(events, {}, { seen: { 'he|comic': '2027-01-10' } }).picks.length, 0);
});

test('hidden shows are left out of the digest', () => {
  const events = [ev('1', 'he', '2026-11-27', '19:00', 'Comic', 'comedy'), ev('2', 'he', '2026-11-28', '19:00', 'Comic', 'comedy')];
  const d = digestWith(events, {}, { hidden: new Set(['1']) });
  assert.deepStrictEqual(d.picks[0].shows.map(s => s.id), ['2']);
});

test('mixSuggestion: needs 6 recent likes and a 20-point difference', () => {
  const likes = (m, c) => ({ ratings: Object.fromEntries([
    ...Array.from({ length: m }, (_, i) => rating('Band ' + i, 1)),
    ...Array.from({ length: c }, (_, i) => rating('Comic ' + i, 1, { kind: 'comedy' }))]) });
  assert.strictEqual(Rk.mixSuggestion(likes(1, 4), 50, NOW), null, 'too few');
  assert.deepStrictEqual(Rk.mixSuggestion(likes(2, 7), 50, NOW), { share: 20, music: 2, comedy: 7 });
  assert.strictEqual(Rk.mixSuggestion(likes(4, 5), 50, NOW), null, 'close to current');
  assert.deepStrictEqual(Rk.mixSuggestion(likes(9, 0), 50, NOW).share, 90, 'never 100');
  const old = likes(0, 8);
  for (const r of Object.values(old.ratings)) r.at = NOW - 400 * 864e5;
  assert.strictEqual(Rk.mixSuggestion(old, 50, NOW), null, 'old ratings ignored');
});

test('profile sanitised and carried in backups', () => {
  const p = S.cleanProfile({
    ratings: { 'taylor tomlinson': { name: 'Taylor Tomlinson', v: 1, kind: 'comedy', at: NOW, genres: ['Comedy'], words: ['taylor', 'BAD WORD'], venue: 'pdx-helium' },
      'Bad Key!': { v: 1 }, 'meh': { v: 0 }, 'x y': { v: -1, kind: 'jazz' } },
    likes: [{ name: 'Pink Martini' }, { name: 'pink martini' }, { name: '' }, 'junk'],
    hidden: ['a', 'a', 'b', 7], mixHint: 300
  });
  assert.deepStrictEqual(Object.keys(p.ratings).sort(), ['taylor tomlinson', 'x y']);
  assert.deepStrictEqual(p.ratings['taylor tomlinson'].words, ['taylor']);
  assert.strictEqual(p.ratings['x y'].kind, 'other');
  assert.deepStrictEqual(p.likes.map(l => l.name), ['Pink Martini']);
  assert.deepStrictEqual(p.hidden, ['a', 'b']);
  assert.strictEqual(p.mixHint, -1);
  const s = S.sanitize({ profile: p });
  const back = S.importData(S.exportData(s), S.defaults());
  assert.deepStrictEqual(back.profile.ratings, s.profile.ratings);
  assert.deepStrictEqual(back.profile.likes, s.profile.likes);
});

// ---------- run ----------
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); } catch (err) { failed++; console.log('FAIL ' + t.name + '\n     ' + (err && err.stack || err)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
