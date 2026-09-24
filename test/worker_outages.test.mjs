/* Electricity outage feeds: shape-tolerant normalisation, per-operator
   failure isolation, the per-state attempt budget, and the two routes.
   No network -- fetch and the Cache API are both stubbed, so this runs
   anywhere and asserts on what the Worker does with a response rather than
   on any operator actually being up.

   Run: node test/worker_outages.test.mjs */

const store = new Map();
globalThis.caches = {
  default: {
    async match(url) {
      const e = store.get(url);
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
    async put(url, res) { store.set(url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); }
  }
};

let upstream = {};
let fetchLog = [];
/* Most-specific match first; the bare 'http' key is a catch-all consulted
   only when nothing else matches. Plain insertion order bit this suite's
   predecessor twice. */
globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  const keys = Object.keys(upstream).filter((k) => k !== 'http').sort((a, b) => b.length - a.length);
  for (const k of keys) if (String(url).includes(k)) return upstream[k]();
  if (upstream.http) return upstream.http();
  return new Response('not stubbed', { status: 404 });
};

const worker = (await import('../src/worker.js')).default;
const env = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
const call = (p) => worker.fetch(new Request('https://example.test' + p), env, { waitUntil: () => {} });

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const json = (obj) => () => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
const readSharedCacheAge = async (key) => {
  const e = store.get(key);
  if (!e) return Infinity;
  return (Date.now() - Number(e.headers['x-fetched-at'] || 0)) / 1000;
};
const reset = () => { store.clear(); upstream = {}; fetchLog = []; };

console.log('\n== the shapes operators actually publish ==');
{
  reset();
  // A GeoJSON FeatureCollection, the most common of the three
  upstream['energex_po_current_unplanned'] = json({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [153.02, -27.47] },
      properties: {
        EVENT_ID: 'EQ-1', LOCALITY: 'Newtown', CUSTOMERSAFFECTED: 412,
        CAUSE: 'Equipment fault', STATUS: 'Crew on site',
        STARTTIME: '2026-09-17T04:00:00Z', ESTIMATEDRESTORATIONTIME: '2026-09-17T09:30:00Z'
      }
    }]
  });
  // A bare array with completely different field names
  upstream['energex_po_current_planned'] = json([
    { id: 'EQ-2', locality: 'Penrith', numCustomers: '1,205', reason: 'Storm damage',
      jobStatus: 'Assessing', reportedTime: 1758081600000, etr: '2026-09-17T12:00:00Z' }
  ]);
  // An object wrapping the list under an arbitrary key
  upstream['ergon_po_current_unplanned'] = json({
    result: { generated: 'now' },
    currentOutages: [{ outageID: 'ER-3', location: 'Dubbo', impactedCustomers: 37, faultType: 'Vegetation' }]
  });
  upstream['ergon_po_current_planned'] = json([]);

  const r = await call('/api/outages/qld');
  const b = await r.json();
  check('both operators reported', (b.networks || []).filter(n => n.ok).length === 2,
    (b.networks || []).map(n => n.name + ':' + n.ok));
  check('state is marked complete', b.complete === true, b.complete);
  check('rows merged across operators', b.count === 3, b.count);

  const ag = b.outages.find(o => o.location === 'Newtown');
  check('GeoJSON properties read', ag && ag.customers === 412 && ag.cause === 'Equipment fault', ag);
  check('coordinates carried through', ag && ag.lat === -27.47 && ag.lon === 153.02, ag);
  check('every row is tagged with its operator', b.outages.every(o => !!o.network),
    b.outages.map(o => o.network));

  const ee = b.outages.find(o => o.location === 'Penrith');
  check('"1,205" parses as a number', ee && ee.customers === 1205, ee && ee.customers);
  check('epoch-millisecond times get an ISO form', ee && !!ee.startIso, ee);
  check('the file a row came from decides planned vs unplanned',
    ee && ee.kind === 'planned' && ag.kind === 'unplanned', [ee && ee.kind, ag && ag.kind]);

  check('biggest outage sorts first', b.outages[0].location === 'Penrith', b.outages.map(o => o.location));
  check('customer totals add up', b.customers === 412 + 1205 + 37, b.customers);
}

