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
  upstream['endeavourenergy.com.au'] = page(
    '<table>' +
    '<tr><td>Outage type</td><td>Areas affected</td><td>No. of premises</td><td>Time off supply</td></tr>' +
    '<tr><td>Planned</td><td>Penrith</td><td>88</td><td>2026-09-17T04:00:00Z</td></tr>' +
    '</table>');

  upstream['essentialenergy.com.au'] = page('<div id="app"></div>');   // a JS-rendered page

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

  const endeavour = b.networks.find(n => n.name === 'Endeavour Energy');
  check('a table with no <th> and different wording still reads', endeavour.ok && endeavour.count === 1, endeavour);
  const penrith = b.outages.find(o => o.location === 'Penrith');
  check('"Areas affected" is a location, not a customer count',
    penrith && penrith.location === 'Penrith' && penrith.customers === 88, penrith);
  check('"Outage type" sets planned', penrith && penrith.kind === 'planned', penrith && penrith.kind);

  const essential = b.networks.find(n => n.name === 'Essential Energy');
  check('a JavaScript-rendered page is diagnosed, not just "failed"',
    essential.diagnostics && essential.diagnostics.envelope === 'no-table', essential.diagnostics);
  check('and says what would actually fix it',
    essential.diagnostics && /JavaScript/.test(essential.diagnostics.note), essential.diagnostics);
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
  check('upstream attempts are capped', fetchLog.length <= 7, fetchLog.length);
  const b = await (await call('/api/outages/vic')).json();
  check('operators past the cap are not reported as failed',
    b.networks.some(n => /Not checked/.test(n.error || '')) || fetchLog.length < 7,
    b.networks.map(n => n.error));
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
  const waits = [];
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 17, 0, 0) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const a1 = await (await call('/api/outages')).json();
  const first = a1.states.filter(s => s.ok).map(s => s.state);
  check('a tick refreshes some states, not all', first.length > 0 && first.length < 8, first);

  const waits2 = [];
  await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 17, 0, 5) }, env, { waitUntil: (p) => waits2.push(p) });
  await Promise.all(waits2);
  const a2 = await (await call('/api/outages')).json();
  check('the next tick covers the rest', a2.states.filter(s => s.ok).length === 8,
    a2.states.filter(s => !s.ok).map(s => s.state));
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
  check('operators with no confirmed feed say so',
    nsw.networks.every(n => n.unconfirmed === true), nsw.networks.map(n => [n.name, n.unconfirmed]));
  const wa = await (await call('/api/outages/wa')).json();
  const wp = wa.networks.find(n => n.name === 'Western Power');
  check('a confirmed feed failing is a plain failure, not "unconnected"',
    wp.ok === false && !wp.unconfirmed, wp);
  check('and still reports the status it got', /404/.test(wp.error), wp.error);
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
