/* Power Outages Australia's national feed, read for the operators whose
   own pages cannot be read.

   The fixture is a trim of the real feed (data/poa-feed-sample.json, 19
   Oct 2026): real record shapes -- suburbs as {name, postcode}, centre as
   [lon, lat], POA's own `sources` health list. Its times are shifted to be
   relative to now, so the fixture never ages into the stale filter.

   What must hold:
     - each network takes only its own rows, with towns, a point, a count
     - a quiet network POA collects reads as quiet, not unreadable
     - a network POA does not collect, or says it failed to, is unreadable,
       never a confident zero
     - a feed POA stopped generating is not served as current
     - through the Worker: the feed is fetched once for every network that
       reads it, and its rows say whose account they are

   Run: node test/poa_outages.test.mjs */
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./fixtures/poa-feed.json', import.meta.url), 'utf8'));
const shift = Date.now() - Date.parse(raw.generatedAt);
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
const relative = (v) => (typeof v === 'string' && ISO.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v);
const feed = () => {
  const j = JSON.parse(JSON.stringify(raw));
  j.generatedAt = relative(j.generatedAt);
  j.outages.forEach((o) => { o.startTime = relative(o.startTime); o.estimatedRestoration = relative(o.estimatedRestoration); });
  return j;
};

let pass = 0, fail = 0;
const ck = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); }
};

/* The Worker module reads fetch and caches at import; both are stubbed. */
let upstream = {};
let fetchLog = [];
globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  for (const k of Object.keys(upstream).sort((a, b) => b.length - a.length)) {
    if (String(url).includes(k)) return upstream[k]();
  }
  return new Response('<html><title>Just a moment...</title></html>', { status: 403 });
};
const store = new Map();
globalThis.caches = { default: {
  match: async (k) => { const v = store.get(String(k.url || k)); return v ? v.clone() : undefined; },
  put: async (k, v) => { store.set(String(k.url || k), v.clone()); },
  delete: async (k) => store.delete(String(k.url || k))
} };
const mod = await import('../src/worker.js');
const { parsePoaOutages, POA_FEED_URL, clearSharedSources } = mod;

console.log('\n== each network takes its own rows ==');
{
  const j = feed();
  const r = parsePoaOutages('Essential Energy')(j);
  const want = j.outages.filter((o) => o.distributor === 'Essential Energy').length;
  ck('all of Essential Energy’s rows, and only those', !r.diagnostics && r.outages.length === want, [r.outages.length, want, r.diagnostics]);
  const multi = r.outages.find((o) => (o.towns || []).length > 3);
  ck('suburb objects become town names', multi && multi.towns.every((t) => typeof t === 'string' && t.length > 1), multi && multi.towns);
  ck('every row has a point in Australia', r.outages.every((o) => o.lat < -9 && o.lat > -45 && o.lon > 110 && o.lon < 155),
    r.outages.map((o) => [o.lat, o.lon]));
  ck('and a customer count', r.outages.every((o) => typeof o.customers === 'number'), r.outages.map((o) => o.customers));
  const planned = r.outages.filter((o) => o.kind === 'planned').length;
  const src = j.outages.filter((o) => o.distributor === 'Essential Energy' && (o.scheduled || o.type === 'planned')).length;
  ck('planned work is classed as planned', planned === src, [planned, src]);
  ck('POA’s bare "active" is not shown as a status', r.outages.every((o) => o.status !== 'active'), r.outages.map((o) => o.status));

  const sa = parsePoaOutages('SA Power Networks')(j);
  const crew = j.outages.find((o) => o.distributor === 'SA Power Networks' && o.crewStatus);
  ck('the operator’s own crew wording is kept',
    !crew || sa.outages.some((o) => o.status === crew.crewStatus), crew && crew.crewStatus);
  ck('SA Power Networks gets its own', !sa.diagnostics && sa.outages.length === j.outages.filter((o) => o.distributor === 'SA Power Networks').length);
  ck('and none of Essential Energy’s', !sa.outages.some((o) => r.outages.some((e) => e.id === o.id)));
}

console.log('\n== quiet is not unknown ==');
{
  /* Jemena is in POA's `sources` with ok:true and count 0, and absent from
     byDistributor because it has nothing out. That is a quiet network. */
  const r = parsePoaOutages('Jemena')(feed());
  ck('a network POA collects with nothing out reads as quiet', !r.diagnostics && r.outages.length === 0, r);
}

console.log('\n== unknown is never a confident zero ==');
{
  const r = parsePoaOutages('Power and Water Corporation')(feed());
  ck('a network POA does not collect is unreadable', !!r.diagnostics && r.outages.length === 0, r);

  const j = feed();
  j.sources.find((s) => s.name === 'Horizon Power').ok = false;
  const h = parsePoaOutages('Horizon Power')(j);
  ck('a network whose collection POA says failed is unreadable', !!h.diagnostics, h);

  const old = feed();
  old.generatedAt = new Date(Date.now() - 5 * 3600e3).toISOString();
  const st = parsePoaOutages('Essential Energy')(old);
  ck('a feed POA stopped generating is not served as current', !!st.diagnostics && /minutes ago/.test(st.diagnostics.note), st.diagnostics);

  const bad = parsePoaOutages('Essential Energy')({ data: [] });
  ck('a changed envelope says so', !!bad.diagnostics && bad.diagnostics.envelope === 'unrecognised', bad);
}

console.log('\n== through the Worker ==');
{
  clearSharedSources();
  store.clear();
  fetchLog = [];
  upstream = { 'poa-outages-api': () => new Response(JSON.stringify(feed()), { headers: { 'Content-Type': 'application/json' } }) };
  const env = { OUTAGE_LIVE_FETCH: '1', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  const ctx = { waitUntil() {} };
  const b = await (await mod.default.fetch(new Request('https://example.test/api/outages/vic'), env, ctx)).json();
  const an = b.networks.find((n) => n.name === 'AusNet Services');
  const ue = b.networks.find((n) => n.name === 'United Energy');
  const jm = b.networks.find((n) => n.name === 'Jemena');
  ck('AusNet is read through POA when its own pages fail', an && an.ok && an.count > 0, an && [an.ok, an.count, an.error]);
  ck('and says so', an && an.via === 'Power Outages Australia' && /distributor=ausnet-services$/.test(an.viaUrl), an && [an.via, an.viaUrl]);
  ck('its own map is still the link', an && /ausnetservices\.com\.au/.test(an.site), an && an.site);
  ck('United Energy too', ue && ue.ok && ue.via === 'Power Outages Australia', ue && [ue.ok, ue.error]);
  ck('Jemena reads as quiet, not missing', jm && jm.ok && jm.count === 0, jm && [jm.ok, jm.error, jm.diagnostics]);
  const rows = b.outages.filter((o) => o.network === 'AusNet Services');
  ck('each of its rows carries whose account it is', rows.length > 0 && rows.every((o) => o.via === 'Power Outages Australia'), rows.slice(0, 2));
  const feedHits = fetchLog.filter((u) => u === POA_FEED_URL).length;
  ck('the national feed was fetched once for all three', feedHits === 1, { feedHits, fetchLog });
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
