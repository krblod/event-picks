// Browser tests with Playwright + Chromium. Ticketmaster and the nightly events file are replaced by
// canned data; the real venue catalog (data/venues.json) is used.
//   NODE_PATH=$(npm root -g) node test/ui-tests.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('../tools/serve.js');
const F = require('./fixtures.js');

const PORT = 8391;
const URL0 = 'http://127.0.0.1:' + PORT + '/';
const KEY = 'TestKey1234567890';

function day(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const D3 = day(3), D4 = day(4), D5 = day(5);

function site(sid, venueId, date, time, name, extra) {
  return { id: 'site:' + venueId + ':' + sid, name, date, time, url: 'https://tickets.example/' + sid, status: '', venueId, venueName: '', kind: 'music', genres: [], acts: [], price: null, source: 'site', ...(extra || {}) };
}
const SITE = {
  version: 1, generatedAt: new Date(Date.now() - 5 * 3600000).toISOString(),
  venues: {
    'pdx-revolution-hall': { ok: true, count: 1 }, 'pdx-helium': { ok: true, count: 2 }, 'pdx-aladdin': { ok: true, count: 2 },
    'pdx-kickstand': { ok: true, count: 1 }, 'pdx-holocene': { ok: false, count: 0, error: 'HTTP 503' }
  },
  events: [
    site('rh1', 'pdx-revolution-hall', D3, '20:00', 'Haley Heynderickx w/ Chamberlain'),
    site('he1', 'pdx-helium', D3, '19:00', 'Special Event: K Trevor Wilson', { kind: 'comedy' }),
    site('he2', 'pdx-helium', D3, '21:30', 'Special Event: K Trevor Wilson', { kind: 'comedy' }),
    site('al1', 'pdx-aladdin', D5, '20:00', 'Folk Night', { status: 'soldout', price: { min: 30, max: 30, currency: 'USD' } }),
    site('al2', 'pdx-aladdin', D5, '22:00', '<img src=x onerror=alert(1)>', { kind: 'other' }),
    site('ks1', 'pdx-kickstand', D4, '19:30', 'Improv Jam', { kind: 'comedy', price: { min: 7, max: 7, currency: 'USD' } }),
    site('ho1', 'pdx-holocene', D4, '21:00', 'Dance Party')
  ]
};

function json(route, body, status) {
  return route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
}

const AL_TM = { ...F.venues.aladdin, location: { latitude: '45.50069', longitude: '-122.65459' } };
function venueHandler(q) {
  const k = (q.get('keyword') || '').toLowerCase();
  if (!k) return F.venuesPage([F.venues.revolution, F.venues.dantes, F.venues.helium, AL_TM, F.venues.vancouver]);
  if (k.startsWith('revolution')) return F.venuesPage([F.venues.revolution]);
  if (k.startsWith('dante')) return F.venuesPage([F.venues.dantes]);
  if (k.startsWith('helium')) return F.venuesPage([F.venues.heliumPhilly, F.venues.helium]);
  if (k.startsWith('aladdin')) return F.venuesPage([AL_TM]);
  return { page: { totalElements: 0, totalPages: 0, number: 0 } };
}
function eventHandler(q) {
  const id = q.get('venueId');
  if (!id) return F.eventsPage([]); // key test
  if (id === F.venues.revolution.id) return F.eventsPage([
    F.event('t1', 'Haley Heynderickx', D3, '20:00:00', F.venues.revolution, { priceRanges: [{ currency: 'USD', min: 40, max: 46 }] }),
    F.event('t2', 'Indie Band', D4, '20:00:00', F.venues.revolution, { priceRanges: [{ currency: 'USD', min: 30, max: 55 }], attractions: [{ id: 'a', name: 'Indie Band' }, { id: 'b', name: 'Support Act' }] })]);
  if (id === F.venues.dantes.id) return F.eventsPage([F.event('t3', 'Punk Night', D4, '21:00:00', F.venues.dantes, { status: 'postponed' })]);
  return F.eventsPage([]);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function setup(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1000, height: 800 } });
  if (o.init) await ctx.addInitScript(o.init, o.initArg);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('dialog', d => { page.errors.push('dialog: ' + d.message()); d.dismiss(); });
  page.requests = [];
  await page.route('**/data/events.json', route => (o.siteStatus ? route.fulfill({ status: o.siteStatus, body: 'no' }) : json(route, SITE)));
  await page.route('https://app.ticketmaster.com/**', route => {
    const u = new URL(route.request().url());
    page.requests.push(u);
    if (u.searchParams.get('apikey') !== KEY) return json(route, { fault: { faultstring: 'Invalid ApiKey' } }, 401);
    return json(route, u.pathname.endsWith('venues.json') ? venueHandler(u.searchParams) : eventHandler(u.searchParams));
  });
  await page.goto(URL0);
  return page;
}

