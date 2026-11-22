/* Event Picks: UI. Built with DOM methods only (no innerHTML). */
(function () {
  'use strict';
  const E = window.EPEvents, S = window.EPStore, A = window.EPApi, Rk = window.EPRank;
  const main = document.getElementById('main');
  const tabsEl = document.getElementById('tabs');
  const footEl = document.getElementById('foot');
  if (!E || !S || !A || !Rk) {
    const p = document.createElement('p');
    p.className = 'note warn';
    p.textContent = 'A part of the app failed to load. Reload the page.';
    main.replaceChildren(p);
    return;
  }

  // ---------- storage ----------
  function safeStorage() {
    try { const s = window.localStorage; s.getItem('x'); return s; } catch (e) { return null; }
  }
  const storage = safeStorage();
  let state = S.load(storage);
  let saveFailed = false;
  function persist() { saveFailed = !storage || !S.save(storage, state); }

  // ---------- transient UI state ----------
  const TABS = [['picks', 'Picks'], ['browse', 'Browse'], ['venues', 'Venues'], ['settings', 'Settings']];
  let view = 'picks';
  let autoDigest = false;
  let busy = '';             // message while a request runs
  let flash = null;          // { kind: 'ok' | 'error', text }
  let keyVisible = false;
  let autoFetched = false;
  let catalog = null;        // suggested venues (data/venues.json), null while loading
  let catalogError = '';
  let siteStatus = {};       // venue id -> { ok, count, error } from data/events.json
  let tmSearch = null;       // { title, list } | { error }

  function client() { return A.createClient({ apiKey: state.apiKey }); }

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ---------- DOM helper ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'value') n.value = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      n.append(k instanceof Node ? k : String(k));
    }
    return n;
  }
  const button = (text, onclick, extra) => el('button', { type: 'button', onclick, ...(extra || {}) }, text);
  const tag = (text, cls) => el('span', { class: 'tag' + (cls ? ' ' + cls : ''), text });

  // ---------- render ----------
  function render() {
    tabsEl.replaceChildren(...TABS.map(([id, label]) => el('button', {
      type: 'button', class: 'tab', 'aria-current': view === id ? 'page' : null,
      onclick: () => { view = id; flash = null; render(); main.focus({ preventScroll: true }); }
    }, label)));
    let content;
    try {
      content = view === 'venues' ? renderVenues() : view === 'settings' ? renderSettings()
        : view === 'browse' ? renderBrowse() : renderPicks();
    } catch (err) {
      content = el('section', { class: 'panel error' },
        el('h2', { text: 'Something went wrong showing this page' }),
        el('p', { text: String(err && err.message || err) }),
        button('Reload', () => location.reload()));
    }
    main.replaceChildren(...[
      saveFailed ? el('p', { class: 'note warn', role: 'alert' },
        'Your changes could not be saved in this browser (private window or storage blocked). They will be lost when you close the page.') : null,
      flash ? el('p', { class: 'note ' + (flash.kind === 'error' ? 'warn' : 'ok'), role: 'status' }, flash.text) : null,
      busy ? el('p', { class: 'note busy', role: 'status' }, busy) : null,
      content].filter(Boolean));
    footEl.replaceChildren('Event Picks v' + E.BUILD + ' · Listings from venue websites and Ticketmaster');
  }

  function go(id) { return () => { view = id; flash = null; render(); }; }

  function ago(ms) {
    if (!ms) return 'never';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    const h = Math.round(min / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }

  const catalogById = id => (catalog || []).find(c => c.id === id);
  const hasSite = v => !!(v.localId && catalogById(v.localId) && catalogById(v.localId).hasSource);

  // ---------- Browse ----------
  async function refresh() {
    if (busy) return;
    busy = 'Loading events…';
    flash = null;
    render();
    const errors = [];
    let site = [], siteAt = '';
    try {
      const d = S.cleanSiteData(await loadJson('data/events.json'));
      site = d.events; siteAt = d.generatedAt; siteStatus = d.status;
      for (const v of state.venues) {
        const s = v.localId && d.status[v.localId];
        if (s && !s.ok) errors.push(v.name + ': the venue website could not be read last night.');
      }
    } catch (err) {
      errors.push('Venue website listings could not be loaded (' + err.message + ').');
    }
    let tm = [];
    if (state.apiKey) {
      const c = client();
      try {
        for (const v of state.venues) {
          if (v.localId && v.tmId === null) { busy = 'Looking up ' + v.name + ' on Ticketmaster…'; render(); v.tmId = await c.linkVenue(v, state.city); }
        }
        const tv = state.venues.filter(v => v.tmId);
        if (tv.length) {
          busy = 'Loading Ticketmaster events…'; render();
          const from = Date.now(), to = from + state.browse.days * 86400000;
          const r = await c.eventsForVenues(tv.map(v => ({ id: v.tmId, name: v.name })), { from, to });
          tm = r.events;
          errors.push(...r.errors.map(e => 'Ticketmaster – ' + e));
        }
      } catch (err) {
        errors.push('Ticketmaster: ' + err.message);
      }
    }
    const fromDate = E.localDate(Date.now()), toDate = E.localDate(Date.now() + state.browse.days * 86400000);
    state.cache = {
      fetchedAt: Date.now(), venueKey: S.venueKey(state.venues), siteAt,
      events: E.mergeEvents(state.venues, site, tm, fromDate, toDate), errors
    };
    persist();
    busy = '';
    render();
  }

  function renderBrowse() {
    const sec = el('section', { class: 'panel' });
    const c = state.cache;
    sec.append(el('div', { class: 'row head' },
      el('div', null,
        el('h2', { text: 'Upcoming at your venues' }),
        el('p', { class: 'sub', text: 'Next ' + state.browse.days + ' days · updated ' + ago(c.fetchedAt) +
          (c.siteAt ? ' · venue websites read ' + ago(Date.parse(c.siteAt)) : '') })),
      button('Refresh', refresh, { disabled: !!busy || !state.venues.length, class: 'primary' })));

    if (!state.venues.length) {
      sec.append(el('p', { class: 'note' }, catalog ? 'Pick the venues you want to watch. ' : 'Loading venues… ',
        button('Open Venues', go('venues'), { class: 'link' })));
      return sec;
    }
    if (!autoFetched && !busy && Date.now() - c.fetchedAt > 6 * 3600000) { autoFetched = true; setTimeout(refresh, 0); }
    if (c.fetchedAt && c.venueKey !== S.venueKey(state.venues)) sec.append(el('p', { class: 'note' }, 'Your venue list changed. Refresh to update the list.'));

    const noData = catalog ? state.venues.filter(v => !hasSite(v) && !v.tmId) : [];
    const names = list => list.map(v => v.name).join(', ');
    if (noData.length && !state.apiKey) {
      sec.append(el('p', { class: 'note' }, 'No listings yet for ' + names(noData) + '. These need Ticketmaster: ',
        button('add your key in Settings', go('settings'), { class: 'link' }), '.'));
    } else if (noData.length) {
      const pending = noData.filter(v => v.tmId === null), missing = noData.filter(v => v.tmId === '');
      if (pending.length) sec.append(el('p', { class: 'note', text: names(pending) + ' will be looked up on Ticketmaster at the next refresh.' }));
      if (missing.length) sec.append(el('p', { class: 'note', text: 'No listings found for ' + names(missing) + ' (not found on Ticketmaster, and no readable venue website yet).' }));
    }
    if (c.errors.length) sec.append(el('ul', { class: 'note warn errors' }, c.errors.map(t => el('li', { text: t }))));

    const counts = { all: c.events.length, music: 0, comedy: 0, other: 0 };
    for (const e of c.events) counts[e.kind]++;
    const kind = state.browse.kind;
    sec.append(el('div', { class: 'chips', role: 'group', 'aria-label': 'Show' },
      [['all', 'All'], ['music', 'Music'], ['comedy', 'Comedy'], ['other', 'Other']].map(([k, label]) =>
        el('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(kind === k),
          onclick: () => { state.browse.kind = k; persist(); render(); }
        }, label + ' ', el('span', { class: 'count', text: String(counts[k]) })))));

    const list = c.events.filter(e => kind === 'all' || e.kind === kind);
    if (!list.length) {
      sec.append(el('p', { class: 'empty', text: c.fetchedAt ? 'No events listed for this filter.' : 'No events loaded yet.' }));
      return sec;
    }
    const prefOf = new Map(state.venues.map(v => [v.id, v.pref]));
    let day = '', group = null;
    for (const e of list) {
      if (e.date !== day) {
        day = e.date;
        group = el('div', { class: 'day' }, el('h3', { text: E.formatDate(e.date) }));
        sec.append(group);
      }
      group.append(eventCard(e, prefOf.get(e.watchId)));
    }
    return sec;
  }

  const STATUS_LABEL = { postponed: 'Postponed', rescheduled: 'Rescheduled', soldout: 'Sold out' };
  const SOURCE_LABEL = { site: 'venue website', tm: 'Ticketmaster', both: 'venue website + Ticketmaster' };

  function eventCard(e, pref) {
    const actNames = e.acts.map(a => a.name).filter(n => n.toLowerCase() !== e.name.toLowerCase());
    const tags = [e.kind === 'music' ? 'Music' : e.kind === 'comedy' ? 'Comedy' : 'Other', ...e.genres];
    return el('article', { class: 'card kind-' + e.kind },
      el('div', { class: 'when', text: E.formatTime(e.time) }),
      el('div', { class: 'body' },
        el('h4', { text: e.name }),
        actNames.length ? el('p', { class: 'acts', text: 'With ' + actNames.join(', ') }) : null,
        el('p', { class: 'meta' },
          pref === 'love' ? el('span', { class: 'star', title: 'Favourite venue', text: '★ ' }) : null,
          e.venueName + ' · ',
          el('span', { class: e.price ? 'price' : 'price none', text: E.formatPrice(e.price) })),
        el('p', { class: 'tags' }, tags.map(t => tag(t)),
          STATUS_LABEL[e.status] ? tag(STATUS_LABEL[e.status], 'alert') : null,
          el('span', { class: 'via', text: 'via ' + SOURCE_LABEL[e.source] }))),
      e.url ? el('a', { class: 'tickets', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, 'Tickets') : null);
  }

  // ---------- Picks (digest) ----------
  const cacheStale = () => Date.now() - state.cache.fetchedAt > 6 * 3600000 || state.cache.venueKey !== S.venueKey(state.venues);
  const DAY = 86400000;

  async function makeDigest() {
    if (busy || !state.venues.length) return;
    if (cacheStale()) await refresh();
    if (busy) return;
    const c = state.cache;
    if (!c.events.length && c.errors.length) {
      flash = { kind: 'error', text: 'Could not load events, so no new digest was made. Try again later.' };
      render();
      return;
    }
    const d = state.digest;
    const r = Rk.buildDigest({
      events: c.events, venues: state.venues, today: E.localDate(Date.now()),
      windowDays: Math.min(60, state.browse.days), intervalDays: S.intervalDays(d),
      size: d.size, musicShare: d.musicShare, latestStart: d.latestStart, seen: new Set(d.seen)
    });
    d.current = {
      createdAt: Date.now(),
      picks: r.picks.map(p => ({ key: p.key, name: p.name, kind: p.kind, watchId: p.watchId, venueName: p.venueName, shows: p.shows, score: p.score, reasons: p.reasons, recurring: p.recurring })),
      counts: r.counts, want: r.want, short: r.short
    };
    d.lastAt = Date.now();
    d.seen = [...d.seen, ...r.picks.map(p => p.key)].slice(-3000);
    persist();
    render();
  }

  function dueText() {
    const d = state.digest;
    const due = Rk.nextDue(d.lastAt, d.interval, d.customDays);
    const days = Math.max(0, Math.ceil((due - Date.now()) / DAY));
    return 'Next digest ' + E.formatDate(E.localDate(due)) + (days ? ' (in ' + days + (days === 1 ? ' day)' : ' days)') : '');
  }

  function renderPicks() {
    const sec = el('section', { class: 'panel' });
    const d = state.digest, cur = d.current;
    sec.append(el('div', { class: 'row head' },
      el('div', null,
        el('h2', { text: 'Your picks' }),
        el('p', { class: 'sub', text: cur ? 'Made ' + E.formatDate(E.localDate(cur.createdAt)) + ' · ' + dueText() : 'Top new shows at your venues' })),
      cur ? button('New digest now', makeDigest, { disabled: !!busy || !state.venues.length, class: 'quiet' }) : null));

    if (!state.venues.length) {
      sec.append(el('p', { class: 'note' }, catalog ? 'Pick the venues you want to watch. ' : 'Loading venues… ',
        button('Open Venues', go('venues'), { class: 'link' })));
      return sec;
    }
    if (!autoDigest && !busy && Rk.isDue(d.lastAt, d.interval, d.customDays, Date.now())) {
      autoDigest = true;
      setTimeout(makeDigest, 0);
    }
    if (!cur) {
      sec.append(busy ? el('p', { class: 'empty', text: 'Making your first digest…' })
        : el('p', { class: 'empty' }, 'No digest yet. ', button('Make digest', makeDigest, { class: 'primary small' })));
      return sec;
    }

    const today = E.localDate(Date.now());
    const prefOf = new Map(state.venues.map(v => [v.id, v.pref]));
    const live = cur.picks.map(p => ({ ...p, shows: p.shows.filter(s => s.date >= today) })).filter(p => p.shows.length);
    const gone = cur.picks.length - live.length;

    const share = d.musicShare;
    sec.append(el('p', { class: 'mix' },
      cur.counts.music + ' music · ' + cur.counts.comedy + ' comedy',
      el('span', { class: 'sub', text: ' (your mix: ' + share + '% music, ' + (100 - share) + '% comedy)' })));
    for (const k of cur.short) {
      sec.append(el('p', { class: 'note', text: 'Not enough new ' + k + ' at your venues to fill ' + cur.want[k] + ' spots' +
        (k === 'comedy' ? ' – add a comedy venue on the Venues tab.' : ' – add a music venue on the Venues tab.') }));
    }
    if (!cur.picks.length) {
      sec.append(el('p', { class: 'empty', text: 'Nothing new since your last digest. Browse still lists every show.' }));
      return sec;
    }
    for (const p of live) sec.append(pickCard(p, prefOf.get(p.watchId)));
    if (gone) sec.append(el('p', { class: 'sub', text: gone + (gone === 1 ? ' pick has' : ' picks have') + ' already happened.' }));
    return sec;
  }

  function pickCard(p, pref) {
    const priced = p.shows.filter(s => s.price);
    const price = priced.length ? { min: Math.min(...priced.map(s => s.price.min)), max: Math.max(...priced.map(s => s.price.max)), currency: priced[0].price.currency } : null;
    const first = p.shows[0];
    const status = p.shows.map(s => STATUS_LABEL[s.status]).find(Boolean);
    return el('article', { class: 'pick card kind-' + p.kind },
      el('div', { class: 'body' },
        el('h4', { text: p.name }),
        el('p', { class: 'meta' },
          pref === 'love' ? el('span', { class: 'star', title: 'Favourite venue', text: '★ ' }) : null,
          p.venueName + ' · ',
          el('span', { class: price ? 'price' : 'price none', text: E.formatPrice(price) })),
        el('ul', { class: 'times', 'aria-label': 'Showtimes' }, p.shows.map(s => {
          const label = E.formatDate(s.date) + ' · ' + E.formatTime(s.time);
          return el('li', null, s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: label }) : label);
        })),
        el('p', { class: 'tags' },
          tag(p.kind === 'music' ? 'Music' : 'Comedy'), first.genres.slice(0, 2).map(g => tag(g)),
          status ? tag(status, 'alert') : null,
          p.reasons.length ? el('span', { class: 'why', text: 'Why: ' + p.reasons.join(' · ') }) : null)));
  }

  // ---------- Venues ----------
  function watchCatalog(c, tmId) {
    const existing = state.venues.find(v => v.localId === c.id);
    if (existing) { if (tmId) existing.tmId = tmId; }
    else state.venues.push({ ...S.fromCatalog(c), tmId: tmId === undefined ? null : tmId });
    persist();
    render();
  }

  /** A Ticketmaster venue that is also in the catalog becomes one watched venue with both sources. */
  function catalogTwin(v) {
    return (catalog || []).find(c => E.nameMatch(c.name, v.name) >= 0.8 &&
      (c.lat == null || v.lat == null || E.distanceMiles(c.lat, c.lon, v.lat, v.lon) <= 0.3));
  }

  function watchTm(v) {
    const twin = catalogTwin(v);
    if (twin) return watchCatalog(twin, v.id);
    if (!state.venues.some(x => x.tmId === v.id)) {
      state.venues.push({ id: 'tm:' + v.id, localId: '', tmId: v.id, name: v.name, address: v.address, city: v.city, state: v.state, lat: v.lat, lon: v.lon, pref: 'normal' });
    }
    persist();
    render();
  }

  function isWatchedTm(v) {
    if (state.venues.some(x => x.tmId === v.id)) return true;
    // Watched from the suggestions and not linked yet: the next refresh links it.
    const twin = catalogTwin(v);
    return !!(twin && state.venues.some(x => x.localId === twin.id && x.tmId === null));
  }

  function sourceBadges(v) {
    const out = [];
    if (hasSite(v)) out.push(tag('Venue website', 'src'));
    if (v.tmId) out.push(tag('Ticketmaster', 'src'));
    else if (v.tmId === '' && !hasSite(v)) out.push(tag('No listings source', 'alert'));
    else if (v.tmId === null && state.apiKey) out.push(tag('Ticketmaster: checked on next refresh'));
    return out;
  }

  function renderWatched() {
    const sec = el('section', { class: 'panel' }, el('h2', { text: 'Venues you watch' }));
    if (!state.venues.length) sec.append(el('p', { class: 'empty', text: 'None yet. Pick some from the suggestions below.' }));
    for (const v of state.venues) {
      sec.append(el('div', { class: 'row venue' },
        el('div', { class: 'grow' }, el('strong', { text: v.name }),
          el('div', { class: 'sub', text: [v.address, v.city].filter(Boolean).join(', ') }),
          el('div', { class: 'tags' }, sourceBadges(v))),
        el('label', { class: 'inline' }, el('span', { class: 'sr', text: 'Preference for ' + v.name }),
          el('select', { onchange: ev => { v.pref = ev.target.value; persist(); render(); } },
            [['love', 'Love'], ['normal', 'Normal'], ['low', 'Low']].map(([val, label]) =>
              el('option', { value: val, selected: v.pref === val }, label)))),
        button('Remove', () => { state.venues = state.venues.filter(x => x.id !== v.id); persist(); render(); }, { class: 'quiet' })));
    }
    return sec;
  }

  function suggestionLine(c) {
    if (c.hasSource) {
      const s = siteStatus[c.id];
      const extra = s ? (s.ok ? ' · ' + s.count + ' upcoming' : ' · last read failed') : '';
      return el('span', { class: 'data ok-text', text: 'Daily listings from the venue website' + extra });
    }
    if (c.tmLikely) return el('span', { class: 'data', text: 'Listings via Ticketmaster (' + c.ticketing + ')' + (state.apiKey ? '' : ' – needs your key') });
    return el('span', { class: 'data warn-text', text: 'No listings source yet' + (c.ticketing ? ' (sells through ' + c.ticketing + ')' : '') });
  }

  function renderSuggestions() {
    const sec = el('section', { class: 'panel' },
      el('h2', { text: 'Suggested venues' }),
      el('p', { class: 'sub', text: 'Music and comedy rooms within ' + state.city.radius + ' miles of ' + state.city.name + ', small ones included.' }));
    if (catalogError) { sec.append(el('p', { class: 'note warn', text: catalogError })); return sec; }
    if (!catalog) { sec.append(el('p', { class: 'empty', text: 'Loading…' })); return sec; }

    const ui = state.ui;
    const small = el('input', { type: 'checkbox', id: 'small-only', checked: ui.smallOnly });
    small.addEventListener('change', () => { ui.smallOnly = small.checked; persist(); render(); });
    sec.append(el('div', { class: 'row filters' },
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Venue type' },
        [['all', 'All'], ['music', 'Music'], ['comedy', 'Comedy']].map(([k, label]) => el('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(ui.suggestKind === k),
          onclick: () => { ui.suggestKind = k; persist(); render(); }
        }, label))),
      el('label', { class: 'check', for: 'small-only' }, small, ' Small rooms only')));

    const city = state.city;
    const list = catalog
      .map(c => ({ ...c, miles: E.distanceMiles(city.lat, city.lon, c.lat, c.lon) }))
      .filter(c => c.miles == null || c.miles <= city.radius)
      .filter(c => ui.suggestKind === 'all' || c.kinds.includes(ui.suggestKind))
      .filter(c => !ui.smallOnly || c.size === 'small')
      .sort((a, b) => (b.hasSource - a.hasSource) || (b.tmLikely - a.tmLikely) || a.name.localeCompare(b.name));
    if (!list.length) {
      sec.append(el('p', { class: 'empty', text: catalog.length ? 'No suggestions match here. Try the Ticketmaster search below.' : 'No suggested venues for this area yet. Use the Ticketmaster search below.' }));
      return sec;
    }
    for (const c of list) {
      const watched = state.venues.some(v => v.localId === c.id);
      sec.append(el('div', { class: 'row suggestion' },
        el('div', { class: 'grow' },
          el('strong', { text: c.name }),
          el('div', { class: 'sub', text: c.address + (c.miles != null ? ' · ' + c.miles.toFixed(1) + ' mi' : '') }),
          el('div', { class: 'tags' },
            c.kinds.map(k => tag(k === 'music' ? 'Music' : 'Comedy')),
            c.size === 'small' ? tag('Small room') : null,
            suggestionLine(c))),
        watched ? el('span', { class: 'badge', text: 'Watching' })
          : button('Watch', () => watchCatalog(c), { class: 'primary small', 'aria-label': 'Watch ' + c.name })));
    }
    return sec;
  }

  async function runTmSearch(kind, query) {
    if (busy) return;
    busy = kind === 'near' ? 'Listing Ticketmaster venues nearby…' : 'Searching Ticketmaster…';
    flash = null;
    render();
    try {
      const c = client();
      if (kind === 'near') {
        tmSearch = { title: 'Ticketmaster venues within ' + state.city.radius + ' miles', list: await c.nearbyVenues(state.city) };
      } else {
        const r = await c.findVenue(query, state.city);
        tmSearch = { title: 'Ticketmaster results for “' + query + '”', list: r.candidates, tried: r.tried };
      }
    } catch (err) {
      tmSearch = { error: err.message };
    }
    busy = '';
    render();
  }

  function renderTmSearch() {
    const sec = el('section', { class: 'panel' },
      el('h2', { text: 'Search Ticketmaster' }),
      el('p', { class: 'sub', text: 'For venues that are not in the suggestions.' }));
    if (!state.apiKey) {
      sec.append(el('p', { class: 'note' }, 'Needs your Ticketmaster API key. ', button('Open Settings', go('settings'), { class: 'link' })));
      return sec;
    }
    const input = el('input', { type: 'text', id: 'tm-query', placeholder: 'Venue name', maxlength: '100', autocomplete: 'off' });
    const search = () => { const q = input.value.trim(); if (q) runTmSearch('name', q); };
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') search(); });
    sec.append(el('div', { class: 'row add' },
      el('label', { for: 'tm-query', class: 'sr', text: 'Venue name' }), input,
      button('Search', search, { disabled: !!busy }),
      button('Show all nearby', () => runTmSearch('near'), { disabled: !!busy, class: 'quiet' })));
    if (tmSearch && tmSearch.error) sec.append(el('p', { class: 'note warn', text: tmSearch.error }));
    if (tmSearch && tmSearch.list) {
      sec.append(el('h3', { text: tmSearch.title }));
      if (!tmSearch.list.length) sec.append(el('p', { class: 'empty', text: 'Nothing found within ' + state.city.radius + ' miles' + (tmSearch.tried ? ' (searched: ' + tmSearch.tried.join(', ') + ').' : '.') }));
      for (const v of tmSearch.list) {
        sec.append(el('div', { class: 'row candidate' },
          el('div', { class: 'grow' },
            el('span', { text: v.name }),
            el('div', { class: 'sub' },
              [v.address, v.city, v.miles != null ? v.miles.toFixed(1) + ' mi' : ''].filter(Boolean).join(' · ') + ' · ',
              el('span', { class: v.upcoming ? '' : 'warn-text', text: v.upcoming == null ? 'event count unknown' : v.upcoming ? v.upcoming + ' upcoming events' : 'no upcoming events listed' }))),
          isWatchedTm(v) ? el('span', { class: 'badge', text: 'Watching' })
            : button('Watch', () => watchTm(v), { class: 'primary small', 'aria-label': 'Watch ' + v.name })));
      }
    }
    return sec;
  }

  function renderVenues() {
    return el('div', null, renderWatched(), renderSuggestions(), renderTmSearch());
  }

  // ---------- Settings ----------
  function renderSettings() {
    const wrap = el('div');

    const keyInput = el('input', {
      type: keyVisible ? 'text' : 'password', id: 'api-key', value: state.apiKey,
      autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: '128', placeholder: 'Consumer Key'
    });
    const saveKey = () => {
      const k = keyInput.value.trim();
      if (k && !/^[A-Za-z0-9]{8,128}$/.test(k)) { flash = { kind: 'error', text: 'That does not look like a Ticketmaster key (letters and digits only).' }; render(); return false; }
      if (k !== state.apiKey) {
        state.apiKey = k;
        // look venues up again with the new key
        for (const v of state.venues) if (v.localId && v.tmId === '') v.tmId = null;
        state.cache.fetchedAt = 0;   // reload Browse with the new key
        autoFetched = false;
      }
      persist();
      return true;
    };
    wrap.append(el('section', { class: 'panel' },
      el('h2', { text: 'Ticketmaster API key (optional)' }),
      el('p', { class: 'sub', text: 'Adds Ticketmaster listings and venue search. Stored only in this browser and never put in a backup file.' }),
      el('div', { class: 'row' },
        el('label', { for: 'api-key', class: 'sr', text: 'API key' }), keyInput,
        button(keyVisible ? 'Hide' : 'Show', () => { keyVisible = !keyVisible; render(); }, { class: 'quiet' })),
      el('div', { class: 'row' },
        button('Save key', () => { if (saveKey()) { flash = { kind: 'ok', text: state.apiKey ? 'Key saved.' : 'Key removed.' }; render(); } }, { class: 'primary' }),
        button('Test key', async () => {
          if (!saveKey() || busy) return;
          busy = 'Testing the key…'; flash = null; render();
          try { await client().testKey(); flash = { kind: 'ok', text: 'The key works.' }; } catch (err) { flash = { kind: 'error', text: err.message }; }
          busy = ''; render();
        }, { disabled: !!busy })),
      el('details', { open: !state.apiKey },
        el('summary', { text: 'How to get a key (free, about 5 minutes)' }),
        el('ol', null,
          el('li', null, 'Go to ', el('a', { href: 'https://developer.ticketmaster.com/', target: '_blank', rel: 'noopener noreferrer' }, 'developer.ticketmaster.com'), ' and choose Get your API key.'),
          el('li', { text: 'Register. Any app name is fine, for example "event-picks".' }),
          el('li', { text: 'Open My Apps and copy the Consumer Key (not the secret).' }),
          el('li', { text: 'Paste it above, then press Test key.' })))));

    const f = {
      name: el('input', { type: 'text', id: 'city-name', value: state.city.name, maxlength: '100' }),
      state: el('input', { type: 'text', id: 'city-state', value: state.city.state, maxlength: '2', class: 'short', autocapitalize: 'characters' }),
      lat: el('input', { type: 'number', id: 'city-lat', value: String(state.city.lat), step: 'any', min: '-90', max: '90' }),
      lon: el('input', { type: 'number', id: 'city-lon', value: String(state.city.lon), step: 'any', min: '-180', max: '180' }),
      radius: el('input', { type: 'number', id: 'city-radius', value: String(state.city.radius), min: '1', max: '200', class: 'short' })
    };
    const field = (id, label, input) => el('label', { class: 'field', for: id }, el('span', { text: label }), input);
    wrap.append(el('section', { class: 'panel' },
      el('h2', { text: 'Area' }),
      el('p', { class: 'sub', text: 'Suggestions and Ticketmaster searches use this centre point and radius. Changing it keeps your venues.' }),
      el('div', { class: 'grid' },
        field('city-name', 'City', f.name), field('city-state', 'State', f.state),
        field('city-lat', 'Latitude', f.lat), field('city-lon', 'Longitude', f.lon),
        field('city-radius', 'Radius (miles)', f.radius)),
      el('div', { class: 'row' },
        button('Save area', () => {
          const st = f.state.value.trim().toUpperCase();
          const lat = Number(f.lat.value), lon = Number(f.lon.value), radius = Number(f.radius.value);
          if (st && !/^[A-Z]{2}$/.test(st)) { flash = { kind: 'error', text: 'State should be a 2-letter code, such as OR.' }; render(); return; }
          if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || f.lat.value === '' || f.lon.value === '') { flash = { kind: 'error', text: 'Latitude and longitude need to be numbers.' }; render(); return; }
          if (!(radius >= 1 && radius <= 200)) { flash = { kind: 'error', text: 'Radius should be between 1 and 200 miles.' }; render(); return; }
          state.city = { ...state.city, name: f.name.value.trim() || state.city.name, state: st, lat, lon, radius: Math.round(radius) };
          tmSearch = null;
          persist();
          flash = { kind: 'ok', text: 'Area saved. The Venues tab now suggests venues for this area.' };
          render();
        }, { class: 'primary' }),
        'geolocation' in navigator ? button('Use my location', () => {
          navigator.geolocation.getCurrentPosition(
            pos => { f.lat.value = pos.coords.latitude.toFixed(4); f.lon.value = pos.coords.longitude.toFixed(4); },
            () => { flash = { kind: 'error', text: 'Could not get your location.' }; render(); },
            { timeout: 10000, maximumAge: 600000 });
        }) : null)));

    wrap.append(el('section', { class: 'panel' },
      el('h2', { text: 'Browse' }),
      el('label', { class: 'field', for: 'days' }, el('span', { text: 'Show events in the next' }),
        el('select', {
          id: 'days',
          onchange: ev => { state.browse.days = Number(ev.target.value); state.cache.fetchedAt = 0; autoFetched = false; persist(); flash = { kind: 'ok', text: 'Saved. Events reload when you open Browse.' }; render(); }
        }, [30, 60, 90, 180].map(d => el('option', { value: String(d), selected: state.browse.days === d }, d + ' days'))))));

    wrap.append(renderDigestSettings());

    const file = el('input', { type: 'file', id: 'import-file', accept: '.json,application/json', class: 'sr' });
    file.addEventListener('change', async () => {
      const fl = file.files && file.files[0];
      if (!fl) return;
      try {
        if (fl.size > 1000000) throw new Error('That file is too large to be a backup.');
        state = S.importData(await fl.text(), state);
        persist();
        flash = { kind: 'ok', text: 'Backup loaded: ' + state.venues.length + ' venues.' };
      } catch (err) {
        flash = { kind: 'error', text: err.message };
      }
      file.value = '';
      render();
    });
    wrap.append(el('section', { class: 'panel' },
      el('h2', { text: 'Backup' }),
      el('p', { class: 'sub', text: 'Move your venues and settings to another device: export here, import there. The API key is not included.' }),
      el('div', { class: 'row' },
        button('Export backup', () => {
          const blob = new Blob([S.exportData(state)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: 'event-picks-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }),
        el('label', { for: 'import-file', class: 'button-like' }, 'Import backup'), file)));
    return wrap;
  }

  function renderDigestSettings() {
    const d = state.digest;
    const saved = text => { persist(); flash = { kind: 'ok', text: text || 'Saved. Applies to your next digest.' }; render(); };

    const custom = el('input', { type: 'number', id: 'custom-days', value: String(d.customDays), min: '1', max: '180', class: 'short' });
    custom.addEventListener('change', () => {
      const n = Math.round(Number(custom.value));
      if (!(n >= 1 && n <= 180)) { flash = { kind: 'error', text: 'Days between digests should be 1 to 180.' }; render(); return; }
      d.customDays = n;
      saved(dueText() + '.');
    });
    const size = el('input', { type: 'number', id: 'digest-size', value: String(d.size), min: '3', max: '30', class: 'short' });
    size.addEventListener('change', () => {
      const n = Math.round(Number(size.value));
      if (!(n >= 3 && n <= 30)) { flash = { kind: 'error', text: 'Picks per digest should be 3 to 30.' }; render(); return; }
      d.size = n;
      saved();
    });
    const mixLabel = el('output', { for: 'music-share', id: 'mix-label', text: d.musicShare + '% music · ' + (100 - d.musicShare) + '% comedy' });
    const mix = el('input', { type: 'range', id: 'music-share', min: '0', max: '100', step: '10', value: String(d.musicShare) });
    mix.addEventListener('input', () => { const v = Number(mix.value); mixLabel.textContent = v + '% music · ' + (100 - v) + '% comedy'; });
    mix.addEventListener('change', () => { d.musicShare = Number(mix.value); saved(); });

    const field = (id, label, input, extra) => el('label', { class: 'field', for: id }, el('span', { text: label }), input, extra || null);
    return el('section', { class: 'panel' },
      el('h2', { text: 'Digest' }),
      el('p', { class: 'sub', text: 'A fresh set of picks appears on the Picks tab when you open the page after this interval. Only acts you have not been shown before.' }),
      el('div', { class: 'grid' },
        field('interval', 'New picks', el('select', {
          id: 'interval',
          onchange: ev => { d.interval = ev.target.value; saved(dueText() + '.'); }
        }, [['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['custom', 'Custom']].map(([v, l]) =>
          el('option', { value: v, selected: d.interval === v }, l)))),
        d.interval === 'custom' ? field('custom-days', 'Every (days)', custom) : null,
        field('digest-size', 'Picks per digest', size),
        field('latest-start', 'Latest start time', el('select', {
          id: 'latest-start',
          onchange: ev => { d.latestStart = ev.target.value; saved(); }
        }, [['', 'Any time'], ['19:00', '7 PM'], ['20:00', '8 PM'], ['21:00', '9 PM'], ['22:00', '10 PM'], ['23:00', '11 PM']].map(([v, l]) =>
          el('option', { value: v, selected: d.latestStart === v }, l))))),
      el('div', { class: 'field mixfield' }, el('label', { for: 'music-share', text: 'Music / comedy mix' }), mix, mixLabel),
      el('div', { class: 'row' },
        el('span', { class: 'sub grow', text: d.lastAt ? dueText() + '.' : 'Your first digest is made when you open Picks.' }),
        button('Forget past digests', () => {
          d.seen = [];
          saved('Past digests forgotten. Earlier picks can appear again.');
        }, { class: 'quiet', disabled: !d.seen.length })));
  }

  // ---------- start ----------
  async function start() {
    render();
    try {
      catalog = S.cleanCatalog(await loadJson('data/venues.json'));
      if (S.seedVenues(state, catalog)) persist();
    } catch (err) {
      catalog = [];
      catalogError = 'The suggested venues could not be loaded (' + err.message + ').';
    }
    try { siteStatus = S.cleanSiteData(await loadJson('data/events.json')).status; } catch (err) { /* shown on refresh */ }
    render();
  }
  start();
})();
