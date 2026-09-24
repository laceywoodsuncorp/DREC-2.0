/* Builds data/gazetteer.json: every Australian suburb and locality with its
   state and a centroid.

   The outage map needs this because only four of the sixteen operators
   publish a coordinate. Energex, Ergon, Western Power and Endeavour send
   geometry; the other twelve send a town name and nothing else, so without a
   gazetteer the map would draw Queensland, Western Australia and part of
   western Sydney and leave all of Victoria empty -- which a reader would take
   to mean Victoria has no outages.

   The source is the ABS's own ArcGIS server, found by probing rather than
   assumed: it is queryable the same way the Queensland outage layers are, it
   is the authoritative boundary set, and it is CC-BY. A GeoPackage download
   would have meant parsing a SQLite spatial format in Node for the same
   answer.

   Nothing here is guessed. The service is listed, the SAL layer is found by
   name, and its field names are read from its own metadata before anything is
   queried -- the alternative is the mistake this project has made repeatedly,
   where a column is assumed, matches nothing, and the result reads as empty
   rather than as wrong.

   Run: node scripts/build-gazetteer.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const ROOT = 'https://geo.abs.gov.au/arcgis/rest/services';
const PAGE = 2000;

const get = async (url) => {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url.slice(0, 120));
  const body = await res.json();
  if (body.error) throw new Error(body.error.message + ' for ' + url.slice(0, 120));
  return body;
};

/* Which ASGS edition is current is not worth hard-coding -- the ABS adds a new
   one every few years and a pinned year would quietly rot. */
async function findSalLayer() {
  const root = await get(ROOT + '?f=json');
  const folders = (root.folders || []).filter((f) => /^ASGS/i.test(f)).sort().reverse();
  if (!folders.length) throw new Error('No ASGS folder at ' + ROOT);

  for (const folder of folders) {
    const listing = await get(ROOT + '/' + folder + '?f=json');
    /* SAL is the ABS's code for Suburbs and Localities. */
    const svc = (listing.services || []).find((s) => /\/SAL$|\bSAL\b/i.test(s.name));
    if (!svc) continue;
    const base = ROOT.replace('/rest/services', '/rest/services') + '/' + svc.name.replace(/^.*\//, '');
    const url = ROOT + '/' + folder + '/' + svc.name.split('/').pop() + '/' + svc.type;
    const meta = await get(url + '?f=json');
    const layers = meta.layers || [];
    if (!layers.length) continue;
    return { folder, url, layerId: layers[0].id, layerName: layers[0].name };
  }
  throw new Error('No SAL service found in ' + folders.join(', '));
}

/* The field names carry the edition year (SAL_NAME_2021, SAL_NAME_2024...),
   so they are read rather than written down. */
function pickFields(fields) {
  const names = fields.map((f) => f.name);
  const name = names.find((n) => /^SAL_NAME/i.test(n)) || names.find((n) => /NAME/i.test(n));
  const state = names.find((n) => /^STATE_NAME/i.test(n))
    || names.find((n) => /STATE.*NAME|^STE_NAME/i.test(n))
    || names.find((n) => /STATE/i.test(n));
  return { name, state };
}

const STATE_CODES = {
  'NEW SOUTH WALES': 'NSW', 'VICTORIA': 'VIC', 'QUEENSLAND': 'QLD',
  'SOUTH AUSTRALIA': 'SA', 'WESTERN AUSTRALIA': 'WA', 'TASMANIA': 'TAS',
  'NORTHERN TERRITORY': 'NT', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT',
  'OTHER TERRITORIES': 'OT'
};

(async () => {
  const found = await findSalLayer();
  console.log('layer: ' + found.folder + '  ' + found.url + '/' + found.layerId
    + '  (' + found.layerName + ')');

  const layerUrl = found.url + '/' + found.layerId;
  const layerMeta = await get(layerUrl + '?f=json');
  const f = pickFields(layerMeta.fields || []);
  if (!f.name || !f.state) {
    throw new Error('Could not find name/state fields in: '
      + (layerMeta.fields || []).map((x) => x.name).join(', '));
  }
  console.log('fields: name=' + f.name + '  state=' + f.state);

  const count = (await get(layerUrl + '/query?where=1%3D1&returnCountOnly=true&f=json')).count;
  console.log('features: ' + count);

  const items = [];
  const seen = new Set();
  let skippedNoCentroid = 0;

  for (let offset = 0; offset < count; offset += PAGE) {
    /* returnCentroid gives a point without downloading polygon rings -- the
       boundaries here are tens of megabytes and the map only needs a dot. */
    const url = layerUrl + '/query?where=1%3D1'
      + '&outFields=' + encodeURIComponent(f.name + ',' + f.state)
      + '&returnGeometry=false&returnCentroid=true&outSR=4326'
      + '&resultOffset=' + offset + '&resultRecordCount=' + PAGE + '&f=json';
    const page = await get(url);
    (page.features || []).forEach((feat) => {
      const a = feat.attributes || {};
      /* The ABS disambiguates a repeated name by appending the state:
         "CROMER (NSW)" and "CROMER (SA)", "CROWS NEST (NSW)" and
         "CROWS NEST (QLD)". The state is already its own column here, so the
         suffix is noise that makes an exact lookup miss -- which is what it
         did, leaving two perfectly ordinary Sydney suburbs unplaceable while
         the data for them sat in the file. Only a recognised state code is
         stripped, so a name that genuinely ends in brackets survives. */
      const rawName = String(a[f.name] || '').trim().toUpperCase();
      const name = rawName.replace(/\s*\((NSW|VIC|QLD|SA|WA|TAS|NT|ACT|OT)\)$/, '').trim();
      const stateName = String(a[f.state] || '').trim().toUpperCase();
      const state = STATE_CODES[stateName] || stateName.slice(0, 3);
      const c = feat.centroid;
      if (!name || !c || !isFinite(c.y) || !isFinite(c.x)) { skippedNoCentroid++; return; }
      /* A locality name repeats across states -- there is a Richmond in five
         of them -- so the key has to carry the state or the map would put
         Victorian outages in Tasmania. */
      const key = name + '|' + state;
      if (seen.has(key)) return;
      seen.add(key);
      /* Three decimals is about 110 metres, which is far finer than a
         locality centroid means anything to, and it nearly halves the file. */
      items.push([name, state, Math.round(c.y * 1000) / 1000, Math.round(c.x * 1000) / 1000]);
    });
    console.log('  ' + Math.min(offset + PAGE, count) + '/' + count);
  }

  items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const byState = {};
  items.forEach((i) => { byState[i[1]] = (byState[i[1]] || 0) + 1; });

  const out = {
    /* Recorded with the data: a gazetteer whose provenance is not written
       down is one nobody can check or re-licence later. */
    source: layerUrl,
    edition: found.folder,
    licence: 'CC BY 4.0 — Australian Bureau of Statistics',
    attribution: 'Suburbs and Localities boundaries © Australian Bureau of Statistics',
    builtAt: Date.now(),
    fields: ['name', 'state', 'lat', 'lon'],
    counts: byState,
    skippedNoCentroid,
    items
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/gazetteer.json', JSON.stringify(out));
  console.log('\nwrote data/gazetteer.json  ' + items.length + ' localities, '
    + Math.round(JSON.stringify(out).length / 1024) + ' KB');
  console.log('by state: ' + Object.entries(byState).map(([k, v]) => k + ' ' + v).join(', '));
  if (skippedNoCentroid) console.log('skipped (no centroid): ' + skippedNoCentroid);
})();
