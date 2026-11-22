// Nightly job: read each venue website in data/venues.json and write data/events.json.
//   node tools/fetch-events.js            (writes only when the events changed)
// Polite: one request at a time, a pause between requests, honours robots.txt, identifies itself.
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./readers.js');

const ROOT = path.resolve(__dirname, '..');
const UA = 'EventPicksBot/0.1 (personal event calendar; reads once a day)';
const GAP_MS = 1500;
const DAYS_AHEAD = 365;
const MAX_TRIBE_PAGES = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastAt = 0;

async function politeFetch(url, fetchFn) {
  const wait = lastAt + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res;
}

// ---- robots.txt (simple: groups for * or our bot, longest matching rule wins) ----
function robotsAllows(text, pathname) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a.startsWith('eventpicksbot')));
  const use = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of use) for (const r of g.rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function allowed(url, fetchFn, robotsCache) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let text = '';
    try {
      const res = await fetchFn(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (res.ok) text = await res.text();
    } catch (e) { /* no robots.txt: allowed */ }
    robotsCache.set(u.origin, text);
  }
  return robotsAllows(robotsCache.get(u.origin), u.pathname + u.search);
}

async function readSource(src, fetchFn, now, robotsCache) {
  const reader = R.READERS[src.type];
  if (!reader) throw new Error('unknown source type ' + src.type);
  if (!(await allowed(src.url, fetchFn, robotsCache))) throw new Error('robots.txt does not allow reading ' + src.url);
  if (src.type === 'tribe') {
    const items = [];
    const start = new Date(now).toISOString().slice(0, 10);
    let url = src.url + (src.url.includes('?') ? '&' : '?') + 'per_page=50&start_date=' + start;
    for (let i = 0; url && i < MAX_TRIBE_PAGES; i++) {
      const json = await (await politeFetch(url, fetchFn)).json();
      items.push(...reader.read(json));
      url = typeof json.next_rest_url === 'string' && json.next_rest_url.startsWith(new URL(src.url).origin) ? json.next_rest_url : '';
    }
    return items;
  }
  const res = await politeFetch(src.url, fetchFn);
  return reader.read(reader.format === 'json' ? await res.json() : await res.text());
}

/** Build the events file content from the catalog. fetchFn is injectable for tests. */
async function build(catalog, fetchFn, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const until = new Date(now + DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
  const cache = new Map(), robotsCache = new Map();
  const venues = {}, events = [];
  for (const v of catalog.venues) {
    if (!Array.isArray(v.sources) || !v.sources.length) continue;
    const errors = [], mine = new Map();
    for (const src of v.sources) {
      const key = src.type + ' ' + src.url;
      if (!cache.has(key)) {
        try { cache.set(key, { items: await readSource(src, fetchFn, now, robotsCache) }); }
        catch (e) { cache.set(key, { error: String(e && e.message || e) }); }
      }
      const got = cache.get(key);
      if (got.error) { errors.push(got.error); continue; }
      for (const it of got.items) {
        if (src.venueName && !R.sameVenueName(it.venueName, src.venueName)) continue;
        const e = R.toEvent(it, v, src.type);
        if (e && e.date >= today && e.date <= until && e.status !== 'cancelled') mine.set(e.id, e);
      }
    }
    venues[v.id] = errors.length ? { ok: false, count: mine.size, error: errors.join('; ').slice(0, 300) } : { ok: true, count: mine.size };
    events.push(...mine.values());
  }
  events.sort((a, b) => (a.date + a.time + a.id < b.date + b.time + b.id ? -1 : 1));
  return { version: 1, generatedAt: new Date(now).toISOString(), venues, events };
}

function sameContent(a, b) {
  const strip = o => JSON.stringify({ ...o, generatedAt: undefined });
  return strip(a) === strip(b);
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'venues.json'), 'utf8'));
  const outFile = path.join(ROOT, 'data', 'events.json');
  const next = await build(catalog, fetch, Date.now());
  for (const [id, s] of Object.entries(next.venues)) console.log((s.ok ? 'ok   ' : 'FAIL ') + id + ': ' + s.count + ' events' + (s.error ? ' (' + s.error + ')' : ''));
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* first run */ }
  if (prev && sameContent(prev, next)) { console.log('No changes.'); return; }
  fs.writeFileSync(outFile, JSON.stringify(next) + '\n');
  console.log('Wrote ' + next.events.length + ' events to data/events.json');
  if (Object.values(next.venues).every(s => !s.ok)) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { build, robotsAllows, sameContent };
