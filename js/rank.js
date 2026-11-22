/* Event Picks: digest ranking (pure functions).
   Events -> groups (one per act per venue, all its showtimes) -> scores with reasons -> picks
   balanced by the music/comedy share, with variety caps. UMD: window.EPRank / require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./events.js'));
  else root.EPRank = factory(root.EPEvents);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  /** Shows you take part in rather than watch: left out of the digest (still in Browse). */
  const PARTICIPATORY = [
    /\bopen[- ]?mic\b/i, /\b(improv|open|bluegrass|people'?s|community|old[- ]time|jazz|blues|acoustic|song|folk|student)\s+jam\b/i,
    /\bjam (session|night)\b/i, /\bjam\b.*\b(students|performers|bring your)\b/i, /\bclass(es)?\b/i, /\bworkshop\b/i,
    /\blessons?\b/i, /\bauditions?\b/i, /\bdrop[- ]in\b/i, /\bkaraoke\b/i, /\btrivia\b/i,
    /\b(history|art|building|venue|backstage|walking)\b[^|]{0,20}\btour\b/i, /\btour of the\b/i
  ];
  function isParticipatory(name) { return PARTICIPATORY.some(re => re.test(name)); }

  /** Act name for grouping: drops billing words, show numbers and age notes. */
  function actKey(name) {
    let s = String(name || '').toLowerCase();
    s = s.replace(/^\s*(special event|sold out|presents?)\s*[:\-–]\s*/g, '');
    s = s.replace(/\((night|show)\s*\d+\)|\((early|late)( show)?\)|\b(early|late) show\b|\bnight \d+\b/g, ' ');
    s = s.replace(/[-–—,]?\s*(\d{2}\+|all ages)\s*$/g, ' ');
    return s.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Name to show for a group: no "Special Event:" prefix or "(Night 2)"-style suffix. */
  function displayName(name) {
    const s = String(name || '')
      .replace(/^\s*special event\s*[:\-–]\s*/i, '')
      .replace(/\s*\((night|show)\s*\d+\)|\s*\((early|late)( show)?\)/gi, '')
      .trim();
    return s || String(name || '');
  }

  function dayNumber(date) {
    const [y, m, d] = date.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }

  /** Candidate events -> groups of the same act at the same venue. */
  function groupEvents(events) {
    const groups = new Map();
    for (const e of events) {
      const key = (e.watchId || e.venueId) + '|' + actKey(e.name);
      if (!groups.has(key)) groups.set(key, { key, name: displayName(e.name), kind: e.kind, watchId: e.watchId, venueName: e.venueName, shows: [] });
      groups.get(key).shows.push(e);
    }
    for (const g of groups.values()) g.shows.sort((a, b) => (E.whenKey(a) < E.whenKey(b) ? -1 : 1));
    return [...groups.values()];
  }

  /**
   * Score one group. ctx: { today, windowDays, prefOf: Map(watchId -> pref), profile }.
   * Returns { score, reasons, recurring }.
   */
  function scoreGroup(g, ctx) {
    let score = 0;
    const reasons = [];
    const pref = ctx.prefOf.get(g.watchId) || 'normal';
    if (pref === 'love') { score += 3; reasons.push('Favourite venue'); }
    if (pref === 'low') score -= 3;

    const first = g.shows[0];
    if (/^\s*special event\b/i.test(first.name)) { score += 1.5; reasons.push('Special event'); }

    const upcoming = Math.max(0, ...g.shows.flatMap(s => s.acts.map(a => a.upcoming || 0)));
    if (upcoming >= 20) { score += 2; reasons.push('Touring act'); }
    else if (upcoming >= 5) score += 1;

    const top = Math.max(0, ...g.shows.map(s => (s.price ? s.price.max : 0)));
    if (top > 10) score += Math.min(1.5, Math.log2(top / 10) * 0.75);

    const days = g.shows.map(s => dayNumber(s.date));
    const span = Math.max(...days) - Math.min(...days);
    const recurring = g.shows.length >= 3 && span > 14;
    if (recurring) score -= 3;

    const until = dayNumber(first.date) - dayNumber(ctx.today);
    score += 0.5 * Math.max(0, 1 - until / Math.max(1, ctx.windowDays));

    const prof = ctx.profile || {};
    if (prof.acts && prof.acts[g.key]) score += prof.acts[g.key];

    return { score: Math.round(score * 100) / 100, reasons, recurring };
  }

  /**
   * Build a digest.
   * opts: { events, venues, today (YYYY-MM-DD), windowDays, size, musicShare (0-100),
   *         latestStart ('' or 'HH:MM'), seen (Set of group keys), profile }
   * Returns { picks: [{ key, name, kind, watchId, venueName, shows, score, reasons, recurring }], counts, short }
   */
  function buildDigest(opts) {
    const today = opts.today, windowDays = opts.windowDays || 60;
    const last = dayNumber(today) + windowDays;
    const seen = opts.seen || new Set();
    const candidates = (opts.events || []).filter(e =>
      (e.kind === 'music' || e.kind === 'comedy') &&
      e.date >= today && dayNumber(e.date) <= last &&
      e.status !== 'cancelled' && e.status !== 'soldout' &&
      !(opts.latestStart && e.time && e.time > opts.latestStart) &&
      !isParticipatory(e.name));
    const prefOf = new Map((opts.venues || []).map(v => [v.id, v.pref]));
    const ctx = { today, windowDays, prefOf, profile: opts.profile };
    const groups = groupEvents(candidates)
      .filter(g => !seen.has(g.key))
      .map(g => ({ ...g, ...scoreGroup(g, ctx) }))
      .sort((a, b) => b.score - a.score || (E.whenKey(a.shows[0]) < E.whenKey(b.shows[0]) ? -1 : 1));

    const size = Math.max(1, opts.size || 10);
    const share = Math.min(100, Math.max(0, opts.musicShare == null ? 50 : opts.musicShare));
    const want = { music: Math.round(size * share / 100) };
    want.comedy = size - want.music;
    const venueCount = new Set(groups.map(g => g.watchId)).size || 1;
    const perVenue = Math.max(2, Math.ceil(size / venueCount));

    // Spread picks over the weeks until the next digest, so later shows are not missed for good.
    const weeks = Math.max(1, Math.ceil((opts.intervalDays || 30) / 7));
    const perWeek = Math.max(2, Math.ceil(size / weeks));
    const weekOf = g => Math.floor((dayNumber(g.shows[0].date) - dayNumber(today)) / 7);

    const picked = [], perV = new Map(), perNight = new Map(), perW = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    const take = g => { picked.push(g); bump(perV, g.watchId); bump(perNight, g.shows[0].date); bump(perW, weekOf(g)); };
    // Caps are relaxed step by step: 0 = all, 1 = week + night only, 2 = none.
    const fits = (g, level) => level >= 2 || (
      (level >= 1 || (perV.get(g.watchId) || 0) < perVenue) &&
      (perNight.get(g.shows[0].date) || 0) < 2 && (perW.get(weekOf(g)) || 0) < perWeek);
    // 1) each kind up to its share (the ratio wins over the caps)
    for (const level of [0, 1, 2]) {
      for (const kind of ['music', 'comedy']) {
        for (const g of groups) {
          if (picked.filter(p => p.kind === kind).length >= want[kind]) break;
          if (g.kind === kind && !picked.includes(g) && fits(g, level)) take(g);
        }
      }
    }
    // 2) a kind ran short: fill with the other kind
    for (const level of [0, 1, 2]) {
      for (const g of groups) {
        if (picked.length >= size) break;
        if (!picked.includes(g) && fits(g, level)) take(g);
      }
    }
    const counts = { music: picked.filter(g => g.kind === 'music').length, comedy: picked.filter(g => g.kind === 'comedy').length };
    const short = [];
    for (const kind of ['music', 'comedy']) if (counts[kind] < want[kind]) short.push(kind);
    picked.sort((a, b) => (E.whenKey(a.shows[0]) < E.whenKey(b.shows[0]) ? -1 : 1));
    return { picks: picked, counts, want, short };
  }

  // ---------- schedule ----------
  const INTERVALS = ['weekly', 'biweekly', 'monthly', 'custom'];

  /** When the next digest is due after lastAt (ms). Monthly = same day next month (clamped). */
  function nextDue(lastAt, interval, customDays) {
    if (!lastAt) return 0;
    const d = new Date(lastAt);
    if (interval === 'weekly') return lastAt + 7 * 86400000;
    if (interval === 'biweekly') return lastAt + 14 * 86400000;
    if (interval === 'custom') return lastAt + Math.max(1, customDays || 30) * 86400000;
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d.getDate(), lastDay), d.getHours(), d.getMinutes()).getTime();
  }

  function isDue(lastAt, interval, customDays, now) {
    return !lastAt || now >= nextDue(lastAt, interval, customDays);
  }

  return { PARTICIPATORY, INTERVALS, isParticipatory, actKey, displayName, groupEvents, scoreGroup, buildDigest, nextDue, isDue };
});
