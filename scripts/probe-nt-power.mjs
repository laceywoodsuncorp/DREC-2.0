/* Can the Northern Territory's electricity outages be read at all?

   Power and Water Corporation serves a bot challenge to automated requests
   for its outage page, so the dashboard currently shows nothing for the NT.
   That challenge is theirs to set and is not touched here -- this looks for
   a published route instead, which is exactly how Queensland was recovered:
   Energex and Ergon both challenge their own sites, but both publish current
   outage areas as open ArcGIS feature services, and the dashboard reads
   those.

   So this asks four catalogues whether the NT does the same:
     1. ArcGIS Online, by keyword -- the Energex/Ergon route
     2. data.nt.gov.au (CKAN), the Territory's own open data portal
     3. any ArcGIS server Power and Water runs directly
     4. conventional API paths on their own hosts, recorded as reachable,
        challenged or absent -- never worked around

   Nothing here submits a form, solves a challenge or authenticates. It reads
   public catalogues and records what they say.

   Run: node scripts/probe-nt-power.mjs            (writes data/nt-power-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const TIMEOUT = 20000;

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: opts.accept || '*/*' }
    });
    const text = await res.text();
    return {
      status: res.status,
      type: res.headers.get('content-type') || '',
      bytes: text.length,
      text,
      /* Recorded, not defeated. A challenge means the operator has decided
         against automated access; the useful output is knowing that is the
         answer rather than a bug. */
      challenged: /_Incapsula_Resource|cf-browser-verification|Just a moment|challenge-platform|Attention Required/i.test(text),
      title: (/<title[^>]*>([^<]{0,160})</i.exec(text) || [])[1] || ''
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

const json = async (url) => {
  const r = await get(url, { accept: 'application/json' });
  if (r.error || r.status !== 200) return r;
  try { return Object.assign(r, { json: JSON.parse(r.text) }); }
  catch (e) { return Object.assign(r, { jsonError: e.message }); }
};

const out = { at: new Date().toISOString(), arcgisOnline: [], ckan: [], arcgisServers: [], paths: [] };

/* ---- 1. ArcGIS Online, the route that worked for Queensland ---------- */
const AGOL_QUERIES = [
  '"power and water" outage', 'powerwater outage', 'Northern Territory power outage',
  'NT electricity outage', 'Power and Water Corporation', 'Jacana outage',
  'Darwin power outage', 'unplanned outage Northern Territory'
];
for (const q of AGOL_QUERIES) {
  const url = 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&q='
    + encodeURIComponent(q + ' (type:"Feature Service" OR type:"Map Service")');
  const r = await json(url);
  const results = (r.json && r.json.results) || [];
  out.arcgisOnline.push({
    query: q, status: r.status, error: r.error || r.jsonError,
    total: r.json && r.json.total,
    hits: results.map((x) => ({
      title: x.title, owner: x.owner, type: x.type, url: x.url,
      access: x.access, modified: x.modified ? new Date(x.modified).toISOString().slice(0, 10) : null
    }))
  });
  console.log('AGOL  ' + (r.json ? (r.json.total + ' total') : (r.error || r.status))
    + '   ' + q);
  results.forEach((x) => console.log('        ' + x.title + '  [' + x.owner + ']  ' + (x.url || '')));
}

/* ---- 2. The Territory's own open data portal -------------------------- */
const CKAN_HOSTS = ['https://data.nt.gov.au', 'https://open.nt.gov.au'];
for (const host of CKAN_HOSTS) {
  for (const q of ['outage', 'electricity', 'power and water']) {
    const r = await json(host + '/api/3/action/package_search?rows=15&q=' + encodeURIComponent(q));
    const res = (r.json && r.json.result) || {};
    out.ckan.push({
      host, query: q, status: r.status, error: r.error || r.jsonError,
      total: res.count,
      hits: (res.results || []).map((d) => ({
        title: d.title, name: d.name,
        formats: [...new Set((d.resources || []).map((x) => x.format))],
        urls: (d.resources || []).map((x) => x.url).slice(0, 4)
      }))
    });
    console.log('CKAN  ' + host + '  ' + q + ' -> '
      + (res.count !== undefined ? res.count + ' datasets' : (r.error || r.status)));
    (res.results || []).forEach((d) => console.log('        ' + d.title));
  }
}

/* ---- 3. An ArcGIS server of their own --------------------------------- */
const ARCGIS_ROOTS = [
  'https://services.arcgis.com/vkTwD8kHw2woKBqV/arcgis/rest/services?f=json',
  'https://gis.powerwater.com.au/arcgis/rest/services?f=json',
  'https://maps.powerwater.com.au/arcgis/rest/services?f=json',
  'https://spatial.nt.gov.au/arcgis/rest/services?f=json',
  'https://www.ntlis.nt.gov.au/arcgis/rest/services?f=json'
];
for (const url of ARCGIS_ROOTS) {
  const r = await json(url);
  const folders = (r.json && r.json.folders) || [];
  const services = (r.json && r.json.services) || [];
  out.arcgisServers.push({
    url, status: r.status, error: r.error || r.jsonError,
    challenged: r.challenged, folders, services: services.map((s) => s.name + ' (' + s.type + ')')
  });
  console.log('ESRI  ' + url.replace('?f=json', '') + ' -> '
    + (r.error || (r.status + (r.json ? '  folders: ' + folders.length + '  services: ' + services.length : ''))));
  if (folders.length) console.log('        folders: ' + folders.join(', '));
}

/* ---- 4. Conventional paths, recorded only ----------------------------- */
const PATHS = [
  'https://www.powerwater.com.au/outages',
  'https://www.powerwater.com.au/outages/current-outages',
  'https://www.powerwater.com.au/api/outages',
  'https://www.powerwater.com.au/api/outages/current',
  'https://outages.powerwater.com.au/',
  'https://outagemap.powerwater.com.au/',
  'https://www.powerwater.com.au/sitemap.xml',
  'https://jacanaenergy.com.au/outages',
  'https://www.jacanaenergy.com.au/faults-and-outages'
];
for (const url of PATHS) {
  const r = await get(url);
  out.paths.push({
    url, status: r.status, error: r.error, type: r.type, bytes: r.bytes,
    challenged: r.challenged, title: r.title,
    /* Any JSON the page itself names is a lead worth keeping; an endpoint the
       site publishes is not a workaround. */
    jsonHints: r.text ? [...new Set((r.text.match(/["'][^"']*\/(?:api|rest|data)\/[^"']{0,80}["']/g) || [])
      .map((s) => s.slice(1, -1)))].slice(0, 12) : undefined
  });
  console.log('PATH  ' + url + ' -> ' + (r.error || r.status)
    + (r.challenged ? '  [BOT CHALLENGE]' : '')
    + (r.title ? '  "' + r.title.slice(0, 60) + '"' : ''));
}

mkdirSync('data', { recursive: true });
writeFileSync('data/nt-power-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/nt-power-probe.json');
