# Tests

These used to live in a scratch directory outside the repo and were lost when
the build container was recycled. They are in the repo now so that doesn't
happen again.

## Worker tests (no network, no browser)

```sh
node test/worker_outages.test.mjs
node test/nt_incidents.test.mjs
```

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
