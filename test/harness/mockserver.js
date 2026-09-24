/* Serves a local copy of the dashboard with every /api route stubbed, so the
   browser tests can drive real UI states (a working operator, a failing one,
   an unreadable one) without touching a live endpoint -- which this build
   environment could not reach anyway.

   The page is staged into <scratch>/testsite/index.html with three rewrites
   (see stage.sh): Leaflet is pointed at a local copy, and the two API routes
   gain location.search so a test can select a scenario per page load.

   Usage: node test/harness/mockserver.js [--root <dir>] [--port 8845]
   Scenarios, chosen with ?outages=<name>:
     live       all operators reporting
     partial    one operator down
     drift      an operator answers in an unrecognised shape
     quiet      everyone reporting, nothing out
     snapshot   one operator read from a saved browser capture
     via        one operator read through a third-party aggregator
     unconnected  operators whose feed has not been found yet
     down       the outage service itself is unreachable
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(arg('root', path.join(__dirname, '..', '..', '.testsite')));
const PORT = Number(arg('port', 8845));

const NSW_NETWORKS = [
  { name: 'Ausgrid', area: 'Sydney, Central Coast and the Hunter', site: 'https://www.ausgrid.com.au/Outages' },
  { name: 'Endeavour Energy', area: "Sydney's greater west", site: 'https://www.endeavourenergy.com.au/outages' },
  { name: 'Essential Energy', area: 'Regional and rural NSW', site: 'https://www.essentialenergy.com.au/outages' }
];

function rows(now) {
  return [
    { network: 'Ausgrid', id: 'A1', location: 'Newtown', cause: 'Equipment fault', status: 'Crew on site',
      kind: 'unplanned', customers: 412, startIso: new Date(now - 90 * 60000).toISOString(),
      restoreIso: new Date(now + 120 * 60000).toISOString() },
    { network: 'Endeavour Energy', id: 'E1', location: 'Penrith', cause: 'Planned maintenance', status: 'In progress',
      kind: 'planned', customers: 1205, startIso: new Date(now - 30 * 60000).toISOString() },
    { network: 'Essential Energy', id: 'S1', location: 'Dubbo', cause: 'Vegetation', status: 'Crew assigned',
      kind: 'unplanned', customers: 88, startIso: new Date(now - 45 * 60000).toISOString() },
    /* One outage across four towns, which is how the operators publish them
       and the case a town search has to handle. */
    { network: 'Ausgrid', id: 'A3', location: 'Kulnura, Wyong, Wyong Creek, Yarramalong',
      towns: ['Kulnura', 'Wyong', 'Wyong Creek', 'Yarramalong'], cause: 'Storm damage',
      kind: 'unplanned', customers: 286, startIso: new Date(now - 120 * 60000).toISOString() },
    { network: 'Endeavour Energy', id: 'E9', location: 'Greystanes +4 more',
      towns: ['Greystanes'], moreTowns: 4, kind: 'unplanned', customers: 120,
      startIso: new Date(now - 20 * 60000).toISOString() },
    { network: 'Ausgrid', id: 'A2', location: 'Gosford', cause: 'Storm damage', status: 'Assessing',
      kind: 'unplanned', customers: null, start: 'Early this morning' }
  /* Returned in the order the Worker would return them -- biggest first, an
     unreported count last -- because ordering is the Worker's job and the
     page is supposed to render what it is given. */
  ].sort((a, b) => (b.customers === null ? -1 : b.customers) - (a.customers === null ? -1 : a.customers));
}

