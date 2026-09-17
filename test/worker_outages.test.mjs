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
  upstream['ausgrid.com.au'] = json({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [151.2, -33.87] },
      properties: {
        outageId: 'AG-1', suburb: 'Newtown', customersAffected: 412,
        cause: 'Equipment fault', status: 'Crew on site',
        startTime: '2026-09-17T04:00:00Z', estimatedRestorationTime: '2026-09-17T09:30:00Z',
        type: 'Unplanned'
      }
    }]
  });
  // A bare array with completely different field names
  upstream['endeavourenergy.com.au'] = json([
    { id: 'EE-9', locality: 'Penrith', numCustomers: '1,205', reason: 'Storm damage',
      jobStatus: 'Assessing', reportedTime: 1758081600000, etr: '2026-09-17T12:00:00Z', worktype: 'Planned works' }
  ]);
  // An object wrapping the list under an arbitrary key
  upstream['essentialenergy.com.au'] = json({
    result: { generated: 'now' },
    currentOutages: [{ outageID: 'ES-3', location: 'Dubbo', impactedCustomers: 37, faultType: 'Vegetation' }]
  });

  const r = await call('/api/outages/nsw');
  const b = await r.json();
  check('all three operators reported', (b.networks || []).filter(n => n.ok).length === 3,
    (b.networks || []).map(n => n.name + ':' + n.ok));
  check('state is marked complete', b.complete === true, b.complete);
  check('rows merged across operators', b.count === 3, b.count);

  const ag = b.outages.find(o => o.location === 'Newtown');
  check('GeoJSON properties read', ag && ag.customers === 412 && ag.cause === 'Equipment fault', ag);
  check('coordinates carried through', ag && ag.lat === -33.87 && ag.lon === 151.2, ag);
  check('every row is tagged with its operator', b.outages.every(o => !!o.network),
    b.outages.map(o => o.network));

  const ee = b.outages.find(o => o.location === 'Penrith');
  check('"1,205" parses as a number', ee && ee.customers === 1205, ee && ee.customers);
  check('epoch-millisecond times get an ISO form', ee && !!ee.startIso, ee);
  check('planned work is labelled planned', ee && ee.kind === 'planned', ee && ee.kind);
  check('a fault is labelled unplanned', ag && ag.kind === 'unplanned', ag && ag.kind);

  check('biggest outage sorts first', b.outages[0].location === 'Penrith', b.outages.map(o => o.location));
  check('customer totals add up', b.customers === 412 + 1205 + 37, b.customers);
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
  upstream['ausgrid.com.au'] = json([{ id: 'A', suburb: 'Bondi', customersAffected: 5 }]);
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
  // Answers 200 with records whose fields mean nothing to us
  upstream['tasnetworks.com.au'] = json([{ zzz: 1, qqq: 2 }, { zzz: 3, qqq: 4 }]);
  const b = await (await call('/api/outages/tas')).json();
  const net = b.networks[0];
  check('the operator counts as reachable', net.ok === true, net);
  check('and says what it actually sent', net.diagnostics && net.diagnostics.recordsSeen === 2, net.diagnostics);
  check('naming the keys it did have',
    net.diagnostics && net.diagnostics.sampleKeys.includes('zzz'), net.diagnostics);
}

console.log('\n== a quiet network is not a broken one ==');
{
  reset();
  upstream['evoenergy.com.au'] = json([]);
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

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