console.log('\n== the text views: a table read by its own headings ==');
{
  reset();
  /* No operator's markup could be inspected from here, so the scraper is
     driven by the headings rather than by column positions. These three
     tables are deliberately different from each other. */
  const page = (inner) => () => new Response('<html><body>' + inner + '</body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });

  upstream['ausgrid.com.au'] = page(
    '<table><tr><td>nav</td></tr></table>' +           // a layout table, to be ignored
    '<table>' +
    '<tr><th>Suburb</th><th>Customers affected</th><th>Cause</th><th>Status</th>' +
    '<th>Estimated restoration</th></tr>' +
    '<tr><td>Newtown</td><td>412</td><td>Equipment fault</td><td>Crew on site</td>' +
    '<td>2026-09-17T09:30:00Z</td></tr>' +
    '<tr><td>Gosford</td><td>1,205</td><td>Storm damage</td><td>Assessing</td><td></td></tr>' +
    '</table>');

  // headings in a different order, different words, no <th> at all
  upstream['essentialenergy.com.au'] = page(
    '<table>' +
    '<tr><td>Outage type</td><td>Areas affected</td><td>No. of premises</td><td>Time off supply</td></tr>' +
    '<tr><td>Planned</td><td>Penrith</td><td>88</td><td>2026-09-17T04:00:00Z</td></tr>' +
    '</table>');

  const b = await (await call('/api/outages/nsw')).json();
  const ausgrid = b.networks.find(n => n.name === 'Ausgrid');
  check('the outage table is found among other tables', ausgrid.ok && ausgrid.count === 2, ausgrid);
  const newtown = b.outages.find(o => o.location === 'Newtown');
  check('columns map by heading, not position',
    newtown && newtown.customers === 412 && newtown.cause === 'Equipment fault', newtown);
  check('an estimated restoration is read', newtown && !!newtown.restoreIso, newtown);
  check('an empty cell does not become a value',
    b.outages.find(o => o.location === 'Gosford').restore === undefined,
    b.outages.find(o => o.location === 'Gosford'));

  const essential = b.networks.find(n => n.name === 'Essential Energy');
  check('a table with no <th> and different wording still reads', essential.ok && essential.count === 1, essential);
  const penrith = b.outages.find(o => o.location === 'Penrith');
  check('"Areas affected" is a location, not a customer count',
    penrith && penrith.location === 'Penrith' && penrith.customers === 88, penrith);
  check('"Outage type" sets planned', penrith && penrith.kind === 'planned', penrith && penrith.kind);
}

console.log('\n== a page that draws its list in the browser is diagnosed ==');
{
  reset();
  upstream['tasnetworks.com.au'] = () => new Response('<html><body><div id="app"></div></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/tas')).json();
  const net = b.networks[0];
  check('reported as a page with no table, not "failed"',
    net.diagnostics && net.diagnostics.envelope === 'no-table', net.diagnostics);
  check('and says what would actually fix it',
    net.diagnostics && /JavaScript/.test(net.diagnostics.note), net.diagnostics);
}

console.log('\n== Endeavour: two datasets merged, their fallbacks not double-counted ==');
{
  reset();
  /* The outage map draws its list in the browser, so Endeavour is read from
     their Opendatasoft open data portal instead. Unplanned and planned are
     separate datasets; each has an export and a capped /records fallback. */
  const ods = (rows) => json({ total_count: rows.length, results: rows });
  upstream['outagecustomerlive/exports/geojson'] = json({ type: 'FeatureCollection', features: [
    { geometry: { type: 'Point', coordinates: [150.99, -33.82] },
      properties: { reference: 'INC 1115105492', suburb: 'Greystanes',
        customers_affected: 120, estimated_restoration_time: '2026-09-24T04:30:00Z' } }] });
  upstream['plannedoutagecustomer/exports/geojson'] = json({ type: 'FeatureCollection', features: [
    { properties: { reference: 'INC 1115105769', suburb: 'Vineyard', customers_affected: 30 } }] });
  /* Both /records fallbacks also answer. If a part's fallback ran after its
     primary succeeded, every row would be counted twice. */
  upstream['outagecustomerlive/records'] = ods([{ reference: 'DUP-1', suburb: 'Greystanes' }]);
  upstream['plannedoutagecustomer/records'] = ods([{ reference: 'DUP-2', suburb: 'Vineyard' }]);

  const b = await (await call('/api/outages/nsw')).json();
  const e = b.networks.find(n => n.name === 'Endeavour Energy');
  check('both datasets contribute', e.ok && e.count === 2, e.count);
  check('and the fallbacks did not also run',
    !b.outages.some(o => /^DUP-/.test(o.id || '')), b.outages.map(o => o.id));
  const gs = b.outages.find(o => o.location === 'Greystanes');
  check('snake_case fields are read', gs && gs.customers === 120, gs);
  check('including the restoration estimate', gs && !!gs.restoreIso, gs);
  check('the INC reference is kept', gs && /1115105492/.test(gs.id || ''), gs && gs.id);
  check('the dataset decides planned vs unplanned',
    gs.kind === 'unplanned' && b.outages.find(o => o.location === 'Vineyard').kind === 'planned',
    b.outages.map(o => [o.location, o.kind]));
}

