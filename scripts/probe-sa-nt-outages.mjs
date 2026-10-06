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

/* ---- 5. where the aggregator's numbers actually live ------------------ */
/* Both aggregator pages answer 200 and contain no table at all -- the SA one
   is 744 KB with rows=0, cells=0. So the rows are rendered client-side, which
   is exactly why SA's configured aggregator source parses to zero outages
   without erroring, and why SA then claims a complete report of nothing.
   parseOutageTable cannot read a table that is not in the HTML.
   
   The page must still carry its data somewhere. This looks for it in the
   usual three places -- an embedded JSON blob, a declared API path, and a
   Next.js/Nuxt style hydration payload -- and then fetches whatever it finds.
   Nothing here defeats a protection; these pages are not challenged. */
out.embedded = [];
const PAGES = [
  ['sa', 'https://poweroutagesaustralia.com.au/distributors/sa-power-networks/'],
  ['nt', 'https://poweroutagesaustralia.com.au/distributors/power-and-water/']
];
for (const [state, url] of PAGES) {
  const r = await get(url);
  if (r.error || !r.text) { out.embedded.push({ state, url, error: r.error }); continue; }
  const html = r.text;

  /* Hydration payloads, which is how a modern site ships server-rendered
     data to the browser. */
  const hydration = [];
  [/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/i,
   /window\.__NUXT__\s*=\s*([\s\S]{0,400000}?);?\s*<\/script>/i,
   /window\.__INITIAL_STATE__\s*=\s*([\s\S]{0,400000}?);?\s*<\/script>/i]
    .forEach((re) => { const m = re.exec(html); if (m) hydration.push(m[1].slice(0, 300)); });

  /* Any absolute or root-relative path that looks like data rather than an
     asset. Deduplicated and filtered, because a page this size names a lot
     of CSS. */
  const paths = [...new Set((html.match(/["'`](\/(?:api|wp-json|data|feed)\/[^"'`\s]{2,120})["'`]/g) || [])
    .map((x) => x.slice(1, -1)))].slice(0, 25);
  const absolute = [...new Set((html.match(/https?:\/\/[^"'`\s]*\/(?:api|wp-json)\/[^"'`\s]{2,120}/g) || []))].slice(0, 15);

  /* A big inline array of objects is the other common shape. Only the keys
     are kept -- the question is whether outage rows are in here, not what
     today's rows say. */
  const arrays = [];
  const re = /\[\s*\{[\s\S]{200,}?\}\s*\]/g;
  let m, guard = 0;
  while ((m = re.exec(html)) !== null && guard++ < 6) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object') {
        arrays.push({ length: arr.length, keys: Object.keys(arr[0]).slice(0, 20) });
      }
    } catch (e) { /* not valid JSON on its own, skip */ }
  }

  out.embedded.push({ state, url, bytes: html.length, hydration, paths, absolute, inlineArrays: arrays });
  console.log('\nEMBED ' + state.toUpperCase() + '  ' + url + '  (' + html.length + ' bytes)');
  console.log('        hydration payloads: ' + hydration.length);
  console.log('        data-ish paths: ' + (paths.join(' ') || '(none)'));
  console.log('        absolute api urls: ' + (absolute.join(' ') || '(none)'));
  arrays.forEach((a) => console.log('        inline array of ' + a.length + ': ' + a.keys.join(', ')));

  /* Fetch what was found, so this ends with an answer rather than a lead. */
  const tryUrls = [...absolute, ...paths.map((p) => 'https://poweroutagesaustralia.com.au' + p)].slice(0, 10);
  for (const u of tryUrls) {
    const rr = await get(u, 'application/json');
    let note = rr.error ? 'ERROR ' + rr.error : 'HTTP ' + rr.status + ' ' + (rr.type || '').split(';')[0]
      + ' ' + rr.bytes + 'b';
    if (rr.text && /^[\[{]/.test(rr.text.trim())) {
      try {
        const j = JSON.parse(rr.text);
        const arr = Array.isArray(j) ? j : (j.data || j.outages || j.items || null);
        if (Array.isArray(arr)) note += '  -> array(' + arr.length + ')'
          + (arr.length && typeof arr[0] === 'object' ? ' keys: ' + Object.keys(arr[0]).slice(0, 14).join(',') : '');
      } catch (e) { /* not json after all */ }
    }
    out.embedded[out.embedded.length - 1].fetched = out.embedded[out.embedded.length - 1].fetched || [];
    out.embedded[out.embedded.length - 1].fetched.push({ url: u, note });
    console.log('        ' + u.slice(0, 92) + ' -> ' + note);
  }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/sa-nt-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/sa-nt-probe.json');
