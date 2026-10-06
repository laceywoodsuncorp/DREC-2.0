/* The routes left for South Australian and Northern Territory outages.

   Both report nothing on the live dashboard, for different reasons, and
   neither reason is a bug in this code:

     SA   SA Power Networks runs its outage report as a separate application
          and answers automated requests with an Imperva Incapsula challenge.
     NT   Power and Water answers 403 "Just a moment..." on every path tried,
          including sitemap.xml.

   Those challenges are the operators' decision and are not touched here.
   What is being looked for is a route they have published, which is exactly
   how Queensland was recovered -- Energex and Ergon both challenge their own
   sites and both publish current outage areas as open ArcGIS services.

   For the NT that search is finished and the answer is no: no ArcGIS layer
   (the two candidates turned out to be in a United States projection), no
   dataset on data.nt.gov.au or data.gov.au, and Jacana Energy's own sitemap
   contains no outage page at all. See data/nt-power-probe.json.

   So this checks the two things still outstanding:

     1. the third-party aggregator already configured for SA -- does it carry
        Power and Water too, and is the SA page still readable? The SA source
        list includes it, yet SA returns zero rows while claiming to be
        complete, so something there has changed.
     2. South Australia's own open data portal, which was never asked.

   An aggregator is a second-hand account and anything found here must stay
   labelled with whose figures it is, which the Worker's `via` field already
   does.

   Run: node scripts/probe-sa-nt-outages.mjs   (writes data/sa-nt-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || '*/*' } });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', bytes: text.length, text,
      challenged: /_Incapsula_Resource|Just a moment|cf-browser-verification|Attention Required|Request unsuccessful/i.test(text),
      title: (/<title[^>]*>([^<]{0,140})</i.exec(text) || [])[1] || '' };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

/* Counts what a table-shaped page actually offers, so "reachable" is not
   mistaken for "useful". A 200 with no rows is the state SA is in. */
function tableShape(html) {
  const rows = (html.match(/<tr[\s>]/gi) || []).length;
  const cells = (html.match(/<t[dh][\s>]/gi) || []).length;
  const suburbish = (html.match(/\b(suburb|locality|town|area|affected)\b/gi) || []).length;
  const numbers = (html.match(/\b\d{1,6}\s*(customers|properties)\b/gi) || []).slice(0, 5);
  return { rows, cells, suburbish, customerPhrases: numbers };
}

const out = { at: new Date().toISOString(), aggregator: [], saOpenData: [], saApp: [], ntExtra: [] };

/* ---- 1. the aggregator, for both operators ---------------------------- */
const AGG = [
  'https://poweroutagesaustralia.com.au/distributors/sa-power-networks/',
  'https://poweroutagesaustralia.com.au/distributors/power-and-water-corporation/',
  'https://poweroutagesaustralia.com.au/distributors/power-and-water/',
  'https://poweroutagesaustralia.com.au/distributors/',
  'https://poweroutagesaustralia.com.au/'
];
for (const url of AGG) {
  const r = await get(url);
  const shape = r.text ? tableShape(r.text) : null;
  /* The index pages are worth reading for the distributor slugs they link,
     rather than guessing at the Power and Water one as above. */
  const links = r.text ? [...new Set((r.text.match(/href="([^"]*distributors\/[^"]*)"/g) || [])
    .map((s) => s.slice(6, -1)))].slice(0, 30) : [];
  out.aggregator.push({ url, status: r.status, error: r.error, challenged: r.challenged,
    title: r.title, bytes: r.bytes, shape, distributorLinks: links });
  console.log('AGG   ' + url);
  console.log('        ' + (r.error ? 'ERROR ' + r.error : 'HTTP ' + r.status
    + (r.challenged ? ' [CHALLENGE]' : '')
    + (shape ? '  rows=' + shape.rows + ' cells=' + shape.cells
      + ' placeWords=' + shape.suburbish : '')));
  if (shape && shape.customerPhrases.length) console.log('        says: ' + shape.customerPhrases.join(' | '));
  if (links.length) console.log('        distributors linked: ' + links.join(' '));
}

/* ---- 2. South Australia's own open data portal ------------------------ */
for (const q of ['outage', 'electricity outage', 'sa power networks', 'power']) {
  const url = 'https://data.sa.gov.au/api/3/action/package_search?rows=12&q=' + encodeURIComponent(q);
  const r = await get(url, 'application/json');
  let res = {};
  try { res = (JSON.parse(r.text || '{}').result) || {}; } catch (e) { /* not json */ }
  out.saOpenData.push({ query: q, status: r.status, error: r.error, total: res.count,
    hits: (res.results || []).map((d) => ({ title: d.title,
      org: d.organization && d.organization.title,
      formats: [...new Set((d.resources || []).map((x) => x.format))] })) });
  console.log('SA-OD ' + q + ' -> ' + (res.count !== undefined ? res.count + ' datasets' : (r.error || r.status)));
  (res.results || []).slice(0, 6).forEach((d) => console.log('        ' + d.title
    + '  [' + ((d.organization && d.organization.title) || '?') + ']'));
}

/* ---- 3. SA Power Networks' own app, recorded only --------------------- */
const SA_APP = [
  'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageList',
  'https://outage.apps.sapowernetworks.com.au/OutageReport/api/outages',
  'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageMap',
  'https://www.sapowernetworks.com.au/outages/'
];
for (const url of SA_APP) {
  const r = await get(url);
  out.saApp.push({ url, status: r.status, error: r.error, challenged: r.challenged,
    title: r.title, bytes: r.bytes, shape: r.text ? tableShape(r.text) : null });
  console.log('SAPN  ' + url + ' -> ' + (r.error || r.status)
    + (r.challenged ? '  [CHALLENGE]' : '') + (r.title ? '  "' + r.title.slice(0, 50) + '"' : ''));
}

/* ---- 4. two NT routes not yet asked ---------------------------------- */
/* The Territory's own spatial catalogue, and the national electricity
   market operator, which publishes network data but may not publish
   distribution outages. Asked for completeness so the NT answer is "every
   published route was checked", not "the obvious ones were". */
const NT_EXTRA = [
  'https://data.nt.gov.au/api/3/action/package_search?rows=10&q=power',
  'https://services.arcgis.com/8CCJjYNbIQ2HLRQj/arcgis/rest/services?f=json',
  'https://www.powerwater.com.au/robots.txt',
  'https://securent.nt.gov.au/alerts-warnings/power'
];
for (const url of NT_EXTRA) {
  const r = await get(url, 'application/json');
  out.ntExtra.push({ url, status: r.status, error: r.error, challenged: r.challenged,
    bytes: r.bytes, head: (r.text || '').slice(0, 200) });
  console.log('NT    ' + url + ' -> ' + (r.error || r.status) + (r.challenged ? '  [CHALLENGE]' : ''));
}

mkdirSync('data', { recursive: true });
writeFileSync('data/sa-nt-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/sa-nt-probe.json');
