/* Which road authorities publish flooded-road reports a dashboard can
   read, and what do the records look like?

   Asked for: a second tab in the flooding section for road flooding,
   organised by severity, with the time since each report. Road closures
   and hazards are published state by state, by each road authority. This
   asks each candidate feed once and records: whether it answers without a
   key, its shape, how many records it holds, which fields look like type,
   severity and time, and a few records that mention flooding -- so the
   parsers are written against real records. Licence notes are recorded
   where a catalogue entry carries them.

   No key is guessed or borrowed. A feed that wants one is recorded as
   needing one.

   Run: node scripts/probe-road-flooding.mjs   (writes data/road-flooding-probe.json) */
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const FLOOD = /flood|water over|water on road|inundat|causeway|washed? ?out|washout/i;

const CANDIDATES = [
  ['NSW', 'Live Traffic NSW flood hazards', 'https://www.livetraffic.com/traffic/hazards/flood.json'],
  ['NSW', 'Live Traffic NSW flood hazards (open)', 'https://www.livetraffic.com/traffic/hazards/flood-open.json'],
  ['NSW', 'Live Traffic NSW incidents (open)', 'https://www.livetraffic.com/traffic/hazards/incident-open.json'],
  ['QLD', 'QLDTraffic events (no key)', 'https://api.qldtraffic.qld.gov.au/v2/events'],
  ['QLD', 'QLDTraffic events v1 (no key)', 'https://api.qldtraffic.qld.gov.au/v1/events'],
  ['VIC', 'VicRoads unplanned disruptions (no key)', 'https://data-exchange-api.vicroads.vic.gov.au/opendata/disruptions/v2/unplanned'],
  ['VIC', 'VicEmergency events', 'https://emergency.vic.gov.au/public/events-geojson.json'],
  ['VIC', 'VicEmergency osom', 'https://emergency.vic.gov.au/public/osom-geojson.json'],
  ['VIC', 'VicTraffic incidents', 'https://traffic.transport.vic.gov.au/geoserver/victraffic/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=victraffic:incidents&outputFormat=application/json'],
  ['SA', 'Traffic SA open data service', 'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer?f=json'],
  ['SA', 'Traffic SA road closures', 'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json'],
  ['SA', 'Traffic SA layer 1', 'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=json'],
  ['SA', 'Traffic SA layer 2', 'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/2/query?where=1%3D1&outFields=*&outSR=4326&f=json'],
  ['WA', 'Main Roads WA road incidents service', 'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadIncidents/FeatureServer?f=json'],
  ['WA', 'Main Roads WA road incidents /1', 'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadIncidents/FeatureServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=json'],
  ['WA', 'Main Roads WA road incidents /0', 'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadIncidents/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json'],
  ['NT', 'Road Report NT obstructions', 'https://roadreport.nt.gov.au/api/Obstruction/GetAll'],
  ['NT', 'Road Report NT road conditions', 'https://roadreport.nt.gov.au/api/Road/GetAll'],
  ['TAS', 'TasALERT data', 'https://alert.tas.gov.au/data/data.geojson'],
  ['TAS', 'Tasmania Police road closures', 'https://www.police.tas.gov.au/community-alerts/feed/'],
  ['ACT', 'ACT road closures dataset', 'https://www.data.act.gov.au/resource/k7ij-ikx3.json']
];

/* The records in a response, whatever envelope it uses. */
function records(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.features)) return j.features.map((f) => Object.assign({}, f.properties || f.attributes || {}, f.geometry ? { _geometry: f.geometry.type || 'esri' } : {}));
  for (const k of ['events', 'data', 'results', 'items', 'obstructions', 'incidents', 'value']) if (j && Array.isArray(j[k])) return j[k];
  return null;
}
const trim = (o, depth = 0) => {
  if (o == null || typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 400) : o;
  if (Array.isArray(o)) return depth > 2 ? '[' + o.length + ']' : o.slice(0, 3).map((x) => trim(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 60)) out[k] = depth > 3 ? '…' : trim(v, depth + 1);
  return out;
};

