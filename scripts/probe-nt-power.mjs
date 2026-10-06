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

/* ---- 5. Round two, chasing what round one surfaced ------------------- */
/* Round one's keyword search returned mostly United States layers, because
   "power outage" is a common phrase and ArcGIS Online ranks globally. These
   are the specific leads worth settling rather than more keywords. */
out.round2 = { candidateLayers: [], nationalPortal: [], jacana: [], agolScoped: [] };

/* 5a. The only two hits that could plausibly have been Australian. Both are
   owned by "MAGICAdmin" and both were last modified in April 2021, which for
   a live outage layer is itself close to an answer -- but a layer can be old
   and still fed, so ask it for its extent and a row count. */
for (const base of [
  'https://services.arcgis.com/YKu9KTHe0ln1JUmf/arcgis/rest/services/ElectricalOutages/FeatureServer',
  'https://services.arcgis.com/YKu9KTHe0ln1JUmf/arcgis/rest/services/PublicElectricalOutages/FeatureServer'
]) {
  const meta = await json(base + '?f=json');
  const layers = (meta.json && meta.json.layers) || [];
  const entry = { base, status: meta.status, error: meta.error || meta.jsonError,
    serviceDescription: meta.json && meta.json.serviceDescription,
    extent: meta.json && meta.json.fullExtent, layers: [] };
  for (const l of layers.slice(0, 4)) {
    const cnt = await json(base + '/' + l.id + '/query?where=1%3D1&returnCountOnly=true&f=json');
    const sample = await json(base + '/' + l.id
      + '/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json');
    const feats = (sample.json && sample.json.features) || [];
    entry.layers.push({ id: l.id, name: l.name,
      count: cnt.json && cnt.json.count,
      fields: feats.length ? Object.keys(feats[0].attributes || {}).slice(0, 20) : [],
      firstRow: feats.length ? feats[0].attributes : null });
  }
  out.round2.candidateLayers.push(entry);
  console.log('LAYER ' + base.split('/services/')[1] + ' -> '
    + (entry.error || entry.layers.map((l) => l.name + ': ' + l.count + ' rows').join('; ')));
  /* An extent in the wrong hemisphere settles it faster than any field
     inspection. The NT spans roughly 129-138E, -11 to -26. */
  if (entry.extent) {
    console.log('        extent x ' + entry.extent.xmin + '..' + entry.extent.xmax
      + '  y ' + entry.extent.ymin + '..' + entry.extent.ymax);
  }
}

/* 5b. The national open data portal, which aggregates state and territory
   publishers and would list a Power and Water dataset if one existed. */
for (const q of ['power and water outage', 'electricity outage northern territory', 'power outage']) {
  const r = await json('https://data.gov.au/data/api/3/action/package_search?rows=10&q='
    + encodeURIComponent(q));
  const res = (r.json && r.json.result) || {};
  out.round2.nationalPortal.push({ query: q, status: r.status, error: r.error || r.jsonError,
    total: res.count,
    hits: (res.results || []).map((d) => ({ title: d.title, org: d.organization && d.organization.title,
      formats: [...new Set((d.resources || []).map((x) => x.format))] })) });
  console.log('DGAU  ' + q + ' -> ' + (res.count !== undefined ? res.count : (r.error || r.status)));
  (res.results || []).slice(0, 6).forEach((d) => console.log('        ' + d.title
    + '  [' + ((d.organization && d.organization.title) || '?') + ']'));
}

/* 5c. Jacana Energy answered 404 on two guessed paths, so stop guessing and
   read what the site itself links to. Jacana is the Territory's retailer and
   Power and Water the distributor, so Jacana may only link onward -- but a
   link is still a lead, and their host is not challenged. */
for (const url of ['https://www.jacanaenergy.com.au/', 'https://www.jacanaenergy.com.au/sitemap.xml']) {
  const r = await get(url);
  const links = r.text ? [...new Set((r.text.match(/href="([^"]+)"|<loc>([^<]+)<\/loc>/g) || [])
    .map((m) => m.replace(/^href="|"$|<loc>|<\/loc>/g, ''))
    .filter((h) => /outage|fault|interrupt|supply|emergency|power.?out/i.test(h)))] : [];
  out.round2.jacana.push({ url, status: r.status, error: r.error, bytes: r.bytes, links: links.slice(0, 20) });
  console.log('JACANA ' + url + ' -> ' + (r.error || r.status)
    + '  outage-ish links: ' + links.length);
  links.slice(0, 10).forEach((l) => console.log('        ' + l));
}

/* 5d. The same ArcGIS Online search, but bounded to Australia so the United
   States layers that drowned round one cannot rank. */
for (const q of ['outage', 'electrical outage', 'power outage']) {
  const url = 'https://www.arcgis.com/sharing/rest/search?f=json&num=25'
    + '&bbox=' + encodeURIComponent('112,-44,154,-9')
    + '&q=' + encodeURIComponent(q + ' (type:"Feature Service" OR type:"Map Service")');
  const r = await json(url);
  const results = (r.json && r.json.results) || [];
  out.round2.agolScoped.push({ query: q, status: r.status, total: r.json && r.json.total,
    hits: results.map((x) => ({ title: x.title, owner: x.owner, url: x.url,
      modified: x.modified ? new Date(x.modified).toISOString().slice(0, 10) : null })) });
  console.log('AGOL-AU  ' + q + ' -> ' + (r.json ? r.json.total + ' total' : (r.error || r.status)));
  results.forEach((x) => console.log('        ' + x.title + '  [' + x.owner + ']  '
    + (x.modified ? new Date(x.modified).toISOString().slice(0, 10) : '') + '  ' + (x.url || '')));
}

mkdirSync('data', { recursive: true });
writeFileSync('data/nt-power-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/nt-power-probe.json');