console.log('\n== Opendatasoft\'s /records envelope is read too ==');
{
  reset();
  upstream['outagecustomerlive/exports/geojson'] = () => new Response('down', { status: 503 });
  upstream['outagecustomerlive/records'] = json({ total_count: 1, results: [
    { reference: 'INC 9', suburb: 'Penrith', customers_affected: 7,
      geo_point_2d: { lon: 150.69, lat: -33.75 } }] });
  const b = await (await call('/api/outages/nsw')).json();
  const e = b.networks.find(n => n.name === 'Endeavour Energy');
  check('the fallback answers when the export is down', e.ok && e.count === 1, [e.ok, e.count, e.error]);
  const one = b.outages.find(o => o.location === 'Penrith');
  check('records are found inside the results envelope', !!one, b.outages);
  check('and a nested geo_point_2d becomes coordinates',
    one && one.lat === -33.75 && one.lon === 150.69, one);
}

console.log('\n== a table we cannot map reports its headings ==');
{
  reset();
  upstream['tasnetworks.com.au'] = () => new Response(
    '<html><table><tr><th>Widget</th><th>Sprocket</th></tr><tr><td>a</td><td>b</td></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/tas')).json();
  const d = b.networks[0].diagnostics;
  check('the mismatch is reported', d && d.envelope === 'table-unmapped', d);
  check('naming the headings it actually saw',
    d && d.sampleKeys.includes('Widget') && d.sampleKeys.includes('Sprocket'), d);
}

console.log('\n== an unreported count is absent, never zero ==');
{
  reset();
  upstream['sapowernetworks.com.au'] = json([
    { id: 'SA-1', suburb: 'Glenelg', cause: 'Fault' },                 // says nothing
    { id: 'SA-2', suburb: 'Prospect', customersAffected: 0, cause: 'Fault' } // says none
  ]);
  const b = await (await call('/api/outages/sa')).json();
  const quiet = b.outages.find(o => o.location === 'Glenelg');
  const zero = b.outages.find(o => o.location === 'Prospect');
  check('no count reported stays null', quiet && quiet.customers === null, quiet);
  check('a reported zero stays zero', zero && zero.customers === 0, zero);
}