async function addKey(page, key) {
  await page.click('button.tab:has-text("Settings")');
  await page.fill('#api-key', key || KEY);
  await page.click('button:has-text("Save key")');
}
const cardNames = page => page.locator('article.card h4').allTextContents();

test('first run without a key: four named venues watched, venue-website listings shown', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  assert.strictEqual(await page.textContent('button.tab[aria-current="page"]'), 'Picks');
  await page.click('button.tab:has-text("Browse")');
  await page.waitForSelector('article.card:not(.pick)');
  const names = await cardNames(page);
  assert.deepStrictEqual(names, ['Special Event: K Trevor Wilson', 'Haley Heynderickx w/ Chamberlain', 'Special Event: K Trevor Wilson', 'Folk Night', '<img src=x onerror=alert(1)>']);
  const text = await page.textContent('main');
  assert.ok(text.includes("No listings yet for Dante's"), 'explains Dante\'s needs Ticketmaster');
  assert.ok(text.includes('venue websites read 5 h ago'));
  assert.ok((await page.textContent('article.card:has-text("Folk Night")')).includes('Sold out'));
  assert.ok((await page.textContent('article.card:has-text("Haley")')).includes('via venue website'));
  assert.strictEqual(await page.locator('main img').count(), 0);
  assert.strictEqual(page.requests.length, 0, 'no Ticketmaster calls without a key');
  await page.click('button.tab:has-text("Venues")');
  assert.deepStrictEqual(await page.locator('.venue strong').allTextContents(), ['Revolution Hall', "Dante's", 'Helium Comedy Club', 'Aladdin Theater']);
  assert.deepStrictEqual(page.errors, []);
});

test('suggestions: filters, small rooms, data status, watch adds listings', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  await page.click('button.tab:has-text("Venues")');
  const all = await page.locator('.suggestion').count();
  assert.ok(all >= 20, 'catalog shown: ' + all);
  const kick = page.locator('.suggestion:has-text("Kickstand Comedy")');
  assert.ok((await kick.textContent()).includes('Daily listings from the venue website · 1 upcoming'));
  assert.ok((await page.textContent('.suggestion:has-text("Holocene")')).includes('last read failed'));
  assert.ok((await page.textContent('.suggestion:has-text("Doug Fir")')).includes('No listings source yet (sells through Etix)'));
  assert.ok((await page.textContent(".suggestion:has-text(\"Star Theater\")")).includes('Listings via Ticketmaster (TicketWeb) – needs your key'));

  await page.click('.filters button.chip:has-text("Comedy")');
  const comedy = await page.locator('.suggestion strong').allTextContents();
  assert.ok(comedy.includes('Helium Comedy Club') && comedy.includes('Curious Comedy Theater'));
  assert.ok(!comedy.includes('Crystal Ballroom'));
  await page.click('.filters button.chip:has-text("All")');
  await page.check('#small-only');
  const small = await page.locator('.suggestion strong').allTextContents();
  assert.ok(!small.includes('Crystal Ballroom') && !small.includes('Roseland Theater'));
  assert.ok(small.includes('Holocene') && small.includes('Laurelthirst Public House'));

  await page.click('button[aria-label="Watch Kickstand Comedy"]');
  assert.ok((await kick.textContent()).includes('Watching'));
  await page.click('button.tab:has-text("Browse")');
  assert.ok((await page.textContent('main')).includes('Your venue list changed'));
  await page.click('button:has-text("Refresh")');
  await page.waitForSelector('article.card:has-text("Improv Jam")');
  assert.ok((await page.textContent('article.card:has-text("Improv Jam")')).includes('$7'));
  await page.click('button.chip:has-text("Comedy")');
  assert.deepStrictEqual(await cardNames(page), ['Special Event: K Trevor Wilson', 'Special Event: K Trevor Wilson', 'Improv Jam']);
  assert.deepStrictEqual(page.errors, []);
});

