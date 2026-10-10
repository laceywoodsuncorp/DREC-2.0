/* Are the third-party outage layers actually live?

   The distributor search turned up two services published by a third party
   (owner "QitAndrew") whose columns are a real outage schema rather than
   asset data:

     NSW_AusGrid_Outages   Cause, Customers, OutageDisplayType
     NBC_Outages_Jemena    outageType, outageLabel, suburb,
                           numberOfCustomersOffSupply, cause,
                           estimatedRestorationTime

   Jemena currently reports nothing on the dashboard, so that second one
   matters -- if it is live.

   That is the whole question and it is not answered by the schema. A
   service last modified in 2024 with a single row could be a live feed on
   a quiet night or a snapshot somebody published once and abandoned. The
   project has already been caught by exactly this: "Is Your Power Out" had
   a real API, a real schema, and one provider four months stale.

   So this reads the rows and the timestamps. A restoration time in the
   past by months, or a row that does not move between two reads a minute
   apart on a busy network, says abandoned.

   Run: node scripts/probe-outage-mirrors.mjs   (writes data/outage-mirrors.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const json = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const t = await r.text();
    try { return { status: r.status, json: JSON.parse(t) }; }
    catch (e) { return { status: r.status, head: t.slice(0, 200) }; }
  } catch (e) { return { error: e.message }; }
};

const SERVICES = [
  ['Ausgrid mirror', 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/NSW_AusGrid_Outages/FeatureServer'],
  ['Jemena mirror (NBC)', 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/NBC_Outages_Jemena/FeatureServer'],
  ['Jemena mirror (HCC)', 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/HCC_Outages_Jemena/FeatureServer']
];

/* Any value that looks like a date, however it is encoded. ArcGIS hands
   back epoch milliseconds for a date field and a string for a text one. */
function asDate(v) {
  if (typeof v === 'number' && v > 1e11 && v < 4e12) return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d) && d.getFullYear() > 2000 && d.getFullYear() < 2100) return d;
  }
  return null;
}

const out = { at: new Date().toISOString(), services: [] };
for (const [label, base] of SERVICES) {
  console.log('\n======== ' + label);
  console.log('  ' + base);
  const meta = await json(base + '?f=json');
  const layers = (meta.json && meta.json.layers) || [];
  const entry = { label, base, status: meta.status, layers: [] };
  for (const l of layers) {
    const cnt = await json(base + '/' + l.id + '/query?where=1%3D1&returnCountOnly=true&f=json');
    const rows = await json(base + '/' + l.id
      + '/query?where=1%3D1&outFields=*&resultRecordCount=5&f=json');
    const feats = (rows.json && rows.json.features) || [];
    /* The newest timestamp anywhere in the returned rows. If the freshest
       thing in a live outage feed is months old, it is not live. */
    let newest = null;
    feats.forEach((f) => Object.values(f.attributes || {}).forEach((v) => {
      const d = asDate(v);
      if (d && (!newest || d > newest)) newest = d;
    }));
    const ageDays = newest ? Math.round((Date.now() - newest.getTime()) / 86400000) : null;
    entry.layers.push({ id: l.id, name: l.name, count: cnt.json && cnt.json.count,
      newest: newest ? newest.toISOString() : null, ageDays,
      sample: feats.slice(0, 2).map((f) => f.attributes) });
    console.log('    layer ' + l.id + ' "' + l.name + '"  rows=' + (cnt.json && cnt.json.count)
      + '  newest=' + (newest ? newest.toISOString().slice(0, 16) + '  (' + ageDays + ' days old)' : 'no date field'));
    feats.slice(0, 2).forEach((f) => {
      const a = f.attributes || {};
      const brief = Object.keys(a).slice(0, 8).map((k) => k + '=' + JSON.stringify(a[k])).join('  ');
      console.log('      ' + brief.slice(0, 150));
    });
  }
  out.services.push(entry);
}

mkdirSync('data', { recursive: true });
writeFileSync('data/outage-mirrors.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/outage-mirrors.json');