console.log('\n== one operator failing never takes the state down ==');
{
  reset();
  upstream['ausgrid.com.au'] = () => new Response(
    '<html><table><tr><th>Suburb</th><th>Customers affected</th></tr>' +
    '<tr><td>Bondi</td><td>5</td></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  upstream['endeavourenergy.com.au'] = () => new Response('<html>Access denied</html>', { status: 403 });
  upstream['essentialenergy.com.au'] = () => new Response('nope', { status: 500 });

  const b = await (await call('/api/outages/nsw')).json();
  check('the state still reports', b.ok === true, b.ok);
  check('but is flagged incomplete', b.complete === false, b.complete);
  check('the working operator still lists its outage', b.count === 1, b.count);
  const dead = (b.networks || []).filter(n => !n.ok);
  check('both failures are named', dead.length === 2, dead.map(n => n.name));
  check('with the HTTP status, not a generic message',
    dead.every(n => /HTTP (403|500)/.test(n.error)), dead.map(n => n.error));
  check('and each keeps a link to its own map', dead.every(n => /^https:\/\//.test(n.site)), dead.map(n => n.site));
}

console.log('\n== reachable but unreadable is a parser fix, not an outage ==');
{
  reset();
  // A JSON feed answering 200 with records whose fields mean nothing to us
  upstream['WP_Outage_Prod'] = json([{ zzz: 1, qqq: 2 }, { zzz: 3, qqq: 4 }]);
  const b = await (await call('/api/outages/wa')).json();
  const net = b.networks.find(n => n.name === 'Western Power');
  check('the operator counts as reachable', net.ok === true, net);
  check('and says what it actually sent', net.diagnostics && net.diagnostics.recordsSeen === 2, net.diagnostics);
  check('naming the keys it did have',
    net.diagnostics && net.diagnostics.sampleKeys.includes('zzz'), net.diagnostics);
}

console.log('\n== a quiet network is not a broken one ==');
{
  reset();
  /* What an operator with nothing out actually publishes: the outage table,
     with its headings and no rows. */
  upstream['evoenergy.com.au'] = () => new Response(
    '<html><table><tr><th>Suburb</th><th>Customers affected</th><th>Cause</th></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/act')).json();
  check('empty list is ok', b.networks[0].ok === true, b.networks[0]);
  check('with no diagnostics attached', !b.networks[0].diagnostics, b.networks[0].diagnostics);
  check('and the state reads as complete', b.complete === true && b.count === 0, [b.complete, b.count]);
}

console.log('\n== the per-state attempt budget holds ==');
{
  reset();
  upstream.http = () => new Response('down', { status: 503 });   // everything fails
  fetchLog = [];
  await call('/api/outages/vic');                                // five operators, most with 1-2 URLs
  check('upstream attempts are capped', fetchLog.length <= 12, fetchLog.length);
  const b = await (await call('/api/outages/vic')).json();
  check('operators past the cap are not reported as failed',
    b.networks.some(n => /Not checked/.test(n.error || '')) || fetchLog.length < 12,
    b.networks.map(n => n.error));

  /* The ceiling has to clear the busiest state, not just bound it: at seven,
     NSW's eighth source -- Essential Energy's fallback -- was never reached
     and nothing said so. */
  reset();
  upstream.http = () => new Response('down', { status: 503 });
  fetchLog = [];
  await call('/api/outages/nsw');
  const nswSources = 8;
  check('every source in the busiest state gets a turn', fetchLog.length >= nswSources,
    [fetchLog.length, nswSources]);
}

console.log('\n== the routes ==');
{
  reset();
  upstream.http = json([{ id: 'x', suburb: 'Somewhere', customersAffected: 3 }]);
  const all = await call('/api/outages');
  const a = await all.json();
  check('/api/outages covers all eight states', (a.states || []).length === 8, (a.states || []).length);
  check('and carries per-network status', (a.states[0].networks || []).length > 0, a.states[0]);
  /* The aggregate is for the tab counts; shipping every row for every state
     would be a storm-sized payload the page never displays. */
  check('but not the rows themselves', a.states.every(s => s.outages === undefined),
    a.states.filter(s => s.outages !== undefined).map(s => s.state));

  const one = await call('/api/outages/qld');
  check('a state route does carry the rows', (await one.json()).outages.length > 0);

  const bad = await call('/api/outages/xyz');
  check('an unknown state is a 404, not a crash', bad.status === 404, bad.status);
}

console.log('\n== the cron refreshes outages in shards ==');
{
  reset();
  upstream.http = json([]);
  /* Outages run on odd ticks only -- they alternate with the incident
     refresh so one invocation never carries both. So the two ticks that
     cover the shards are 5 and 15 minutes apart, not 5. */
  /* Read the per-state cache keys directly rather than through /api/outages:
     that route warms this location as a side effect, which would count as
     work the cron did. */
  const cached = () => [...store.keys()]
    .filter(k => k.includes('/outages/'))
    .map(k => k.split('/outages/')[1].toUpperCase());
  const runTick = async (minute) => {
    const waits = [];
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 24, 0, minute) }, env,
      { waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    return cached();
  };

  /* An even tick does the incidents instead. Asserted positively -- that the
     incident caches get written -- rather than by checking that no outage
     cache did: warming promises started by an earlier block's /api/outages
     call are still in flight and can land in this store, which would make a
     negative assertion flap for reasons that have nothing to do with the
     cron. */
  const even = await runTick(0);
  const incidentKeys = [...store.keys()].filter(k => k.includes('/incidents/'));
  check('an even tick runs the incident refresh', incidentKeys.length > 0, incidentKeys.length);

  const first = await runTick(5);
  check('an odd tick refreshes outage states', first.length > 0, first);
  check('but only its own shard', first.length < 8, first);

  const second = await runTick(15);
  check('the next odd tick covers the rest', second.length === 8,
    ['NSW','QLD','VIC','SA','WA','TAS','NT','ACT'].filter(s => second.indexOf(s) === -1));
}

console.log('\n== Queensland: two complementary files, merged ==');
{
  reset();
  /* Energy Queensland splits planned from unplanned across separate files
     rather than flagging it per record, so the file is the only thing that
     knows which it is. */
  upstream['energex_po_current_unplanned'] = json({ type: 'FeatureCollection', features: [
    { properties: { EVENT_ID: 'EQ1', LOCALITY: 'Ipswich', CUSTOMERSAFFECTED: 60 } }] });
  upstream['energex_po_current_planned'] = json({ type: 'FeatureCollection', features: [
    { properties: { EVENT_ID: 'EQ2', LOCALITY: 'Redcliffe', CUSTOMERSAFFECTED: 20 } }] });
  upstream['ergon_po_current_unplanned'] = json({ type: 'FeatureCollection', features: [
    { properties: { EVENT_ID: 'ER1', LOCALITY: 'Cairns', CUSTOMERSAFFECTED: 300 } }] });
  upstream['ergon_po_current_planned'] = json({ type: 'FeatureCollection', features: [] });

  const b = await (await call('/api/outages/qld')).json();
  check('both files contribute to one operator', b.count === 3, b.count);
  const energex = b.networks.find(n => n.name === 'Energex');
  check('Energex merges rather than stopping at the first file', energex.count === 2, energex.count);
  const planned = b.outages.find(o => o.location === 'Redcliffe');
  const unplanned = b.outages.find(o => o.location === 'Ipswich');
  check('the planned file marks its rows planned', planned && planned.kind === 'planned', planned);
  check('and the unplanned file marks its own', unplanned && unplanned.kind === 'unplanned', unplanned);
  check('an empty complementary file is not a failure',
    b.networks.find(n => n.name === 'Ergon Energy').ok === true);
}

console.log('\n== Western Power: a boolean flag, not a word ==');
{
  reset();
  // The real column names from its feature service
  upstream['WP_Outage_Prod'] = json({ type: 'FeatureCollection', features: [
    { properties: { INCIDENTREF: 'WP-1', AFFECTED_AREA: 'Mandurah', NOCUSTOMERSIMPACTED: 730,
      AFFECTED_AREA_NOCUSTOMERS: 12, PLANNEDOUTAGE: 'No', OUTAGETYPE: 'Distribution',
      OUTAGESTARTTIME: 1789000000000, ESTIMATEDRESTORATIONTIME: 1789010000000 } },
    { properties: { INCIDENTREF: 'WP-2', AFFECTED_AREA: 'Bunbury', NOCUSTOMERSIMPACTED: 12,
      PLANNEDOUTAGE: true, OUTAGETYPE: 'Distribution' } }]});
  const b = await (await call('/api/outages/wa')).json();
  const wp = b.networks.find(n => n.name === 'Western Power');
  check('the service is read', wp.ok && wp.count === 2, wp);
  const one = b.outages.find(o => o.location === 'Mandurah');
  check('AFFECTED_AREA is the location', !!one, b.outages.map(o => o.location));
  check('the total count wins over the per-area breakdown', one.customers === 730, one.customers);
  check('"No" means unplanned, not unlabelled', one.kind === 'unplanned', one.kind);
  check('a true flag means planned',
    b.outages.find(o => o.location === 'Bunbury').kind === 'planned',
    b.outages.find(o => o.location === 'Bunbury'));
  check('epoch times become ISO', !!one.startIso && !!one.restoreIso, one);
  check('INCIDENTREF is carried as the id', one.id === 'WP-1', one.id);
}

console.log('\n== an unconnected feed is not a reported outage ==');
{
  reset();
  upstream.http = () => new Response('not found', { status: 404 });
  const nsw = await (await call('/api/outages/nsw')).json();
  const guessed = nsw.networks.filter(n => n.name !== 'Endeavour Energy');
  check('operators with no confirmed feed say so',
    guessed.every(n => n.unconfirmed === true), guessed.map(n => [n.name, n.unconfirmed]));
  check('a confirmed one does not', !nsw.networks.find(n => n.name === 'Endeavour Energy').unconfirmed);
  const wa = await (await call('/api/outages/wa')).json();
  const wp = wa.networks.find(n => n.name === 'Western Power');
  check('a confirmed feed failing is a plain failure, not "unconnected"',
    wp.ok === false && !wp.unconfirmed, wp);
  check('and still reports the status it got', /404/.test(wp.error), wp.error);
}


console.log('\n== every API response says which build answered ==');
{
  reset();
  upstream.http = json([]);
  const src = (await import('node:fs')).readFileSync('./src/worker.js', 'utf8');
  const build = /const WORKER_BUILD = '([^']+)'/.exec(src)[1];
  for (const route of ['/api/outages', '/api/outages/qld', '/api/incidents', '/api/incidents/nt', '/api/news']) {
    const r = await call(route);
    check(route + ' carries the build', r.headers.get('X-Worker-Build') === build,
      [route, r.headers.get('X-Worker-Build')]);
  }
  /* The build stamp is about the code, the cache age is about the data --
     a cached body from before a deploy must still report the running build,
     or "did it deploy?" stays unanswerable. */
  await call('/api/outages/qld');
  const again = await call('/api/outages/qld');
  check('a cache hit still reports the running build',
    again.headers.get('X-Worker-Build') === build && again.headers.get('X-Cache-Age') !== null,
    [again.headers.get('X-Worker-Build'), again.headers.get('X-Cache-Age')]);
}