test('with a key: venues linked to Ticketmaster, twin show merged, Ticketmaster-only shows added', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  await addKey(page);
  await page.click('button.tab:has-text("Browse")');   // a new key reloads Browse by itself
  await page.waitForSelector('article.card:has-text("Punk Night")');
  const names = await cardNames(page);
  assert.strictEqual(names.filter(n => n.startsWith('Haley')).length, 1, 'no duplicate: ' + names);
  const haley = await page.textContent('article.card:has-text("Haley")');
  assert.ok(haley.includes('$40–$46'), 'price filled from Ticketmaster');
  assert.ok(haley.includes('via venue website + Ticketmaster'));
  assert.ok(names.includes('Indie Band'));
  assert.ok((await page.textContent('article.card:has-text("Punk Night")')).includes('Postponed'));
  assert.ok(!(await page.textContent('main')).includes('No listings yet'));

  await page.click('button.tab:has-text("Venues")');
  const dantes = await page.textContent('.venue:has-text("Dante\'s")');
  assert.ok(dantes.includes('Ticketmaster') && !dantes.includes('Venue website'));
  const rh = await page.textContent('.venue:has-text("Revolution Hall")');
  assert.ok(rh.includes('Venue website') && rh.includes('Ticketmaster'));
  // Reload: links remembered, no new venue lookups
  const lookups = () => page.requests.filter(u => u.pathname.endsWith('venues.json')).length;
  const before = lookups();
  await page.reload();
  await page.click('button.tab:has-text("Browse")');
  await page.click('button:has-text("Refresh")');
  await page.waitForSelector('article.card:has-text("Punk Night")');
  assert.strictEqual(lookups(), before);
  assert.deepStrictEqual(page.errors, []);
});

test('Ticketmaster search: nearby list; a venue already in the suggestions is not duplicated', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  await addKey(page);
  await page.click('button.tab:has-text("Venues")');
  await page.click('button:has-text("Show all nearby")');
  await page.waitForSelector('.candidate');
  const rows = await page.locator('.candidate span').first().textContent();
  assert.ok(rows.length > 0);
  assert.ok((await page.textContent('main')).includes('Revolution Hall Annex'));
  assert.ok((await page.textContent('.candidate:has-text("Aladdin")')).includes('Watching'), 'Aladdin matched to the watched suggestion');
  await page.click('button[aria-label="Watch Revolution Hall Annex"]');
  assert.deepStrictEqual(await page.locator('.venue strong').allTextContents(), ['Revolution Hall', "Dante's", 'Helium Comedy Club', 'Aladdin Theater', 'Revolution Hall Annex']);
  await page.fill('#tm-query', 'Nova PDX');
  await page.click('button:has-text("Search")');
  await page.waitForSelector('.empty:has-text("Nothing found")');
  assert.ok((await page.textContent('main')).includes('searched: Nova PDX, nova'));
  assert.deepStrictEqual(page.errors, []);
});

test('bad key: website listings still shown, clear Ticketmaster error', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  await addKey(page, 'WrongKey123456789');
  await page.click('button:has-text("Test key")');
  await page.waitForSelector('.note.warn:has-text("did not accept")');
  await page.click('button.tab:has-text("Browse")');
  await page.click('button:has-text("Refresh")');
  await page.waitForSelector('.errors');
  assert.ok((await page.textContent('.errors')).includes('Ticketmaster: Ticketmaster did not accept the API key'));
  assert.ok((await cardNames(page)).includes('Folk Night'));
  assert.deepStrictEqual(page.errors, []);
});

