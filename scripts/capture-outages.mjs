/* Captures every state's outage list by running the Worker's OWN outage
   code in Node, merges it with the browser capture, and writes the
   snapshot the Worker serves (data/outages.json).

   Why this exists. Cloudflare reported the Worker hitting the free plan's
   10ms-per-invocation CPU limit 100+ times a day, and measuring it showed
   outage parsing is the worst of it -- NSW alone about 300ms. On the free
   plan that work cannot live in the Worker, so it runs here, on an Actions
   runner where CPU is not the constraint, and the Worker serves the result.

   It is the same code, not a reimplementation: the Worker module is
   imported and asked for each state through its own route, with an
   in-memory stand-in for the Cache API and the real network. So the
   snapshot reads exactly what the live Worker read -- the same parsers, the
   same staleness filter, the same "has this job started" rule -- and a fix
   to a parser fixes both at once.

   OUTAGE_LIVE_FETCH is passed in the env this script builds. The deployed
   Worker serves the snapshot unless that is set, and it is set only here
   (and would be set in wrangler.jsonc on a paid plan, where the CPU budget
   allows the Worker to fetch live again).

   Usage:
     node scripts/capture-outages.mjs                 feeds only, merged with
                                                      the committed snapshot
     node scripts/capture-outages.mjs --with-browser  the browser scrape has
                                                      just written
                                                      data/outages.json in
                                                      this same run; its rows
                                                      may fill gaps */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { mergeOutageSnapshot } from './lib/merge-outage-snapshot.mjs';

const argv = process.argv.slice(2);
const WITH_BROWSER = argv.includes('--with-browser');
const OUT = 'data/outages.json';

/* The Cache API, in memory. Per-process, so every state is a cold read and
   goes to the operators. */
const store = new Map();
globalThis.caches = {
  default: {
    async match(url) {
      const e = store.get(String(url));
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
    async put(url, res) {
      store.set(String(url), { body: await res.text(), headers: Object.fromEntries(res.headers) });
    }
  }
};

const mod = await import('../src/worker.js');
const worker = mod.default;
const STATES = Object.keys(mod.OUTAGE_NETWORKS);
/* ASSETS answers 404 so the Worker merges no snapshot into what it reads:
   this has to be the raw feed result, not the feed result blended with the
   very file being rewritten. */
const env = {
  OUTAGE_LIVE_FETCH: '1',
  ASSETS: { fetch: async () => new Response('not here', { status: 404 }) }
};

const startedAt = Date.now();
const captured = {};
await Promise.all(STATES.map(async (st) => {
  const t0 = Date.now();
  const waits = [];
  try {
    const res = await worker.fetch(new Request('https://capture.local/api/outages/' + st), env,
      { waitUntil: (p) => waits.push(p) });
    captured[st] = await res.json();
  } catch (e) {
    captured[st] = { state: st.toUpperCase(), ok: false, error: 'capture threw: ' + e.message,
      networks: (mod.OUTAGE_NETWORKS[st].networks || []).map((n) => ({ name: n.name, ok: false, count: 0,
        error: 'capture threw: ' + e.message })), outages: [] };
  }
  await Promise.allSettled(waits);
  const p = captured[st];
  console.log('  ' + st.padEnd(4) + String((p.outages || []).length).padStart(5) + ' rows  '
    + String(Date.now() - t0).padStart(6) + 'ms   ' + (p.networks || [])
      .map((n) => n.name + (n.ok ? '=' + n.count : '=FAIL')).join(', '));
  /* Every source that failed, including ones a later fallback covered: a
     fallback answering is exactly when a silent change of source happens. */
  (p.networks || []).forEach((n) => (n.attempts || []).forEach((a) =>
    console.log('        ' + n.name + ' tried ' + String(a.url).slice(0, 90) + '\n            -> ' + String(a.error).slice(0, 160))));
  (p.networks || []).filter((n) => n.ok && n.sourceUrl).forEach((n) =>
    console.log('        ' + n.name + ' answered from ' + String(n.sourceUrl).slice(0, 110)));
}));

/* In the Worker's own state order, not the order the fetches happened to
   finish -- otherwise the committed file reshuffles on every run and each
   commit's diff is the whole file. */
const feedStates = {};
STATES.forEach((st) => { if (captured[st]) feedStates[st] = captured[st]; });

/* What was there before. With --with-browser it is the browser capture
   from moments ago in this same job; otherwise it is the last committed
   snapshot, used only for short-lived fallback and for totals. */
let existing = null;
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) { existing = null; }
}
/* --with-browser only counts if the file really was written moments ago.
   The workflow runs this step even when the browser step failed, and in
   that case the file on disk is the LAST committed snapshot -- treating it
   as a fresh browser read would put hours-old rows back on the map, which
   is the one thing the merge rules exist to prevent. */
const BROWSER_FRESH_MS = 30 * 60000;
const browserIsFresh = WITH_BROWSER && existing && existing.capturedAt
  && (Date.now() - existing.capturedAt) <= BROWSER_FRESH_MS;
if (WITH_BROWSER && !browserIsFresh) {
  console.log('--with-browser given, but ' + OUT + ' was not written by this run'
    + (existing && existing.capturedAt ? ' (captured ' + Math.round((Date.now() - existing.capturedAt) / 60000) + ' min ago)' : '')
    + ' -- treating it as the previous snapshot, not as a browser capture');
}
const browserStates = browserIsFresh ? existing.states : null;
const browserCapturedAt = browserIsFresh ? existing.capturedAt : null;
const previous = browserIsFresh ? null : existing;

const { snapshot, coverage } = mergeOutageSnapshot(feedStates, browserStates, previous,
  { now: Date.now(), browserCapturedAt });

mkdirSync('data', { recursive: true });
/* One-space indent rather than none: the file is committed every run, and
   a line per field keeps those commits readable as diffs. */
writeFileSync(OUT, JSON.stringify(snapshot, null, 1) + '\n');

console.log('\n== coverage, operator by operator ==');
coverage.forEach((c) => console.log('  ' + c.state.padEnd(4) + c.network.padEnd(32)
  + (c.ok ? String(c.count).padStart(5) + ' rows' : '   -- none') + '   from ' + c.source
  + (c.reported ? '   + published total' : '')));
const totals = Object.entries(snapshot.states).map(([st, v]) => st.toUpperCase() + ' ' + v.count);
console.log('\nwrote ' + OUT + ' (' + Math.round(JSON.stringify(snapshot).length / 1024) + ' KB)  '
  + totals.join(', ') + '   in ' + (Date.now() - startedAt) + 'ms');