console.log('\n== a datacentre the cron never ran in fills itself ==');
{
  /* The Cache API is per datacentre and the cron only warms the one it runs
     in. The aggregate is built purely from cache reads and makes no upstream
     call of its own, so every other location answered "eight states, none
     reporting" -- and cached that non-answer for two hours. That is how every
     tab showed (!) while the feeds themselves were fine. */
  const coldStart = () => { reset(); upstream.http = json([{ suburb: 'Somewhere', customersAffected: 10 }]); };

  let waits = [];
  const callWarm = async (p) => {
    const r = await worker.fetch(new Request('https://example.test' + p), env,
      { waitUntil: (q) => waits.push(q) });
    await Promise.all(waits); waits = [];
    return r;
  };
  const okStates = (b) => b.states.filter(s => s.ok).length;
  const AGG = 'https://newsradar-internal-cache.example/outages-all';
  const MARKER = 'https://newsradar-internal-cache.example/outages-warmed-at';

  coldStart();
  const first = await (await callWarm('/api/outages')).json();
  check('the first request still answers', first.states.length === 8, first.states.length);
  /* Warming runs after the response, so the visitor who triggers it is not
     the one who benefits -- their answer is the empty one, and the next
     request is where it shows. Paying for the wait would defeat the point. */
  check('and does not wait for the warming it started', okStates(first) === 0, okStates(first));
  const shown = await (await callWarm('/api/outages')).json();
  check('the next request sees what was warmed', okStates(shown) > 0, okStates(shown));
  check('a couple of states at a time', okStates(shown) <= 2, okStates(shown));

  /* If the empty aggregate were cached, warming could never show through:
     every later request in this location would be served the non-answer.
     Observed with warming discarded, since a warm that has already run would
     have replaced it with a real one. */
  coldStart();
  await worker.fetch(new Request('https://example.test/api/outages'), env, { waitUntil: () => {} });
  check('an aggregate with nothing in it is not cached', !store.has(AGG), [...store.keys()]);

  /* Rate limited per datacentre, so a burst of visitors doesn't each start
     their own sweep of the same operators. */
  coldStart();
  await callWarm('/api/outages');
  const b = await (await callWarm('/api/outages')).json();
  const c = await (await callWarm('/api/outages')).json();
  check('a request within the interval warms nothing more',
    okStates(c) === okStates(b), [okStates(b), okStates(c)]);

  let last = c;
  for (let i = 0; i < 6; i++) {
    store.delete(MARKER);
    last = await (await callWarm('/api/outages')).json();
  }
  check('and over a few page loads the location is complete', okStates(last) === 8,
    last.states.filter(s => !s.ok).map(s => s.state));
  check('once something is reporting, the aggregate is cached', store.has(AGG));
}