test('events file missing: message shown, Ticketmaster listings still work', async (browser) => {
  const page = await setup(browser, { siteStatus: 404 });
  await page.waitForSelector('.note.warn:has-text("no new digest was made")');
  await page.click('button.tab:has-text("Browse")');
  assert.ok((await page.textContent('.errors')).includes('Venue website listings could not be loaded'));
  await addKey(page);
  await page.click('button.tab:has-text("Browse")');
  await page.waitForSelector('article.card:has-text("Punk Night")');
  await page.click('button.tab:has-text("Picks")');
  await page.click('button:has-text("Make digest")');
  await page.waitForSelector('article.pick:has-text("Punk Night")');
  assert.deepStrictEqual(page.errors, []);
});

test('area change: no suggestions for another city', async (browser) => {
  const page = await setup(browser);
  await page.click('button.tab:has-text("Settings")');
  await page.fill('#city-state', '9X');
  await page.click('button:has-text("Save area")');
  assert.ok((await page.textContent('.note.warn')).includes('2-letter'));
  await page.fill('#city-state', 'WA');
  await page.fill('#city-name', 'Seattle');
  await page.fill('#city-lat', '47.6062');
  await page.fill('#city-lon', '-122.3321');
  await page.fill('#city-radius', '15');
  await page.click('button:has-text("Save area")');
  await page.waitForSelector('.note.ok:has-text("Area saved")');
  await page.reload();
  assert.strictEqual(await page.inputValue('#city-name').catch(() => ''), '');
  await page.click('button.tab:has-text("Venues")');
  await page.waitForSelector('.empty:has-text("No suggestions")');
  assert.ok((await page.textContent('main')).includes('within 15 miles of Seattle'));
  assert.strictEqual(await page.locator('.venue').count(), 4, 'watched venues kept');
});

test('backup export has no key; import restores venues', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.card');
  await addKey(page);
  await page.click('button.tab:has-text("Venues")');
  await page.click('button[aria-label="Watch Holocene"]');
  await page.click('button.tab:has-text("Settings")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export backup")')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(!text.includes(KEY));
  assert.ok(text.includes('pdx-holocene'));

  const page2 = await setup(browser);
  await page2.waitForSelector('article.card');
  await page2.click('button.tab:has-text("Settings")');
  await page2.setInputFiles('#import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page2.waitForSelector('.note.ok:has-text("Backup loaded: 5 venues")');
  await page2.setInputFiles('#import-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await page2.waitForSelector('.note.warn:has-text("not an Event Picks backup")');
  await page2.click('button.tab:has-text("Venues")');
  assert.ok((await page2.locator('.venue strong').allTextContents()).includes('Holocene'));
});

test('phone width: no sideways scroll, no "null", normal-height inputs', async (browser) => {
  const page = await setup(browser, { viewport: { width: 360, height: 740 } });
  await page.waitForSelector('article.card');
  await addKey(page);
  await page.click('button.tab:has-text("Venues")');
  await page.click('button:has-text("Show all nearby")');
  await page.waitForSelector('.candidate');
  const shot = name => path.join(os.tmpdir(), 'event-picks-phone-' + name + '.png');
  for (const tab of ['Venues', 'Settings', 'Browse', 'Picks', 'Likes']) {
    await page.click(`button.tab:has-text("${tab}")`);
    if (tab === 'Browse') {
      await page.waitForSelector('article.card');
      await page.click('button.filters-toggle');
      await page.selectOption('#browse-sort', 'venue');
    }
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(w[0] <= w[1], tab + ' scrolls sideways: ' + w);
    assert.ok(!/\bnull\b/.test(await page.textContent('main')), tab + ' shows "null"');
    const tall = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('main input:not([type=checkbox])')].map(i => i.offsetHeight)));
    assert.ok(tall < 60, tab + ' has an input ' + tall + 'px tall');
    await page.screenshot({ path: shot(tab.toLowerCase()), fullPage: true });
  }
});

