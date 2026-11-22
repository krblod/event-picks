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

  // ---------- learning (phase 3) ----------
  const STOP = new Set(('the and with of in at for to on featuring feat presents present presented by live show shows ' +
    'night nights tour special event events plus vs his her their our your from this that are all ages evening ' +
    'performing celebrating celebration').split(' '));

  /** Distinctive words of a title, used to learn themes like 'tribute' or 'holiday'. */
  function titleWords(name) {
    return [...new Set(actKey(name).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 12);
  }

  const HALF_LIFE_DAYS = 180;
  const WORD_MIN = 1.5;   // a word needs about two ratings before it counts
  const GENRE_MIN = 1;

  /** Ratings + likes -> lookup tables. Older ratings count less (half weight after 6 months). */
  function buildProfile(p, now) {
    const prof = { acts: new Map(), names: new Map(), likes: [], genres: new Map(), genreNames: new Map(), words: new Map(), venues: new Map() };
    const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
    const src = p || {};
    for (const [key, r] of Object.entries(src.ratings || {})) {
      if (!r || (r.v !== 1 && r.v !== -1)) continue;
      prof.acts.set(key, r.v);
      prof.names.set(key, r.name);
      const ageDays = Math.max(0, (now - (r.at || now)) / 86400000);
      const w = r.v * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      for (const g of r.genres || []) { add(prof.genres, g.toLowerCase(), w); prof.genreNames.set(g.toLowerCase(), g); }
      for (const x of r.words || []) add(prof.words, x, w);
      if (r.venue) add(prof.venues, r.venue, w);
    }
    prof.likes = (src.likes || []).map(l => ({ name: l.name, tokens: actKey(l.name).split(' ').filter(Boolean) })).filter(l => l.tokens.length);
    return prof;
  }

  /** A favourite from the Likes list whose words all appear in the show or act names. */
  function likedBy(prof, names) {
    const sets = names.map(n => new Set(actKey(n).split(' ')));
    return prof.likes.find(l => sets.some(s => l.tokens.every(t => s.has(t)))) || null;
  }

  /** Learned contribution for a group: { score, reasons }. */
  function learned(prof, g) {
    let score = 0;
    const reasons = [];
    if (prof.acts.get(g.act) === 1) { score += 4; reasons.push('You liked ' + (prof.names.get(g.act) || g.name)); }
    const names = [g.name, ...g.shows.flatMap(s => s.acts.map(a => a.name))];
    const fav = likedBy(prof, names);
    if (fav) { score += 4; reasons.push('On your Likes list'); }

    const genres = [...new Set(g.shows.flatMap(s => s.genres.map(x => x.toLowerCase())))];
    let gs = 0, bestG = null;
    for (const x of genres) {
      const w = prof.genres.get(x) || 0;
      if (Math.abs(w) >= GENRE_MIN) { gs += w; if (w > 0 && (!bestG || w > prof.genres.get(bestG))) bestG = x; }
    }
    gs = Math.max(-2, Math.min(2, gs * 0.75));
    score += gs;
    if (gs >= 0.75 && bestG) reasons.push('You like ' + (prof.genreNames.get(bestG) || bestG));

    let ws = 0, bestW = null;
    for (const x of titleWords(g.name)) {
      const w = prof.words.get(x) || 0;
      if (Math.abs(w) >= WORD_MIN) { ws += w; if (w > 0 && (!bestW || w > prof.words.get(bestW))) bestW = x; }
    }
    ws = Math.max(-2, Math.min(2, ws * 0.6));
    score += ws;
    if (ws >= 0.9 && bestW) reasons.push('Like other “' + bestW + '” shows you liked');

    const vw = Math.max(-1.5, Math.min(1.5, (prof.venues.get(g.watchId) || 0) * 0.4));
    score += vw;
    if (vw >= 0.8) reasons.push('You liked shows here');
    return { score, reasons };
  }

  /** Suggest a new music share when recent thumbs-ups lean clearly one way (>= 6 ratings, >= 20 points off). */
  function mixSuggestion(p, currentShare, now) {
    let music = 0, comedy = 0;
    for (const r of Object.values((p && p.ratings) || {})) {
      if (!r || r.v !== 1 || now - (r.at || 0) > 365 * 86400000) continue;
      if (r.kind === 'music') music++;
      else if (r.kind === 'comedy') comedy++;
    }
    const total = music + comedy;
    if (total < 6) return null;
    const share = Math.min(90, Math.max(10, Math.round(music / total * 10) * 10));
    return Math.abs(share - currentShare) >= 20 ? { share, music, comedy } : null;
  }

  function dayNumber(date) {
    const [y, m, d] = date.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }

  /** Candidate events -> groups of the same act at the same venue. */
  function groupEvents(events) {
    const groups = new Map();
    for (const e of events) {
      const act = actKey(e.name);
      const key = (e.watchId || e.venueId) + '|' + act;
      if (!groups.has(key)) groups.set(key, { key, act, name: displayName(e.name), kind: e.kind, watchId: e.watchId, venueName: e.venueName, shows: [] });
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

    if (ctx.profile) {
      const l = learned(ctx.profile, g);
      score += l.score;
      reasons.unshift(...l.reasons);
    }
    return { score: Math.round(score * 100) / 100, reasons: reasons.slice(0, 3), recurring };
  }

  /**
   * Build a digest.
   * opts: { events, venues, today (YYYY-MM-DD), windowDays, intervalDays, size, musicShare (0-100),
   *         latestStart ('' or 'HH:MM'), seen ({ groupKey: last date shown }), hidden (Set of event ids),
   *         profile (from buildProfile) }
   * Returns { picks: [{ key, act, name, kind, watchId, venueName, shows, score, reasons, recurring }], counts, want, short }
   */
  function buildDigest(opts) {
    const today = opts.today, windowDays = opts.windowDays || 60;
    const last = dayNumber(today) + windowDays;
    const seen = opts.seen || {};
    const hidden = opts.hidden || new Set();
    const prof = opts.profile || null;
    const candidates = (opts.events || []).filter(e =>
      (e.kind === 'music' || e.kind === 'comedy') && !hidden.has(e.id) &&
      e.date >= today && dayNumber(e.date) <= last &&
      e.status !== 'cancelled' && e.status !== 'soldout' &&
      !(opts.latestStart && e.time && e.time > opts.latestStart) &&
      !isParticipatory(e.name));
    const prefOf = new Map((opts.venues || []).map(v => [v.id, v.pref]));
    const ctx = { today, windowDays, prefOf, profile: prof };
    const groups = groupEvents(candidates)
      .filter(g => !(prof && prof.acts.get(g.act) === -1))
      // shown before: only shows after the last date already shown count as new
      .map(g => (seen[g.key] ? { ...g, shows: g.shows.filter(s => s.date > seen[g.key]) } : g))
      .filter(g => g.shows.length)
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

  // ---------- Browse filters ----------
  function weekday(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday
  }

  /** [first, last] day numbers for a When choice, or null for all. Weekend = Fri-Sun (the current one if it has started). */
  function whenRange(when, today) {
    const t = dayNumber(today), wd = weekday(today);
    if (when === 'tonight') return [t, t];
    if (when === '7') return [t, t + 6];
    if (when === '30') return [t, t + 29];
    if (when === 'weekend') {
      if (wd === 0) return [t, t];
      if (wd >= 5) return [t, t + 7 - wd];
      return [t + 5 - wd, t + 7 - wd];
    }
    return null;
  }

  const START_TESTS = {
    matinee: t => t < '17:00',
    by8: t => t <= '20:00',
    by9: t => t <= '21:00',
    late: t => t >= '21:00'
  };

  /**
   * Browse filters. f: { q, when, venues[], weekdays[] (0 = Sun), start, maxPrice, keepUnpriced, hideSoldOut, hideDisliked, likedOnly }.
   * ctx: { today, profile (from buildProfile) }. Shows with no time (TBA) pass the start-time filter.
   */
  function filterBrowse(events, f, ctx) {
    const range = whenRange(f.when, ctx.today);
    const words = actKey(f.q || '').split(' ').filter(Boolean);
    const venues = f.venues && f.venues.length ? new Set(f.venues) : null;
    const days = f.weekdays && f.weekdays.length ? new Set(f.weekdays) : null;
    const startOk = START_TESTS[f.start];
    const prof = ctx.profile;
    return events.filter(e => {
      if (range) { const n = dayNumber(e.date); if (n < range[0] || n > range[1]) return false; }
      if (venues && !venues.has(e.watchId)) return false;
      if (days && !days.has(weekday(e.date))) return false;
      if (startOk && e.time && !startOk(e.time)) return false;
      if (f.maxPrice) {
        if (e.price) { if (e.price.min > f.maxPrice) return false; }
        else if (!f.keepUnpriced) return false;
      }
      if (f.hideSoldOut && e.status === 'soldout') return false;
      if ((f.hideDisliked || f.likedOnly) && prof) {
        const act = actKey(e.name);
        if (f.hideDisliked && prof.acts.get(act) === -1) return false;
        if (f.likedOnly && prof.acts.get(act) !== 1 && !likedBy(prof, [e.name, ...e.acts.map(a => a.name)])) return false;
      }
      if (words.length) {
        const hay = actKey([e.name, e.venueName, ...e.acts.map(a => a.name), ...e.genres].join(' '));
        if (!words.every(w => hay.includes(w))) return false;
      }
      return true;
    });
  }

  /** How many filters are switched on (search and kind not counted). */
  function activeFilterCount(f) {
    return [f.when !== 'all', f.venues.length > 0, f.weekdays.length > 0, f.start !== 'any', f.maxPrice > 0,
      f.hideSoldOut, f.hideDisliked, f.likedOnly].filter(Boolean).length;
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

  return { weekday, whenRange, filterBrowse, activeFilterCount, PARTICIPATORY, INTERVALS, isParticipatory, actKey, displayName, titleWords, buildProfile, likedBy, learned, mixSuggestion, groupEvents, scoreGroup, buildDigest, nextDue, isDue };
});
