/* South Australia, which the dashboard has reported nothing for.

   The cause was not a wrong URL. The CFS incidents page loads its own feeds
   from data.eso.sa.gov.au, and both answer HTTP 200 with a 197-byte
   "SA ESS - File Unavailable" page -- so the state reported ok:true,
   complete:true, count:0, which reads exactly like a quiet day in South
   Australia. The data host is serving a soft-404 to the agency's own site.

   Alert SA's combined CAP feed, found from that page's own Javascript
   bundle, answers properly and carries SES, CFS and MFS together. The
   fixtures below are the real shape of that feed, copied from a live run.

   Two things are being guarded.

   The level. SA puts its own vocabulary in the CAP parameter pairs as
   WarningLevel, and its observed values are "Incident" and "Public
   Notice" -- a routine job and a notice, not declared public warnings.
   Passing those through is the bug that had VicEmergency showing "Tree
   Down" and "Earthquake" as alert levels, and it is the same mistake twice
   if it happens here: a field named like a level whose values are not one.

   The suppression fields. CAP states in its own data that an entry must not
   be displayed -- status Test/Exercise/Draft, msgType Cancel. Alert SA runs
   a UAT host whose 106 entries are fabricated, so test data wearing the
   shape of a real feed is not a hypothetical on this project.

   Run: node test/sa_incidents.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error('not found in worker.js: ' + what);
  return m[0];
};
/* The real parser and the real helpers it leans on, so this cannot pass
   against a copy that has drifted from what the Worker runs. */