test('Picks: first digest made on open, repeats grouped, open mics and sold-out shows left out, kept on reload', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  assert.deepStrictEqual(await page.locator('article.pick h4').allTextContents(), ['K Trevor Wilson', 'Haley Heynderickx w/ Chamberlain']);
  const wilson = page.locator('article.pick:has-text("K Trevor Wilson")');
  assert.strictEqual(await wilson.locator('.times li').count(), 2, 'both showtimes in one pick');
  assert.ok((await wilson.textContent()).includes('Why: Special event'));
  assert.strictEqual(await wilson.locator('.times a').first().getAttribute('rel'), 'noopener noreferrer');
  const text = await page.textContent('main');
  assert.ok(text.includes('1 music · 1 comedy'));
  assert.ok(text.includes('your mix: 50% music, 50% comedy'));
  assert.ok(text.includes('Not enough new music at your venues to fill 5 spots'));
  assert.ok(/Next digest \w{3}, \w{3} \d+ \(in 3\d days\)/.test(text), 'monthly next date shown');
  assert.ok(!text.includes('Folk Night') && !text.includes('Improv Jam'));

  await page.reload();
  await page.waitForSelector('article.pick');
  assert.strictEqual(await page.locator('article.pick').count(), 2, 'same digest after reload');
  await page.click('button:has-text("New digest now")');
  await page.waitForSelector('.empty:has-text("Nothing new since your last digest")');
  assert.deepStrictEqual(page.errors, []);
});

test('Picks: settings change the next digest (interval, size, latest start, mix, forget)', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Settings")');
  await page.selectOption('#interval', 'weekly');
  assert.ok(/Next digest .*\(in [67] days\)/.test(await page.textContent('.note.ok')));
  await page.selectOption('#interval', 'custom');
  await page.fill('#custom-days', '3');
  await page.press('#custom-days', 'Tab');
  assert.ok((await page.textContent('.note.ok')).includes('(in 3 days)'));
  await page.fill('#digest-size', '50');
  await page.press('#digest-size', 'Tab');
  assert.ok((await page.textContent('.note.warn')).includes('3 to 30'));
  await page.selectOption('#latest-start', '20:00');
  await page.locator('#music-share').fill('80');
  assert.strictEqual(await page.textContent('#mix-label'), '80% music · 20% comedy');
  await page.click('button:has-text("Forget past digests")');
  await page.click('button.tab:has-text("Picks")');
  await page.click('button:has-text("New digest now")');
  await page.waitForSelector('text=your mix: 80% music, 20% comedy');
  const wilson = page.locator('article.pick:has-text("K Trevor Wilson")');
  assert.deepStrictEqual(await wilson.locator('.times li').allTextContents(), [await page.evaluate(d => window.EPEvents.formatDate(d), D3) + ' · 7:00 PM'], '9:30 PM show left out');
  await page.reload();
  await page.click('button.tab:has-text("Settings")');
  assert.strictEqual(await page.inputValue('#interval'), 'custom');
  assert.strictEqual(await page.inputValue('#latest-start'), '20:00');
  assert.strictEqual(await page.inputValue('#music-share'), '80');
  assert.deepStrictEqual(page.errors, []);
});

test('Picks: an old digest is replaced when the interval has passed', async (browser) => {
  const old = Date.now() - 40 * 86400000;
  const saved = {
    seeded: true, venues: [{ id: 'pdx-helium', localId: 'pdx-helium', tmId: null, name: 'Helium Comedy Club', pref: 'love' }],
    digest: { interval: 'monthly', lastAt: old, seen: [], current: { createdAt: old, picks: [{ key: 'old', name: 'Old Pick', kind: 'comedy', watchId: 'pdx-helium', venueName: 'Helium',
      shows: [{ id: 'site:pdx-helium:old', name: 'Old Pick', date: day(-30), time: '19:00', venueId: 'pdx-helium', source: 'site' }] }], counts: { music: 0, comedy: 1 }, want: { music: 5, comedy: 5 }, short: [] } }
  };
  const page = await setup(browser, { init: s => { try { if (!localStorage.getItem('eventPicks.v1')) localStorage.setItem('eventPicks.v1', s); } catch (e) {} }, initArg: JSON.stringify(saved) });
  await page.waitForSelector('article.pick:has-text("K Trevor Wilson")');
  const text = await page.textContent('main');
  assert.ok(!text.includes('Old Pick'));
  assert.ok(text.includes('★'), 'favourite venue star');
  assert.ok(text.includes('Why: Favourite venue · Special event'));
  assert.deepStrictEqual(page.errors, []);
});

