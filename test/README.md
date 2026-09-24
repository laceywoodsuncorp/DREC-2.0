# Tests

These used to live in a scratch directory outside the repo and were lost when
the build container was recycled. They are in the repo now so that doesn't
happen again.

## Worker tests (no network, no browser)

```sh
node test/worker_outages.test.mjs
node test/nt_incidents.test.mjs
node test/scrape_trigger.test.mjs
node test/build_stamp.test.mjs
```

`build_stamp` compares `WORKER_BUILD` in `src/worker.js` with
`EXPECTED_WORKER_BUILD` in the page. They live in different files that deploy
together, and bumping one without the other makes the dashboard tell its
reader to redeploy a Worker that is perfectly current — which is what it did
for seven builds. A warning that fires when nothing is wrong gets the next
real one ignored too.

`fetch` and the Cache API are stubbed, so these assert what the Worker does
with a given response rather than whether any operator is up — which matters,
because the build environment has no outbound access to these hosts.

## Browser tests

Need a local copy of the dashboard and the mock API server:

```sh
SCRATCH=$(mktemp -d)
npm install --no-save --prefix "$SCRATCH" leaflet
test/harness/stage.sh "$SCRATCH"
node test/harness/mockserver.js --root "$SCRATCH/testsite" &
node test/outages_ui.test.js
```

The server listens on 8845 and the test looks there; set `MOCK_PORT` on both
to use another.

`stage.sh` rewrites three things **in the copy only** — Leaflet is pointed at
the local package, and the API routes gain `location.search` so a test can
select a scenario per page load. The real page must never contain
`location.search`; check with:

```sh
grep -c "location.search" index_updated_abc_emergency_map.html   # must be 0
grep -c "unpkg.com/leaflet" index_updated_abc_emergency_map.html # must be 2
```

Chromium and Playwright are found at the paths in `CHROME_PATH` /
`PLAYWRIGHT_PATH`, defaulting to this image's locations.

## The outage scraper agent

`scripts/scrape-outages.mjs` drives a real browser over each distributor's own
outage page and writes `data/outages.json`, which the Worker then serves as the
primary source for any operator it covers. It exists because most of these
lists only render after JavaScript runs, so a Worker `fetch` sees an empty
shell.

Run it from GitHub: **Actions → Scrape outages → Run workflow** (optionally
naming states, e.g. `nsw,vic`). It commits the snapshot itself.

Locally:

```sh
npm install --no-save playwright
npx playwright install chromium
node scripts/scrape-outages.mjs --only nsw
```

Pages it cannot read are saved to `artifacts/` as rendered HTML plus a
screenshot, and uploaded by the workflow. That is the fastest way to add a
missing site: the artifact shows what the list actually looks like once
rendered.

It does not attempt to get past bot challenges. An operator that blocks
automated access is recorded as blocked and skipped.

### The "Refresh capture" button

`/api/scrape` starts the scraper workflow. `GET` reports whether it is
configured and any cooldown; `POST` dispatches it. The GitHub token is a
Worker secret (`npx wrangler secret put SCRAPE_TOKEN`) and never reaches the
browser — `test/scrape_trigger.test.mjs` pins that, along with the cooldown,
GET never starting a run, and caller input never reaching the workflow
unchecked.


## Routes that were investigated and ruled out

Kept so these are not re-investigated. All findings are from live captures
recorded in `data/scrape-diagnostics.json`.

Four operators put a bot challenge in front of their own outage page --
Essential Energy, Horizon Power and Power and Water behind Cloudflare, SA
Power Networks behind Incapsula. None were bypassed. Energex and Ergon are
challenged too but are read from their published ArcGIS layers instead, and
that is the pattern every other route below was looking for.

**State emergency agencies** -- no outage data. Emergency WA's incident feed
and Alert SA mention none. Worth revisiting only during a major event, when
an agency may publish something it does not carry day to day.

**ArcGIS organisation directories** -- nothing outside Queensland. The NSW
emergency organisation publishes 187 services, all flooding, aged care and
similar; no distributor outage layer. Queensland is the exception because
the Reconstruction Authority chose to republish Energex's and Ergon's
layers.

**Open data portals** -- only Endeavour runs one. Eleven Opendatasoft
hostnames failed DNS with `data.endeavourenergy.com.au` answering as the
control, and the state CKAN portals return no live outage datasets.

**GeoBlackout** -- not a source. Its per-distributor pages render a map and
nothing readable; the only JSON they fetch is map styling. Its Horizon Power
and Power and Water pages are 404.

**Is Your Power Out (`api.isyourpowerout.com`)** -- a real ingestion
pipeline over the distributors' feeds, and still not usable here, for three
reasons found by sampling it:

  * Its outage records carry no place name. The fields are id, provider,
    state, title, description, status, type, customersAffected, startTime,
    estimatedRestoreTime, lastUpdated, centroid, geometry. `title` is
    generic ("Ergon outage"), `description` is the cause, and the only
    location is a lat/lng centroid. Town-level accuracy is the point of this
    tile, and no amount of plumbing gets a town out of a coordinate without
    inventing it.
  * `total` is 27,408 against 200 rows returned, and Energex alone reports
    5,662 planned outages. Those are accumulated records, not what is out
    now, so even the totals would need a filter nobody has documented --
    `/api/outages/unplanned` and `/api/outages/list` answer 400, and no
    OpenAPI document is published.
  * At least one provider's `lastSuccessfulIngestion` was four months stale
    while the API still served its rows.

The discovery probes that found all this need `--probe`; they are not part
of the daily capture. Left switched on they pushed the run past the job's
limit twice, and both runs were killed before writing anything.
