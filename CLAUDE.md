# Event Picks

Browser-only app (static files, GitHub Pages) listing concerts and comedy at venues the user watches.
Sources: venue websites (nightly GitHub Actions job writes `data/events.json`) and, optionally,
Ticketmaster Discovery API v2 from the browser with the user's key. Default area Portland, OR, 20 miles.
Version in `BUILD` (js/events.js).

## Layout
- `index.html`, `css/styles.css`; `js/` vanilla-JS UMD modules: `events.js` (normalise/format/merge, pure),
  `store.js` (localStorage + sanitize + backup + catalog/events-file validation), `api.js` (Ticketmaster), `app.js` (UI).
- `data/venues.json` suggested venues (catalog, with `sources`); `data/events.json` written by the job.
- `tools/fetch-events.js` nightly job, `tools/readers.js` one reader per website format, `tools/serve.js` local server.
- `.github/workflows/fetch-events.yml` runs the job daily and commits `data/events.json`.
- `test/run-tests.js` unit, `test/ui-tests.js` Playwright (Ticketmaster and events file mocked; real catalog).

## Model
Watched venue: `localId` (catalog id: venue-website listings) and/or `tmId` (Ticketmaster id;
null = not looked up yet, '' = not found). `mergeEvents` puts site events first and folds in the
Ticketmaster twin (same venue + date + `sameShow`) to fill price/link. Watched venues live only in the browser.

## Rules to keep
- Never use innerHTML; CSP meta: `script-src 'self'`, `connect-src 'self' https://app.ticketmaster.com`.
- Everything from storage/backup goes through `EPStore.sanitize`; catalog through `cleanCatalog`;
  events file through `cleanSiteData` (ids must start `site:`); API data through `normalizeEvent`/`normalizeVenue`.
- The API key is never exported or committed. Stay under 5 requests/second to Ticketmaster.
- Nightly job: one request at a time, pause between requests, honour robots.txt, identify itself.
- Bump `BUILD` when shipped files change.

## Plan (phases)
0/1 venue picking + Browse; 1b suggested venues + venue-website source (done, v0.2.0);
2 ranking + digest with changeable interval (default monthly, new events only);
3 thumbs up/down learning, Hide, Likes tab; 4 offline service worker, home-screen install, publish to GitHub Pages.
No notifications by design. Not readable yet: Doug Fir, Wonder Ballroom, Roseland, Hawthorne, Alberta Rose
(rhp-events plugin loads lists by script), Siren, Funhouse, Kelly's Olympian, Old Church.
