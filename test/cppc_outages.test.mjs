/* CitiPower and Powercor's shared live outage feed.

     https://s3-ap-southeast-2.amazonaws.com/cppc-outage/outages.json

   Found among the requests the two companies' outage-map pages make for
   themselves. On 16 October it held 22 outages where the browser, reading
   the rendered list pages, had 17 and 0, and the Worker's plain fetch of
   those pages had nothing -- so this is what keeps Victoria on the map once
   outages are captured on a runner rather than by a browser.

   The fixture is a verbatim trim of the real file (five rows, polygons cut
   to four points). Its dates are rewritten relative to now when it is
   loaded: left as published they would age past the staleness filter in two
   days, which is exactly how fifteen assertions in worker_outages failed at
   once when that filter arrived.

   What this guards:
     - ONE file, TWO operators: each takes only its own rows. The scraper once
       read this platform's shared list from both sites and showed every
       outage twice with the totals doubled.
     - rows sharing an ORDER_ID are one outage across several towns
     - a changed format reads as unrecognised, never as a quiet zero

   Run: node test/cppc_outages.test.mjs */
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cppc-outages.json', import.meta.url), 'utf8'));

/* "HH:MM DD-MM-YYYY" as Melbourne wall time (AEDT, UTC+11), the feed's own
   format, for an instant relative to now. */
const melb = (offsetMs) => {
  const d = new Date(Date.now() + offsetMs + 11 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' '
    + p(d.getUTCDate()) + '-' + p(d.getUTCMonth() + 1) + '-' + d.getUTCFullYear();
};
const H = 3600000;
const current = JSON.parse(JSON.stringify(fixture));
current.ROWSET.ROW.forEach((r) => { r.START_TIME = melb(-2 * H); r.ETR = melb(3 * H); });

let feedBody = JSON.stringify(current);
const store = new Map();
globalThis.caches = { default: {
  async match(u) { const e = store.get(String(u)); return e ? new Response(e) : undefined; },
  async put(u, r) { store.set(String(u), await r.text()); } } };
globalThis.fetch = async (url) => /cppc-outage\/outages\.json/.test(String(url))
  ? new Response(feedBody, { status: 200, headers: { 'Content-Type': 'application/json' } })
  : new Response('down', { status: 503 });

const mod = await import('../src/worker.js');
const worker = mod.default;
const env = { OUTAGE_LIVE_FETCH: '1', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
const vic = async () => {
  store.clear();
  return (await worker.fetch(new Request('https://x/api/outages/vic'), env, { waitUntil() {} })).json();
};

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

console.log('== the config points both operators at the feed first ==');
const nets = mod.OUTAGE_NETWORKS.vic.networks;
for (const name of ['Powercor', 'CitiPower']) {
  const n = nets.find((x) => x.name === name);
  ck(name + ' reads the S3 feed first', n && /cppc-outage\/outages\.json/.test(n.sources[0].url), n && n.sources[0].url);
  ck(name + ' keeps its list page as a fallback', n && n.sources.length >= 2, n && n.sources.length);
  ck(name + ' is marked confirmed', n && n.confirmed === true);
}

console.log('\n== each operator takes only its own rows ==');
const b = await vic();
const pc = b.networks.find((n) => n.name === 'Powercor');
const cp = b.networks.find((n) => n.name === 'CitiPower');
ck('Powercor reads', pc && pc.ok, pc);
ck('CitiPower reads', cp && cp.ok, cp);
/* Five rows: Powercor's order 2399289-1 across YALCA and YIELIMA, Powercor's
   CONNEWARRE, and CitiPower's BRUNSWICK and CAMBERWELL. */
ck('Powercor has its 2 outages', pc && pc.count === 2, pc && pc.count);
ck('CitiPower has its 2 outages', cp && cp.count === 2, cp && cp.count);
const byNet = (net) => b.outages.filter((o) => o.network === net);
ck('no Powercor town is listed under CitiPower',
  !byNet('CitiPower').some((o) => /YALCA|YIELIMA|CONNEWARRE/.test(o.location)), byNet('CitiPower').map((o) => o.location));
ck('no CitiPower town is listed under Powercor',
  !byNet('Powercor').some((o) => /BRUNSWICK|CAMBERWELL/.test(o.location)), byNet('Powercor').map((o) => o.location));
const fixtureCustomers = fixture.ROWSET.ROW.reduce((t, r) => t + Number(r.CUSTOMERS || 0), 0);
ck('every customer is counted once', b.customers === fixtureCustomers, { got: b.customers, expected: fixtureCustomers });

console.log('\n== one order across several towns is one outage ==');
const yalca = b.outages.find((o) => (o.towns || []).includes('YALCA'));
ck('YALCA and YIELIMA are one outage', yalca && (yalca.towns || []).includes('YIELIMA'), yalca);
const yRows = fixture.ROWSET.ROW.filter((r) => /^2399289/.test(r.ORDER_ID));
ck('its customers are the sum of its rows',
  yalca && yalca.customers === yRows.reduce((t, r) => t + Number(r.CUSTOMERS), 0), yalca && yalca.customers);

console.log('\n== the rest of each row ==');
const brunswick = b.outages.find((o) => /BRUNSWICK/.test(o.location));
const camberwell = b.outages.find((o) => /CAMBERWELL/.test(o.location));
ck('"Planned outage" is planned', brunswick && brunswick.kind === 'planned', brunswick && brunswick.kind);
ck('"Under investigation" is not planned', camberwell && camberwell.kind !== 'planned', camberwell && camberwell.kind);
ck('CREW_STATUS is read as the status', !!(camberwell && camberwell.status), camberwell && camberwell.status);
ck('ORDER_ID is read as the id', camberwell && camberwell.id === '2399568-1', camberwell && camberwell.id);
ck('every outage is placed inside Victoria',
  b.outages.every((o) => o.lat < -33.9 && o.lat > -39.3 && o.lon > 140.9 && o.lon < 150.1),
  b.outages.map((o) => [o.lat, o.lon]));
ck('none is mistaken for stale', !pc.staleDropped && !cp.staleDropped, { pc: pc.staleDropped, cp: cp.staleDropped });
ck('and no transposed ISO is invented from "HH:MM DD-MM-YYYY"', b.outages.every((o) => o.startIso === undefined),
  b.outages.map((o) => o.startIso));

console.log('\n== a quiet day versus a changed format ==');
feedBody = JSON.stringify({ ROWSET: { createDateTime: 'now', ROW: [] } });
const quiet = await vic();
ck('an empty ROWSET is an ordinary zero',
  quiet.networks.find((n) => n.name === 'Powercor').ok && quiet.networks.find((n) => n.name === 'Powercor').count === 0,
  quiet.networks.find((n) => n.name === 'Powercor'));
feedBody = JSON.stringify({ outages: [{ town: 'X' }] });
const moved = await vic();
const pcMoved = moved.networks.find((n) => n.name === 'Powercor');
/* Its list page is the fallback and is stubbed down, so the operator must
   read as failed -- not as "Powercor: 0 outages". */
ck('a file without ROWSET is not reported as zero outages', !pcMoved.ok, pcMoved);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