const fns = new Function([
  grab(/function stripTags\(/.source ? /function stripTags\([\s\S]*?\n\}/ : null, 'stripTags'),
  grab(/function normaliseWhen\([\s\S]*?\n\}/, 'normaliseWhen'),
  grab(/const SA_PUBLIC_LEVELS = [^\n]*\n/, 'SA_PUBLIC_LEVELS'),
  grab(/function capParameters\([\s\S]*?\n\}/, 'capParameters'),
  grab(/function parseAlertSaCap\([\s\S]*?\n\}\n/, 'parseAlertSaCap')
].join('\n') + '; return { parseAlertSaCap, capParameters };')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

/* Builds an entry in the feed's real shape. */
const entry = (o) => `<entry>
  <id>${o.id || 'urn:x:1'}</id>
  <identifier>${o.id || 'urn:x:1'}</identifier>
  <sender>SES.State.PublicInfo@eso.sa.gov.au</sender>
  <sent>${o.sent || '2026-10-10T14:05:00+10:30'}</sent>
  <status>${o.capStatus === undefined ? 'Actual' : o.capStatus}</status>
  <msgType>${o.msgType === undefined ? 'Alert' : o.msgType}</msgType>
  <scope>Public</scope>
  <info>
    <language>en-AU</language>
    <category>${o.category || 'Fire'}</category>
    <event>${o.event || ''}</event>
    <responseType>Monitor</responseType>
    <urgency>Unknown</urgency>
    <severity>${o.severity || 'Unknown'}</severity>
    <certainty>Unknown</certainty>
    <senderName>${o.senderName || 'South Australian Country Fire Service'}</senderName>
    <headline>${o.headline === undefined ? 'ST AGNES : BURN OFF' : o.headline}</headline>
    <description>${o.description || 'A burn off is in progress.'}</description>
    <web>https://alert.sa.gov.au/</web>
${(o.params || [['WarningLevel', 'Incident'], ['Status', 'Controlled'], ['Location', '228 SMART RD ST AGNES'], ['SubCategory', 'Burn Off']])
  .map(([n, v]) => `    <parameter><valueName>${n}</valueName><value>${v}</value></parameter>`).join('\n')}
    <area>
      <areaDesc>${o.areaDesc === undefined ? '228 SMART RD ST AGNES' : o.areaDesc}</areaDesc>
      ${o.circle === null ? '' : '<circle>' + (o.circle || '-34.831308,138.712425 0') + '</circle>'}
    </area>
  </info>
</entry>`;
const feed = (entries) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Alert SA</title>
<updated>2026-10-10T14:10:00+10:30</updated>
${entries.join('\n')}
</feed>`;

console.log('== the real feed parses ==');
const basic = fns.parseAlertSaCap(feed([entry({})]));
ck('one entry produces one incident', basic.incidents.length === 1, basic);
const i0 = basic.incidents[0] || {};
ck('the headline becomes the title', i0.title === 'ST AGNES : BURN OFF', i0);
ck('the circle becomes a point', i0.lat === -34.831308 && i0.lon === 138.712425, i0);
ck('the point is in South Australia',
  i0.lat < -25 && i0.lat > -39 && i0.lon > 128 && i0.lon < 142, i0);
ck('SubCategory is preferred as the type', i0.type === 'Burn Off', i0);
ck('a timestamp is produced', !!i0.when || !!i0.whenIso || !!i0.time, i0);

console.log('\n== WarningLevel=Incident is NOT an alert level ==');
/* The whole point. Every entry on the live run carried WarningLevel, and
   every value was "Incident". A dashboard that colours by alertLevel would
   paint 16 routine jobs as declared warnings. */
ck('"Incident" does not become an alert level', i0.alertLevel === '', i0);
ck('and is not lost -- it lands in status', /Incident/.test(i0.status || ''), i0);
ck('alongside the operational state', /Controlled/.test(i0.status || ''), i0);

const notice = fns.parseAlertSaCap(feed([entry({
  params: [['WarningLevel', 'Public Notice'], ['Status', 'Going']] })]));
ck('"Public Notice" is not an alert level either',
  notice.incidents[0].alertLevel === '', notice.incidents[0]);

console.log('\n== a real declared level IS passed through ==');
/* When SA does declare one, the dashboard must colour it, which is the
   whole reason the field is read at all. */
[['Advice', 'Advice'], ['Watch and Act', 'Watch and Act'],
 ['Emergency Warning', 'Emergency Warning'], ['All Clear', 'All Clear']].forEach(([given, want]) => {
  const r = fns.parseAlertSaCap(feed([entry({ params: [['WarningLevel', given]] })]));
  ck(given + ' is kept as the alert level', r.incidents[0].alertLevel === want, r.incidents[0]);
});
/* The ampersand form, which three agencies in this project use. */
const amp = fns.parseAlertSaCap(feed([entry({ params: [['WarningLevel', 'Watch & Act']] })]));
ck('"Watch & Act" is accepted too', amp.incidents[0].alertLevel === 'Watch & Act', amp.incidents[0]);
/* An operational state must not slip through as a level however it is spelt. */
['Going', 'Controlled', 'Safe', 'Completed', 'Under Control', 'Tree Down', 'Earthquake'].forEach((v) => {
  const r = fns.parseAlertSaCap(feed([entry({ params: [['WarningLevel', v]] })]));
  ck('"' + v + '" is rejected as a level', r.incidents[0].alertLevel === '', r.incidents[0]);
});

console.log('\n== what CAP says must not be displayed ==');
const test = fns.parseAlertSaCap(feed([entry({ capStatus: 'Test' }), entry({ id: 'b' })]));
ck('a Test entry is dropped', test.incidents.length === 1, test);
const ex = fns.parseAlertSaCap(feed([entry({ capStatus: 'Exercise' })]));
ck('an Exercise entry is dropped', ex.incidents.length === 0, ex);
const cancel = fns.parseAlertSaCap(feed([entry({ msgType: 'Cancel' })]));
ck('a Cancel entry is dropped', cancel.incidents.length === 0, cancel);
const upd = fns.parseAlertSaCap(feed([entry({ msgType: 'Update' })]));
ck('an Update entry is kept', upd.incidents.length === 1, upd);
/* Dropping on a MISSING field would empty the state silently, which is the
   failure mode this whole exercise is about. */
const noStatus = fns.parseAlertSaCap(feed([entry({ capStatus: '' })]));
ck('an entry with no status field is kept, not dropped', noStatus.incidents.length === 1, noStatus);

console.log('\n== the SES entries, which are shaped differently ==');
/* Nine of sixteen on the live run: no headline worth the name, no event,
   the place only in the Location parameter. */
const ses = fns.parseAlertSaCap(feed([entry({
  headline: 'TREE DOWN', event: 'TREE DOWN', areaDesc: 'FLINDERS PARK',
  senderName: 'South Australian State Emergency Service',
  circle: '-34.91313999999994,138.5430540000001 0',
  params: [['WarningLevel', 'Incident'], ['Status', 'Going'],
           ['Location', 'FLINDERS PARK'], ['RespondingUnit', 'Western Adelaide']] })]));
const s0 = ses.incidents[0] || {};
ck('an SES entry is kept', ses.incidents.length === 1, ses);
ck('and placed', s0.lat < -34.9 && s0.lon > 138.5, s0);
ck('its type falls back to the event', s0.type === 'TREE DOWN', s0);
ck('and it carries no alert level', s0.alertLevel === '', s0);

/* An entry with no headline at all must still produce a usable label rather
   than being dropped -- the place and the event are enough. */
const noHead = fns.parseAlertSaCap(feed([entry({
  headline: '', event: 'Structure Fire', areaDesc: '',
  params: [['Location', 'MOUNT GAMBIER'], ['WarningLevel', 'Incident']] })]));
ck('an entry with no headline is still labelled',
  (noHead.incidents[0] || {}).title === 'Structure Fire - MOUNT GAMBIER', noHead.incidents[0]);

console.log('\n== an entry that cannot be placed is still reported ==');
/* It will not appear on the map, but dropping it would understate the
   count, and the count is what tells a duty officer whether to look. */
const noGeo = fns.parseAlertSaCap(feed([entry({ circle: null })]));
ck('kept without coordinates', noGeo.incidents.length === 1, noGeo);
ck('and has no invented coordinates',
  noGeo.incidents[0].lat === undefined && noGeo.incidents[0].lon === undefined, noGeo.incidents[0]);

console.log('\n== an empty result says why ==');
const empty = fns.parseAlertSaCap(feed([]));
ck('no entries is reported as a diagnostic, not silence',
  !!empty.diagnostics && empty.diagnostics.itemsSeen === 0, empty);
const allTest = fns.parseAlertSaCap(feed([entry({ capStatus: 'Test' }), entry({ capStatus: 'Test' })]));
ck('a feed of nothing but test entries says so',
  allTest.incidents.length === 0 && allTest.diagnostics.suppressed === 2, allTest);
ck('and still reports how many it saw', allTest.diagnostics.itemsSeen === 2, allTest);
/* The soft-404 that caused all this: an HTML error page must parse to
   nothing and say so, never to a phantom incident. */
const soft = fns.parseAlertSaCap('<html><head><title>SA ESS - File Unavailable</title></head><body>File Unavailable</body></html>');
ck('the SA soft-404 page yields no incidents', soft.incidents.length === 0, soft);
ck('and is reported as seeing nothing', !!soft.diagnostics, soft);

console.log('\n== the CAP parameter reader, which other states will need ==');
const pm = fns.capParameters('<parameter><valueName>WarningLevel</valueName><value>Advice</value></parameter>'
  + '<parameter><valueName>Status</valueName><value>Going</value></parameter>'
  + '<parameter><valueName>Empty</valueName><value></value></parameter>');
ck('reads every pair', pm.WarningLevel === 'Advice' && pm.Status === 'Going', pm);
ck('an empty value is an empty string, not missing', pm.Empty === '', pm);
ck('namespaced tags work too',
  fns.capParameters('<cap:parameter><cap:valueName>WarningLevel</cap:valueName><cap:value>Advice</cap:value></cap:parameter>')
    .WarningLevel === 'Advice');

console.log('\n== the config points at the feed that answers ==');
ck('Alert SA is the first SA source',
  /sa: \{[\s\S]{0,400}?combined-feed\.alert\.sa\.gov\.au\/majorIncidentsCAP\.xml/.test(src));
ck('and is parsed by parseAlertSaCap',
  /majorIncidentsCAP\.xml', format: 'text', parse: parseAlertSaCap/.test(src));
/* The UAT host returns 106 fabricated entries and presents as a richer
   feed. It must never be configured. */
ck('the UAT host is not configured anywhere',
  !/uat\.combined-feed/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