test('Ratings: like in Browse, not-for-me on a pick, undo, Likes tab lists both', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Browse")');
  await page.click('button[aria-label="Like Haley Heynderickx w/ Chamberlain"]');
  assert.strictEqual(await page.getAttribute('button[aria-label="Like Haley Heynderickx w/ Chamberlain"]', 'aria-pressed'), 'true');
  assert.ok((await page.textContent('article.card:has-text("Haley")')).includes('You liked this act'));

  await page.click('button.tab:has-text("Picks")');
  assert.strictEqual(await page.getAttribute('article.pick:has-text("Haley") button.up', 'aria-pressed'), 'true', 'same act, same rating on Picks');
  await page.click('button[aria-label="Not for me: K Trevor Wilson"]');
  const wilson = page.locator('article.pick:has-text("K Trevor Wilson")');
  assert.ok((await wilson.getAttribute('class')).includes('disliked'));
  assert.ok((await wilson.textContent()).includes('won’t be picked again'));

  await page.click('button.tab:has-text("Likes")');
  const text = await page.textContent('main');
  assert.ok(text.includes('Liked (1)') && text.includes('Not for me (1)'));
  await page.click('button[aria-label="Undo not for me: K Trevor Wilson"]');
  assert.ok((await page.textContent('main')).includes('Not for me (0)'));
  await page.reload();
  await page.click('button.tab:has-text("Likes")');
  assert.ok((await page.textContent('main')).includes('Liked (1)'), 'kept after reload');
  // pressing 👍 again removes the like
  await page.click('button.tab:has-text("Browse")');
  await page.click('button[aria-label="Like Haley Heynderickx w/ Chamberlain"]');
  await page.click('button.tab:has-text("Likes")');
  assert.ok((await page.textContent('main')).includes('Liked (0)'));
  assert.deepStrictEqual(page.errors, []);
});

test('Hide: removes a show from Browse and Picks, Undo and Unhide all bring it back', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Browse")');
  const before = await page.locator('article.card').count();
  await page.click('article.card:has-text("Haley") button[aria-label^="Hide"]');
  assert.strictEqual(await page.locator('article.card').count(), before - 1);
  assert.ok((await page.textContent('.note.ok')).includes('Hidden: Haley Heynderickx w/ Chamberlain.'));
  await page.click('.note.ok button:has-text("Undo")');
  assert.strictEqual(await page.locator('article.card').count(), before);
  await page.click('article.card:has-text("Haley") button[aria-label^="Hide"]');
  await page.click('button.tab:has-text("Picks")');
  assert.ok(!(await page.textContent('main')).includes('Haley'));
  assert.ok((await page.textContent('main')).includes('1 hidden (see the Likes tab)'));
  await page.click('button.tab:has-text("Likes")');
  assert.ok((await page.textContent('main')).includes('1 show hidden.'));
  await page.click('button:has-text("Unhide all")');
  await page.click('button.tab:has-text("Picks")');
  assert.ok((await page.textContent('main')).includes('Haley'));
  assert.deepStrictEqual(page.errors, []);
});