function statePayload(scenario) {
  const now = Date.now();
  const nets = NSW_NETWORKS.map(n => Object.assign({ ok: true, count: 0, customers: 0 }, n));
  let outages = rows(now);

  if (scenario === 'quiet') { outages = []; }
  if (scenario === 'partial') {
    nets[2].ok = false;
    nets[2].error = 'HTTP 403 — <html>Access denied</html>';
    outages = outages.filter(o => o.network !== 'Essential Energy');
  }
  /* An operator read through a third-party aggregator rather than its own
     site, which the page has to say out loud. */
  /* Figures read from a saved browser capture rather than fetched live. */
  if (scenario === 'snapshot') {
    nets[0].source = 'snapshot';
    nets[0].shape = 'cards';
  }
  /* An operator whose rows were all published by another. */
  if (scenario === 'merged') {
    nets[1].count = 0; nets[1].customers = 0; nets[1].mergedInto = 'Ausgrid';
    outages = outages.filter(o => o.network !== 'Endeavour Energy');
  }
  /* An operator that blocks us but whose totals are known from elsewhere. */
  if (scenario === 'totals') {
    nets[2].ok = false; nets[2].blocked = true; nets[2].count = 0;
    nets[2].reported = { outages: 47, customers: 3067 };
    nets[2].reportedVia = 'Power Outages Australia';
    outages = outages.filter(o => o.network !== 'Essential Energy');
  }
  if (scenario === 'via') {
    nets[2].via = 'Power Outages Australia';
    nets[2].viaUrl = 'https://poweroutagesaustralia.com.au/distributors/essential-energy/';
  }
  if (scenario === 'unconnected') {
    nets[1].ok = false; nets[1].unconfirmed = true; nets[1].error = 'HTTP 404';
    nets[2].ok = false; nets[2].unconfirmed = true; nets[2].error = 'HTTP 404';
    outages = outages.filter(o => o.network === 'Ausgrid');
  }
  if (scenario === 'drift') {
    nets[1].diagnostics = { envelope: 'array', recordsSeen: 12, sampleKeys: ['zzz', 'qqq'],
      note: 'Found 1 table(s) but no column could be matched to a location' };
    outages = outages.filter(o => o.network !== 'Endeavour Energy');
  }
  nets.forEach(n => {
    const mine = outages.filter(o => o.network === n.name);
    n.count = mine.length;
    n.customers = mine.reduce((s, o) => s + (o.customers || 0), 0);
  });
  const unplanned = outages.filter(o => o.kind !== 'planned');
  const planned = outages.filter(o => o.kind === 'planned');
  const sum = (rows) => rows.reduce((s, o) => s + (o.customers || 0), 0);
  return {
    state: 'NSW', name: 'New South Wales',
    ok: nets.some(n => n.ok), complete: nets.every(n => n.ok),
    count: outages.length,
    customers: sum(outages),
    unplannedCount: unplanned.length, unplannedCustomers: sum(unplanned),
    plannedCount: planned.length, plannedCustomers: sum(planned),
    networks: nets, outages, fetchedAt: now, cacheAgeSeconds: 40,
    snapshotAgeSeconds: scenario === 'snapshot' ? 3 * 3600 : undefined
  };
}

const STATES = ['NSW', 'QLD', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const sc = u.searchParams.get('outages') || 'live';
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  /* The capture button's endpoint. `scrape` picks the state it reports:
     off (not configured), ready, cooldown, or fail (GitHub refuses). */
  if (u.pathname === '/api/scrape') {
    const mode = u.searchParams.get('scrape') || 'ready';
    if (mode === 'off') return send(200, { configured: false, cooldownSeconds: 0 });
    if (req.method !== 'POST') {
      return send(200, { configured: true, cooldownSeconds: mode === 'cooldown' ? 420 : 0,
        cooldownTotalSeconds: 600 });
    }
    if (mode === 'fail') return send(502, { ok: false, error: 'GitHub refused the request (HTTP 404).' });
    return send(202, { ok: true, started: true });
  }
  if (u.pathname === '/api/outages') {
    if (sc === 'down') return send(502, 'gateway', 'text/plain');
    const nsw = statePayload(sc);
    const { outages, ...head } = nsw;
    return send(200, {
      states: STATES.map(s => s === 'NSW' ? head
        : { state: s, name: s, ok: s !== 'WA', count: s === 'WA' ? 0 : 2, customers: 10, complete: true, networks: [] }),
      builtAt: Date.now()
    });
  }
  if (u.pathname.startsWith('/api/outages/')) {
    if (sc === 'down') return send(502, 'gateway', 'text/plain');
    const st = u.pathname.split('/')[3].toUpperCase();
    if (st !== 'NSW') return send(200, { state: st, name: st, ok: true, complete: true, count: 0, customers: 0, networks: [], outages: [] });
    return send(200, statePayload(sc));
  }
  /* Everything else the page asks for, answered blandly so one unrelated
     route can't be what makes an outage test fail. */
  if (u.pathname === '/api/news') return send(200, { build: 'test', articles: [], feeds: [], warming: true });
  if (u.pathname.startsWith('/api/incidents')) return send(200, { states: [], builtAt: Date.now() });
  if (u.pathname === '/api/gdelt') return send(200, { articles: [] });

  let p = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!p.startsWith(ROOT)) return send(403, 'no', 'text/plain');
  fs.readFile(p, (err, data) => {
    if (err) return send(404, 'not found', 'text/plain');
    const ext = path.extname(p);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});
server.listen(PORT, () => console.log('mock server on http://localhost:' + PORT + ' serving ' + ROOT));
