/* The discovery probe's own logic, against fixtures.

   This project has a specific recurring failure: a diagnostic that runs
   clean and does not answer the question it was written for. /api/news was
   never read by the feed check; the state payloads carried no build stamp;
   the outage diagnostic read b.sources when the field is b.networks. Each
   cost a run and a wrong conclusion.

   discover-feeds.mjs is only useful if three things hold, and none of them
   can be checked by running it -- a clean run against a page that has moved
   on produces a short list and no error:

     1. It finds the feed URLs in a page, including the ones that exist only
        inside a Javascript bundle. A single-page app has no feed address in
        its markup at all, and both pages in question are single-page apps.
     2. It calls a soft-404 a failure. The SA host answers HTTP 200 with 197
        bytes of "File Unavailable", and treating that as data is the
        original bug this probe exists to stop repeating.
     3. Its two verdicts are drawn from content: a feed is reported as
        carrying an alert LEVEL only when the values are the published
        levels, and as carrying OUTAGE data only when the fields are outage
        fields. A feed of Going/Contained must not read as a warning feed.

   Run: node test/discover_feeds.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../scripts/discover-feeds.mjs', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error('not found in discover-feeds.mjs: ' + what);
  return m[0];
};
/* The real functions, lifted out of the script so the test cannot drift from
   what the probe runs. */
const fns = new Function([
  grab(/const CHALLENGE_RE = [^\n]*\n/, 'CHALLENGE_RE'),
  grab(/const DATA_RE = [^\n]*\n/, 'DATA_RE'),
  grab(/const SERVICE_RE = [^\n]*\n/, 'SERVICE_RE'),
  grab(/const LEVEL_NAME_RE = [^\n]*\n/, 'LEVEL_NAME_RE'),
  grab(/const LEVEL_VAL_RE = [^\n]*\n/, 'LEVEL_VAL_RE'),
  grab(/const OUTAGE_NAME_RE = [^\n]*\n/, 'OUTAGE_NAME_RE'),
  grab(/const OUTAGE_VAL_RE = [^\n]*\n/, 'OUTAGE_VAL_RE'),
  grab(/function softFail\(r\) \{[\s\S]*?\n\}/, 'softFail'),
  grab(/function extractUrls\(text, baseUrl\) \{[\s\S]*?\n\}/, 'extractUrls'),
  grab(/function extractScripts\(text, baseUrl\) \{[\s\S]*?\n\}/, 'extractScripts'),
  grab(/function walk\(node, depth, names, vals\) \{[\s\S]*?\n\}/, 'walk'),
  grab(/function describe\(r\) \{[\s\S]*?\n\}/, 'describe')
].join('\n') + '; return { softFail, extractUrls, extractScripts, describe };')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const body = (text, over) => ({ status: 200, type: 'application/json', bytes: text.length, text, title: '', ...over });

console.log('== finding feed addresses in a page ==');
const html = `<!doctype html><html><head>
  <script src="/static/app.4f2c.js"></script>
  <script src="https://cdn.example.com/other.js"></script>
  </head><body>
  <a href="/warnings-restrictions/warnings/">Warnings</a>
  <img src="/img/logo.png">
  <div data-feed="/data/incidents.json"></div>
  <script>var map={layers:"https:\\/\\/services.arcgis.com\\/abc\\/arcgis\\/rest\\/services\\/Outages\\/FeatureServer\\/0\\/query?f=json"}</script>
</body></html>`;
const urls = fns.extractUrls(html, 'https://www.cfs.sa.gov.au/warnings-restrictions/warnings/incidents-warnings/');
ck('finds a relative data path', urls.some((u) => u === 'https://www.cfs.sa.gov.au/data/incidents.json'), urls);
ck('finds an arcgis service and unescapes the slashes',
  urls.some((u) => u.includes('arcgis/rest/services/Outages/FeatureServer/0/query')), urls);
ck('ignores images and stylesheets', !urls.some((u) => /\.png|\.css/.test(u)), urls);
/* A .js file is a bundle to scan, not a candidate to fetch as data -- a
   megabyte of Javascript parsed as a feed is noise in the report. */
ck('does not offer a script bundle as a data candidate',
  !urls.some((u) => /\.js(\?|$)/.test(u)), urls);