test('Likes list: a favourite gets a reason in the next digest', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Likes")');
  await page.fill('#like-name', 'Trevor Wilson');
  await page.press('#like-name', 'Enter');
  assert.ok((await page.textContent('.chips.likes')).includes('Trevor Wilson'));
  await page.click('button.tab:has-text("Settings")');
  await page.click('button:has-text("Forget past digests")');
  await page.click('button.tab:has-text("Picks")');
  await page.click('button:has-text("New digest now")');
  await page.waitForSelector('article.pick:has-text("On your Likes list")');
  assert.ok((await page.textContent('article.pick:has-text("K Trevor Wilson")')).includes('Why: On your Likes list · Special event'));
  await page.click('button.tab:has-text("Likes")');
  await page.click('button[aria-label="Remove Trevor Wilson"]');
  assert.ok((await page.textContent('main')).includes('None yet.'));
  assert.deepStrictEqual(page.errors, []);
});

test('Mix hint: suggested after mostly-comedy likes; accept changes the slider, decline hides it', async (browser) => {
  const now = Date.now();
  const ratings = {};
  for (let i = 0; i < 7; i++) ratings['comic ' + 'abcdefg'[i]] = { name: 'Comic ' + i, v: 1, kind: 'comedy', at: now };
  ratings['band a'] = { name: 'Band A', v: 1, kind: 'music', at: now };
  const saved = { seeded: false, profile: { ratings } };
  const init = s => { try { if (!localStorage.getItem('eventPicks.v1')) localStorage.setItem('eventPicks.v1', s); } catch (e) {} };
  const page = await setup(browser, { init, initArg: JSON.stringify(saved) });
  await page.waitForSelector('.hint');
  assert.ok((await page.textContent('.hint')).includes('You’ve liked 1 music and 7 comedy shows. Try 10% music / 90% comedy?'));
  await page.click('button:has-text("No thanks")');
  assert.strictEqual(await page.locator('.hint').count(), 0);
  await page.reload();
  await page.waitForSelector('article.pick');
  assert.strictEqual(await page.locator('.hint').count(), 0, 'stays dismissed');

  const page2 = await setup(browser, { init, initArg: JSON.stringify(saved) });
  await page2.waitForSelector('.hint');
  await page2.click('button:has-text("Use this mix")');
  assert.ok((await page2.textContent('.note.ok')).includes('Mix changed to 10% music'));
  await page2.click('button.tab:has-text("Settings")');
  assert.strictEqual(await page2.inputValue('#music-share'), '10');
  assert.deepStrictEqual(page.errors.concat(page2.errors), []);
});

test('Browse search: filters as you type and keeps the cursor in the box', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Browse")');
  await page.waitForSelector('article.card');
  await page.click('#browse-q');
  await page.keyboard.type('wil', { delay: 30 });
  await page.waitForTimeout(350);
  await page.keyboard.type('son', { delay: 30 });
  await page.waitForTimeout(350);
  assert.strictEqual(await page.inputValue('#browse-q'), 'wilson', 'typing continued after the list refreshed');
  assert.deepStrictEqual(await cardNames(page), ['Special Event: K Trevor Wilson', 'Special Event: K Trevor Wilson']);
  assert.ok((await page.textContent('.showing')).includes('Showing 2 of 5 shows'));
  await page.fill('#browse-q', 'zzz');
  await page.waitForSelector('.empty:has-text("No shows match these filters")');
  await page.click('.showing button:has-text("Clear filters")');
  assert.strictEqual(await page.locator('article.card').count(), 5);
  assert.deepStrictEqual(page.errors, []);
});

test('Browse: sort by venue shows venue headings with dates on each show', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Browse")');
  await page.waitForSelector('article.card');
  await page.selectOption('#browse-sort', 'venue');
  assert.deepStrictEqual(await page.locator('.venue-group h3').allTextContents(), ['Aladdin Theater (2)', 'Helium Comedy Club (2)', 'Revolution Hall (1)']);
  const d3 = await page.evaluate(d => window.EPEvents.formatDate(d), D3);
  assert.ok((await page.textContent('.venue-group:has-text("Revolution Hall") .when')).includes(d3));
  await page.reload();
  await page.click('button.tab:has-text("Browse")');
  assert.strictEqual(await page.inputValue('#browse-sort'), 'venue', 'sort remembered');
  assert.deepStrictEqual(page.errors, []);
});