console.log('\n== one cron tick stays inside the subrequest ceiling ==');
{
  /* A Worker invocation may make at most 50 subrequests and everything the
     cron queues shares one. Doing all three refreshes every tick reached 58,
     so the last requests issued threw -- and since they run concurrently,
     which refresh got starved varied tick to tick. That is what "some feeds
     populate and some never do" looked like from outside.

     Measured with every upstream failing, which is the worst case: failures
     are what make a feed try its fallbacks. */
  const CEILING = 50;
  const ticks = [];
  for (const minute of [0, 5, 10, 15, 20, 25]) {
    reset();
    upstream.http = () => new Response('down', { status: 503 });
    fetchLog = [];
    const waits = [];
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 24, 0, minute) }, env,
      { waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
    ticks.push(fetchLog.length);
  }
  const worst = Math.max.apply(null, ticks);
  check('no tick comes close to the ceiling', worst <= CEILING - 8, { ticks, worst, CEILING });

  /* Both halves of the alternation have to be affordable, not just the
     average -- a cheap tick does not pay for an expensive one. */
  check('both tick parities do real work', ticks.every(t => t > 10), ticks);
}


console.log('\n== a day-first date is never silently transposed ==');
{
  reset();
  /* Ausgrid's list gives dates as 23/09/2026. Date.parse reads d/m/y as US
     month-first, so 09/03/2026 -- 3 March here -- comes back as 3 September.
     A confidently wrong date is worse than no date. */
  upstream['ausgrid.com.au'] = () => new Response(
    '<html><table><tr><th>Suburb</th><th>Customers affected</th><th>Start</th></tr>' +
    '<tr><td>Waterloo</td><td>158</td><td>09/03/2026</td></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/nsw')).json();
  const one = b.outages.find(o => o.location === 'Waterloo');
  check('the row still reads', !!one && one.customers === 158, one);
  check('the date is kept exactly as published', one.start === '09/03/2026', one.start);
  check('and no ISO is invented from it', one.startIso === undefined, one.startIso);
}

