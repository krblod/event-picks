# Event Picks

Browser-only tool that watches local venues for concerts and comedy. No server, no build step,
no npm dependencies. Your venues and settings stay in your browser.

Two sources of listings:
- **Venue websites**: a nightly GitHub Actions job (`.github/workflows/fetch-events.yml`) reads the
  venues in `data/venues.json` and publishes `data/events.json` next to the app. Works without any key.
- **Ticketmaster** (optional): add a free Consumer Key in Settings for more venues and venue search.

## Use it
1. Open the page (GitHub Pages, or locally: `node tools/serve.js`, then http://localhost:8080).
2. Venues: tick suggested venues (filter Music / Comedy / Small rooms), or search Ticketmaster.
3. Picks: your digest of top new shows, made when you open the page after the interval
   (Settings > Digest: every week / 2 weeks / month / custom, picks per digest, latest start time,
   music/comedy mix). One pick per act with all its showtimes; open mics, jams, classes and
   sold-out shows are left out.
4. Browse: every upcoming event. Search box, sort by date or by venue, and a Filters panel:
   when (tonight / this weekend / 7 / 30 days), venues, days of the week, start time, max price
   (keep or drop unpriced shows), hide sold out, hide "not for me", liked acts only.
   Filters are remembered; the search text is not.
5. 👍 / 👎 / Hide on any pick or show. 👍 boosts the act and teaches genres, title words and venues;
   👎 means the act is never picked again; Hide just removes that show. The Likes tab lists your
   ratings, favourite artists and comedians, and what the ranking has learned. When your likes lean
   clearly one way, Picks suggests a new music/comedy mix.

Move to another device with Settings > **Export backup** / **Import backup** (the key is not included).

## Install and offline
Settings > **Install app** puts Event Picks on your home screen (Chrome/Android: Install button;
iPhone: Safari > Share > Add to Home Screen). After one visit it opens offline with your last listings
and current picks. When a new version is published, a banner offers **Reload**.
On iPhone, the Home Screen app has its own storage: export a backup in Safari and import it in the app.

## Venue websites
`node tools/fetch-events.js` reads every venue with `sources` and rewrites `data/events.json` when
something changed. One request at a time with a pause, robots.txt honoured. Readers (`tools/readers.js`):

| type | what it reads | venues |
|---|---|---|
| `wlcr` | WordPress `/wp-json/wlcr/v1/events/raw` | Revolution Hall, Show Bar, Mississippi Studios, Polaris Hall, Aladdin |
| `crowdwork` | `crowdwork.com/api/v2/<theatre>/shows` | Curious Comedy, Kickstand |
| `jsonld` | schema.org Event data in the page | Helium, Laurelthirst |
| `tribe` | The Events Calendar `/wp-json/tribe/events/v1/events` | Crystal Ballroom |
| `holocene` | `/api/events` | Holocene |

Add a venue: add an entry to `data/venues.json` (coordinates from OpenStreetMap), with a source if
its website has one of the formats above. Venue sizes are approximate.

## Tests
    node test/run-tests.js                              # unit tests (all network calls use canned responses)
    NODE_PATH=$(npm root -g) node test/ui-tests.js      # browser tests, needs Playwright + Chromium