test('Browse filter panel: venues, sold out, start time, price, days, when, liked; remembered; clear', async (browser) => {
  const page = await setup(browser);
  await page.waitForSelector('article.pick');
  await page.click('button.tab:has-text("Browse")');
  await page.waitForSelector('article.card');
  await page.click('button.filters-toggle');
  assert.strictEqual(await page.getAttribute('button.filters-toggle', 'aria-expanded'), 'true');

  await page.click('#filter-panel button.chip:has-text("Helium Comedy Club")');
  assert.deepStrictEqual(await cardNames(page), ['Special Event: K Trevor Wilson', 'Special Event: K Trevor Wilson']);
  assert.strictEqual(await page.textContent('button.filters-toggle'), 'Filters (1)');
  await page.click('#filter-panel button.chip:has-text("Helium Comedy Club")');

  await page.check('#f-soldout');
  assert.ok(!(await cardNames(page)).includes('Folk Night'));
  await page.selectOption('#f-start', 'by8');
  assert.deepStrictEqual(await cardNames(page), ['Special Event: K Trevor Wilson', 'Haley Heynderickx w/ Chamberlain']);
  await page.selectOption('#f-start', 'any');
  await page.uncheck('#f-soldout');

  await page.selectOption('#f-price', '20');
  assert.strictEqual(await page.locator('article.card').count(), 4, 'Folk Night ($30) out, unpriced kept');
  await page.uncheck('#f-unpriced');
  await page.waitForSelector('.empty:has-text("No shows match")');
  await page.selectOption('#f-price', '0');
  assert.strictEqual(await page.locator('#f-unpriced').count(), 0, 'option only shown with a price limit');

  const dayName = (await page.evaluate(d => window.EPEvents.formatDate(d), D5)).slice(0, 3);
  await page.click(`#filter-panel .chips[aria-label="Days"] button:has-text("${dayName}")`);
  assert.deepStrictEqual(await cardNames(page), ['Folk Night', '<img src=x onerror=alert(1)>']);
  await page.click(`#filter-panel .chips[aria-label="Days"] button:has-text("${dayName}")`);

  await page.click('#filter-panel button.chip:has-text("Tonight")');
  await page.waitForSelector('.empty:has-text("No shows match")');
  await page.click('#filter-panel button.chip:has-text("Next 7 days")');
  assert.strictEqual(await page.locator('article.card').count(), 5);

  await page.click('article.card:has-text("Haley") button.up');
  await page.check('#f-liked');
  assert.deepStrictEqual(await cardNames(page), ['Haley Heynderickx w/ Chamberlain']);
  assert.strictEqual(await page.textContent('button.filters-toggle'), 'Filters (2)');

  await page.reload();
  await page.click('button.tab:has-text("Browse")');
  assert.strictEqual(await page.textContent('button.filters-toggle'), 'Filters (2)', 'filters remembered, panel closed');
  assert.strictEqual(await page.locator('#filter-panel').count(), 0);
  assert.strictEqual(await page.locator('article.card').count(), 1);
  await page.click('.showing button:has-text("Clear filters")');
  assert.strictEqual(await page.locator('article.card').count(), 5);
  assert.strictEqual(await page.textContent('button.filters-toggle'), 'Filters');
  assert.deepStrictEqual(page.errors, []);
});

test('storage blocked: warning shown, app still works', async (browser) => {
  const page = await setup(browser, { init: () => Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }) });
  await page.waitForSelector('article.card');
  assert.ok((await page.textContent('main')).includes('could not be saved'));
  assert.deepStrictEqual(page.errors, []);
});

test('CSP allows only this site and Ticketmaster', async (browser) => {
  const page = await setup(browser);
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("connect-src 'self' https://app.ticketmaster.com"));
});

(async () => {
  const server = await start(PORT);
  const browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(browser); console.log('ok   ' + t.name); }
    catch (err) { failed++; console.log('FAIL ' + t.name + '\n     ' + (err && err.stack || err)); }
  }
  await browser.close();
  server.close();
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
