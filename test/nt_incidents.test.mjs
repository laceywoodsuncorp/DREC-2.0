/* The NT's bushfire alerts, read from SecureNT's published table rather than
   the incident map's internal JSON.

   The page could not be inspected from the build environment, so these cover
   what the reader must survive: headings it doesn't expect, a different
   column order, the alerts page with nothing on it, and the case where the
   table turns out to be drawn by JavaScript.

   Run: node test/nt_incidents.test.mjs */

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
globalThis.fetch = async (url) => {
  const keys = Object.keys(upstream).filter((k) => k !== 'http').sort((a, b) => b.length - a.length);
  for (const k of keys) if (String(url).includes(k)) return upstream[k]();
  if (upstream.http) return upstream.http();
  return new Response('not stubbed', { status: 404 });
};

const worker = (await import('../src/worker.js')).default;
const env = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
const call = (p) => worker.fetch(new Request('https://example.test' + p), env, { waitUntil: () => {} });

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};
const page = (inner) => () => new Response('<html><body>' + inner + '</body></html>',
  { status: 200, headers: { 'Content-Type': 'text/html' } });
const reset = () => { store.clear(); upstream = {}; };

console.log('\n== the bushfire alerts table is read ==');
{
  reset();
  upstream['securent.nt.gov.au/respond/bushfire-alerts'] = page(
    '<table class="nav"><tr><td>skip me</td></tr></table>' +
    '<table><thead>' +
    '<tr><th>Location</th><th>Message</th><th>Alert level</th><th>Last updated</th></tr>' +
    '</thead><tbody>' +
    '<tr><td>Batchelor</td><td>Fire burning near Rum Jungle Road</td>' +
    '<td>Watch and Act</td><td>2026-09-17T03:20:00Z</td></tr>' +
    '<tr><td>Howard Springs</td><td>Hazard reduction burn</td>' +
    '<td>Planned Burn Advice</td><td>2026-09-17T01:00:00Z</td></tr>' +
    '</tbody></table>');

  const b = await (await call('/api/incidents/nt')).json();
  check('NT reports', b.ok === true && b.count === 2, [b.ok, b.count, b.error]);
  check('and names SecureNT as the source', /securent/.test(b.sourceUrl || ''), b.sourceUrl);
  check('the agency is credited', /SecureNT|Bushfires NT/.test(b.agency || ''), b.agency);

  const one = b.incidents.find(i => i.title === 'Batchelor');
  check('location becomes the title', !!one, b.incidents.map(i => i.title));
  check('alert level becomes the status', one && one.status === 'Watch and Act', one);
  check('the message carries the detail', one && /Rum Jungle/.test(one.type), one);
  check('the timestamp is parsed for local rendering', one && !!one.whenIso, one);
  check('a planned burn is not lost', b.incidents.some(i => /Planned Burn/.test(i.status)),
    b.incidents.map(i => i.status));
}

console.log('\n== headings it has not seen before ==');
{
  reset();
  // different wording, different order, no <thead>, <td> headings
  upstream['securent.nt.gov.au/respond/bushfire-alerts'] = page(
    '<table>' +
    '<tr><td>Alert Level</td><td>Issued</td><td>Incident Type</td><td>Area</td></tr>' +
    '<tr><td>Emergency Warning</td><td>2026-09-17T05:00:00Z</td><td>Bushfire</td><td>Adelaide River</td></tr>' +
    '</table>');
  const b = await (await call('/api/incidents/nt')).json();
  check('column order does not matter', b.count === 1, b.count);
  const i = b.incidents[0];
  check('"Area" is the location', i.title === 'Adelaide River', i);
  check('"Incident Type" is a type, not an incident name', i.type === 'Bushfire', i);
  check('"Alert Level" is still the status', i.status === 'Emergency Warning', i);
  check('"Issued" is still the time', !!i.whenIso, i);
}

console.log('\n== no current alerts is good news, not a broken feed ==');
{
  reset();
  upstream['securent.nt.gov.au/respond/bushfire-alerts'] = page(
    '<table><tr><th>Location</th><th>Message</th><th>Alert level</th></tr></table>');
  const b = await (await call('/api/incidents/nt')).json();
  check('reported as working', b.ok === true, b);
  check('with nothing listed', b.count === 0, b.count);
  check('and no schema warning attached', !b.diagnostics, b.diagnostics);
}

console.log('\n== a JavaScript-rendered page falls through to the incident map ==');
{
  reset();
  upstream['securent.nt.gov.au'] = page('<div id="root"></div>');   // both SecureNT pages
  upstream['pfes.nt.gov.au'] = () => new Response(JSON.stringify([
    { location: 'Katherine', status: 'Going', type: 'Bushfire', updated: '2026-09-17T06:00:00Z' }
  ]), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const b = await (await call('/api/incidents/nt')).json();
  check('the fallback answers', b.ok === true && b.count === 1, [b.ok, b.count]);
  check('from the incident map', /pfes/.test(b.sourceUrl || ''), b.sourceUrl);
  check('and the SecureNT attempts are recorded',
    (b.attempts || []).length === 2, b.attempts);
  check('saying it was a page with no table, not a dead link',
    (b.attempts || []).every(a => /no recognisable/i.test(a.error)), b.attempts);
}

console.log('\n== everything down is reported as down ==');
{
  reset();
  upstream.http = () => new Response('nope', { status: 503 });
  const r = await call('/api/incidents/nt');
  const b = await r.json();
  check('the state is not ok', b.ok === false, b.ok);
  check('every source tried is listed', (b.attempts || []).length === 3, b.attempts);
  check('with the status each returned', /503/.test(b.error), b.error);
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
