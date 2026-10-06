/* What does the live Worker actually return, per state, for incidents and
   outages?

   Written because two questions kept being answered by reading the source
   instead of the service: "do the other states carry alert levels like NSW
   does" and "are we getting anything for the NT". The code can only say what
   it would do with a well-formed response. This says what the agencies are
   actually sending today.

   Run from somewhere that can reach the Worker -- the sandbox cannot, a
   GitHub runner can:
     node scripts/diagnose-states.mjs
     node scripts/diagnose-states.mjs --json > out.json
*/
const BASE = process.env.BASE
  || 'https://drec-oncall-updates-site.lacey-wood.workers.dev';
const STATES = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'nt', 'act'];
const asJson = process.argv.includes('--json');

const get = async (path) => {
  try {
    const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, parseError: text.slice(0, 200) }; }
  } catch (e) { return { error: e.message }; }
};

const uniq = (a) => [...new Set(a.filter((x) => x !== '' && x != null))];

const report = { base: BASE, at: new Date().toISOString(), incidents: {}, outages: {} };

for (const s of STATES) {
  const r = await get('/api/incidents/' + s);
  const b = r.body || {};
  const inc = b.incidents || [];
  /* The distinction that matters here. alertLevel is what the agency is
     telling the public to do; status is how the incident is behaving. A
     state that fills only status has no alert level to colour by, however
     many incidents it reports. */
  const withAlert = inc.filter((i) => String(i.alertLevel || '').trim() !== '');
  report.incidents[s] = {
    httpStatus: r.status, ok: b.ok, error: b.error || r.error,
    count: inc.length,
    withAlertLevel: withAlert.length,
    alertLevels: uniq(inc.map((i) => String(i.alertLevel || '').trim())).slice(0, 12),
    statuses: uniq(inc.map((i) => String(i.status || '').trim())).slice(0, 12),
    types: uniq(inc.map((i) => String(i.type || '').trim())).slice(0, 8),
    partial: b.partial,
    source: b.source || b.via,
    attempts: (b.attempts || []).map((a) => ({ url: a.url, error: a.error }))
  };
}

for (const s of STATES) {
  const r = await get('/api/outages/' + s);
  const b = r.body || {};
  const out = b.outages || [];
  report.outages[s] = {
    httpStatus: r.status, ok: b.ok, error: b.error || r.error,
    count: b.count, customers: b.customers, complete: b.complete,
    rows: out.length,
    networks: uniq(out.map((o) => o.network)),
    withTowns: out.filter((o) => (o.towns || []).length).length,
    reported: b.reported,
    sources: (b.sources || []).map((x) => ({
      network: x.network, ok: x.ok, count: x.count, error: x.error,
      blocked: x.blocked, via: x.via, url: x.url
    }))
  };
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
console.log('INCIDENTS -- alert level is the thing NSW has and the question is who else does');
console.log(pad('state', 7) + pad('count', 7) + pad('w/alert', 9) + 'alert levels seen');
console.log('-'.repeat(78));
for (const s of STATES) {
  const d = report.incidents[s];
  console.log(pad(s, 7) + pad(d.count, 7) + pad(d.withAlertLevel, 9)
    + (d.alertLevels.length ? d.alertLevels.join(' | ') : '(none)'));
  if (d.error) console.log('       error: ' + d.error);
  if (!d.alertLevels.length && d.statuses.length) {
    console.log('       status only: ' + d.statuses.join(' | '));
  }
}

console.log('\nOUTAGES');
console.log(pad('state', 7) + pad('rows', 7) + pad('cust', 9) + 'networks');
console.log('-'.repeat(78));
for (const s of STATES) {
  const d = report.outages[s];
  console.log(pad(s, 7) + pad(d.rows, 7) + pad(d.customers, 9)
    + (d.networks.length ? d.networks.join(', ') : '(none)'));
  (d.sources || []).filter((x) => !x.ok).forEach((x) => {
    console.log('       FAIL ' + pad(x.network, 30)
      + (x.blocked ? 'blocked: ' : '') + String(x.error || '').slice(0, 90));
  });
}