ck('every result is absolute', urls.every((u) => /^https:\/\//.test(u)), urls);

console.log('\n== the bundles, which is where a single-page app keeps its endpoints ==');
const scripts = fns.extractScripts(html, 'https://alert.sa.gov.au/');
ck('finds the same-origin bundle', scripts.includes('https://alert.sa.gov.au/static/app.4f2c.js'), scripts);
/* A third-party CDN bundle is someone else's code and fetching it finds
   their endpoints, not the agency's. */
ck('leaves third-party bundles alone', !scripts.some((s) => /cdn\.example\.com/.test(s)), scripts);

console.log('\n== the soft-404, which is the bug this probe exists for ==');
/* Verbatim shape of what data.eso.sa.gov.au returns today: HTTP 200, 197
   bytes, and the admission in the title. */
const sa = body('<html><head><title>SA ESS - File Unavailable</title></head><body>File Unavailable</body></html>',
  { type: 'text/html' });
ck('"File Unavailable" at HTTP 200 is a failure', /soft-404/.test(fns.softFail(sa) || ''), fns.softFail(sa));
const d_sa = fns.describe(sa);
ck('and describe() reports it rather than a shape', /soft-404/.test(d_sa.verdict || ''), d_sa);
ck('a soft-404 claims no alert level', !d_sa.carriesAlertLevel, d_sa);
ck('a soft-404 claims no outage data', !d_sa.carriesOutageData, d_sa);
ck('a short HTML body where data was asked for is a failure',
  /soft-404/.test(fns.softFail(body('<html><body>nope</body></html>', { type: 'text/html' })) || ''));
ck('a bot challenge is reported, not worked around',
  /challenge/.test(fns.softFail(body('<html>Just a moment...</html>', { type: 'text/html' })) || ''));
/* A real feed must not be mistaken for a soft-404 just for being small. */
ck('a small but real JSON feed is not called a soft-404',
  fns.softFail(body('{"features":[]}')) === null);

console.log('\n== the level verdict comes from the values ==');
const warn = body(JSON.stringify({ features: [
  { properties: { title: 'Fire near Clare', warningLevel: 'Watch and Act' } },
  { properties: { title: 'Fire near Burra', warningLevel: 'Advice' } }
] }));
const d_warn = fns.describe(warn);
ck('a published-level feed carries a level', d_warn.carriesAlertLevel, d_warn);
ck('and its items are counted', d_warn.items === 2, d_warn);
ck('and it is not reported as outage data', !d_warn.carriesOutageData, d_warn);

/* The VIC case: a field called "level" whose values are event types, and the
   QLD/WA case: a dispatch status. Neither is a public instruction, and
   reporting either as a warning feed is how VIC came to show "Tree Down" as
   an alert level on the dashboard. */
const oper = body(JSON.stringify({ features: [
  { properties: { name: 'Grass fire', status: 'Going', level: 'Tree Down' } },
  { properties: { name: 'Alarm', status: 'Contained', level: 'Earthquake' } }
] }));
const d_oper = fns.describe(oper);
ck('an incident feed does NOT read as carrying a level', !d_oper.carriesAlertLevel, d_oper);
ck('though its level-ish field names are still reported for inspection',
  (d_oper.levelFields || []).length > 0, d_oper);

console.log('\n== the outage verdict comes from the fields ==');
const out = body(JSON.stringify({ features: [
  { properties: { suburb: 'Mount Barker', customersAffected: 412, restorationTime: '2026-10-10T09:00:00Z', cause: 'Equipment fault' } }
] }));
const d_out = fns.describe(out);
ck('customersAffected and restorationTime read as outage data', d_out.carriesOutageData, d_out);
ck('and the outage fields are named', (d_out.outageFields || []).some((f) => /customer/i.test(f)), d_out);
ck('an outage feed with no levels claims none', !d_out.carriesAlertLevel, d_out);
/* The one feed worth the most: warnings and outages together, which is what
   a whole-of-state emergency page would publish. */
const both = body(JSON.stringify({ features: [
  { properties: { event: 'Bushfire', warningLevel: 'Emergency Warning' } },
  { properties: { event: 'Power Outage', customersAffected: 88 } }
] }));
const d_both = fns.describe(both);
ck('a combined feed is reported as carrying both',
  d_both.carriesAlertLevel && d_both.carriesOutageData, d_both);

console.log('\n== XML, which several agencies publish instead ==');
const xml = body('<?xml version="1.0"?><rss><channel>'
  + '<item><title>Fire near Clare</title><category>Watch and Act</category></item>'
  + '<item><title>Power outage Mount Barker</title><description>412 customers affected</description></item>'
  + '</channel></rss>', { type: 'text/xml' });
const d_xml = fns.describe(xml);
ck('xml is recognised', d_xml.shape === 'xml', d_xml);
ck('and its items counted', d_xml.items === 2, d_xml);
ck('a level in xml is found', d_xml.carriesAlertLevel, d_xml);
ck('an outage in xml is found', d_xml.carriesOutageData, d_xml);

console.log('\n== nothing is claimed about an empty or broken response ==');
const empty = fns.describe(body('{"features":[]}'));
ck('an empty feed is 0 items, not absent', empty.items === 0, empty);
ck('an empty feed claims no level', !empty.carriesAlertLevel, empty);
const bad = fns.describe(body('{not json'));
ck('unparseable json is said to be unparseable', /unparseable/.test(bad.shape || ''), bad);
ck('and claims nothing', !bad.carriesAlertLevel && !bad.carriesOutageData, bad);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