const report = { at: new Date().toISOString(), feeds: [], catalogue: [] };
for (const [state, label, url] of CANDIDATES) {
  const row = { state, label, url };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, application/geo+json, text/xml;q=0.8, */*;q=0.5' }, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    const body = await res.text();
    row.status = res.status;
    row.type = (res.headers.get('content-type') || '').split(';')[0];
    row.bytes = body.length;
    let j = null;
    try { j = JSON.parse(body); } catch (e) { row.head = body.slice(0, 600); }
    if (j) {
      const recs = records(j);
      if (!recs) { row.shape = trim(j); }
      else {
        row.count = recs.length;
        row.keys = recs.length ? Object.keys(recs[0]).slice(0, 60) : [];
        /* Values of the fields that look like a type, category, status or
           severity -- these decide how records are grouped. */
        row.values = {};
        for (const k of row.keys.filter((n) => /type|categ|status|severity|priority|impact|closure|condition|restriction|advice|major/i.test(n))) {
          const c = {};
          for (const r of recs) { const v = typeof r[k] === 'object' ? JSON.stringify(r[k]).slice(0, 80) : String(r[k]); c[v] = (c[v] || 0) + 1; }
          row.values[k] = Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 14));
        }
        const flooded = recs.filter((r) => FLOOD.test(JSON.stringify(r)));
        row.floodRelated = flooded.length;
        row.samples = (flooded.length ? flooded : recs).slice(0, 3).map((r) => trim(r));
      }
    }
  } catch (e) { row.error = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 160); }
  report.feeds.push(row);
  console.log(state.padEnd(4) + String(row.status || row.error).padEnd(9) + String(row.count ?? '').padStart(6) + ' recs ' +
    String(row.floodRelated ?? '').padStart(4) + ' flood  ' + label + (row.keys ? '\n       keys: ' + row.keys.slice(0, 22).join(', ') : ''));
  await new Promise((r) => setTimeout(r, 800));
}

/* Catalogue entries, for each feed's own description, licence and access
   notes -- including whether a road authority documents a key for public
   use. Recorded as text; nothing is done with it here. */
const CATALOGUES = [
  ['QLD', 'https://www.data.qld.gov.au/api/3/action/package_search?rows=5&q=' + encodeURIComponent('QLDTraffic GeoJSON API')],
  ['NSW', 'https://opendata.transport.nsw.gov.au/api/3/action/package_search?rows=5&q=' + encodeURIComponent('live traffic hazards')],
  ['VIC', 'https://discover.data.vic.gov.au/api/3/action/package_search?rows=5&q=' + encodeURIComponent('unplanned disruptions road')],
  ['SA', 'https://data.sa.gov.au/data/api/3/action/package_search?rows=5&q=' + encodeURIComponent('traffic SA road closures')],
  ['WA', 'https://catalogue.data.wa.gov.au/api/3/action/package_search?rows=5&q=' + encodeURIComponent('road incidents Main Roads')],
  ['NT', 'https://data.nt.gov.au/api/3/action/package_search?rows=5&q=' + encodeURIComponent('road report')]
];
for (const [state, url] of CATALOGUES) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const j = await res.json();
    for (const p of ((j.result || {}).results || [])) {
      report.catalogue.push({ state, title: p.title, org: p.organization && p.organization.title, licence: p.license_title || p.license_id,
        notes: String(p.notes || '').replace(/\s+/g, ' ').slice(0, 1500),
        resources: (p.resources || []).slice(0, 8).map((r) => ({ name: r.name, format: r.format, url: r.url, description: String(r.description || '').replace(/\s+/g, ' ').slice(0, 600) })) });
    }
    console.log('catalogue ' + state + ': ' + ((j.result || {}).results || []).map((p) => p.title + ' [' + (p.license_title || '?') + ']').join(' | ').slice(0, 300));
  } catch (e) { report.catalogue.push({ state, error: String(e.message).slice(0, 160) }); console.log('catalogue ' + state + ': ' + e.message); }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/road-flooding-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/road-flooding-probe.json');