console.log('\n== a scrape reports the columns it saw ==');
{
  reset();
  upstream['ausgrid.com.au'] = () => new Response(
    '<html><table>' +
    '<tr><th>Suburb</th><th>Customers affected</th><th>Start</th><th>Job reason</th></tr>' +
    '<tr><td>Coogee</td><td>13</td><td>23/09/2026</td><td>Storm</td></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/nsw')).json();
  const ag = b.networks.find(n => n.name === 'Ausgrid');
  /* Reported on success, not only on failure: a scrape that works but yields
     three fields is how you learn the table has columns you aren't reading,
     and the headings are the only way to find out which. */
  check('the headings come back with a working scrape',
    (ag.columns || []).includes('Customers affected'), ag.columns);
  check('including ones that were not mapped', (ag.columns || []).includes('Job reason'), ag.columns);
}

console.log('\n== an operator that blocks robots is not a broken URL ==');
{
  reset();
  /* Essential Energy answers a Cloudflare challenge rather than the page. */
  upstream['essentialenergy.com.au'] = () => new Response(
    '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>',
    { status: 403, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/outages/nsw')).json();
  const ee = b.networks.find(n => n.name === 'Essential Energy');
  check('it is marked as blocking, not as unavailable', ee.blocked === true, ee);
  check('and not as a feed we have yet to find', !ee.unconfirmed, ee);
  check('the reason says what it actually is', /blocks automated access/i.test(ee.error), ee.error);
  /* The fallback not answering is a separate fact and is reported as one --
     "this operator blocks us" stays true either way, and it is the part that
     says no amount of URL-fixing will help. */
  check('and mentions the fallback separately', /fallback did not answer/i.test(ee.error), ee.error);
  check('their own map is still offered', /^https:\/\//.test(ee.site), ee.site);
}


console.log('\n== a JSON feed whose field names were never seen before ==');
{
  reset();
  /* An exhaustive list of field names can't be kept for a publisher whose
     schema has never been inspected. When the exact names miss, the keys are
     read the way a table's headings are read -- same vocabulary, substring
     rather than exact. This is the difference between reading the feed and
     declaring the whole thing unreadable over one unlisted word. */
  upstream['outagecustomerlive/exports/geojson'] = json({ type: 'FeatureCollection', features: [
    { properties: {
      outage_reference_no: 'INC 42',
      affected_locality_name: 'Katoomba',
      number_of_customers_impacted: 64,
      customer_type: 'Residential',          // matches the word, is not a count
      outage_reason_description: 'Fallen branch'
    } }] });
  const b = await (await call('/api/outages/nsw')).json();
  const e = b.networks.find(n => n.name === 'Endeavour Energy');
  check('the feed reads instead of being declared unreadable', e.ok && e.count === 1, [e.ok, e.count, e.diagnostics]);
  const one = b.outages.find(o => o.location === 'Katoomba');
  check('an unlisted location field is still found', !!one, b.outages);
  check('an unlisted count field too', one && one.customers === 64, one && one.customers);
  check('and a non-numeric near-match is not mistaken for the count',
    one && one.customers !== 'Residential', one && one.customers);
  check('the field names are reported either way', (e.columns || []).includes('outage_reference_no'), e.columns);
}

console.log('\n== an aggregator is used, and said to be an aggregator ==');
{
  reset();
  /* Essential Energy blocks automated access to its own page, so the
     fallback is a third party -- which the payload has to admit to. */
  upstream['essentialenergy.com.au'] = () => new Response(
    '<html><title>Just a moment...</title></html>', { status: 403 });
  upstream['poweroutagesaustralia.com.au'] = () => new Response(
    '<html><table><tr><th>Suburb</th><th>Customers affected</th></tr>' +
    '<tr><td>Armidale</td><td>107</td></tr></table></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });

  const b = await (await call('/api/outages/nsw')).json();
  const ee = b.networks.find(n => n.name === 'Essential Energy');
  check('the fallback answers', ee.ok && ee.count === 1, [ee.ok, ee.count, ee.error]);
  check('and is attributed, not passed off as the operator', ee.via === 'Power Outages Australia', ee.via);
  check('the operator own page is still what is linked',
    /essentialenergy\.com\.au/.test(ee.site), ee.site);
  check('the operator own page was tried first',
    /essentialenergy\.com\.au/.test((ee.attempts || [])[0].url), ee.attempts);
}


console.log('\n== a state written once does not stay frozen forever ==');
{
  /* The failure this reproduces: a datacentre the cron never runs in writes
     a state once on a cold start, and from then on every request is served
     that same entry. It keeps answering, so nothing looks broken -- while the
     figures, and the build that produced them, stay fixed. A payload written
     before a deploy was still being served after it, old URLs and all. */
  reset();
  upstream.http = json([{ suburb: 'Somewhere', customersAffected: 10 }]);
  let waits = [];
  const callWarm = async (p) => {
    const r = await worker.fetch(new Request('https://example.test' + p), env,
      { waitUntil: (q) => waits.push(q) });
    await Promise.all(waits); waits = [];
    return r;
  };
  const MARKER = 'https://newsradar-internal-cache.example/outages-warmed-at';
  const KEY = 'https://newsradar-internal-cache.example/outages/nsw';
  const nswHits = () => fetchLog.filter(u => /ausgrid|endeavour|essential|poweroutagesaustralia/.test(u)).length;

  const first = await (await callWarm('/api/outages/nsw')).json();
  check('a cold state populates on request', first.ok === true, first.ok);

  /* Fill the rest, so what follows is about staleness rather than about
     states that were simply never fetched -- those are warmed first, by
     design. */
  for (let i = 0; i < 8; i++) { store.delete(MARKER); await callWarm('/api/outages'); }

  /* Measured in upstream calls rather than timestamps: two builds a
     millisecond apart carry the same Date.now(), so comparing them proves
     nothing on a fast machine. */
  store.delete(MARKER);
  fetchLog = [];
  await callWarm('/api/outages/nsw');
  check('a fresh state is not refetched', nswHits() === 0, fetchLog);

  /* Age it past the threshold, the way a real entry ages. */
  const aged = store.get(KEY);
  aged.headers['x-fetched-at'] = String(Date.now() - 30 * 60 * 1000);
  store.set(KEY, aged);
  store.delete(MARKER);

  fetchLog = [];
  await callWarm('/api/outages/nsw');
  check('a stale state is refetched', nswHits() > 0, fetchLog);
  check('and its entry is fresh again', (await readSharedCacheAge(KEY)) < 60,
    await readSharedCacheAge(KEY));
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
