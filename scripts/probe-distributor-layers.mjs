/* Does any Australian electricity distributor we cannot read publish its
   outages as an open map layer?

   This is the question that recovered Queensland. Energex and Ergon both
   serve a bot challenge on their own websites, and both publish current
   outage areas as open ArcGIS feature services -- which is the only reason
   the dashboard has Queensland at all. Western Power is the same. So the
   right question for the operators still missing is not "can we get past
   the website" but "did they publish it somewhere else".

   Searched by operator name rather than by the word outage, because a
   generic search ranks globally and drowns in United States layers: an
   earlier run of this idea came back with Nashville water services and Cal
   OES. Every candidate is then opened -- layer list, row count, field
   names, extent -- and the extent is checked against Australia, because a
   layer in the wrong hemisphere is the fastest way to end a lead.

   Nothing here touches a protection. It reads a public catalogue.

   Run: node scripts/probe-distributor-layers.mjs   (writes data/distributor-layers.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch (e) { return { status: res.status, parseError: e.message, head: text.slice(0, 160) }; }
  } catch (e) { return { error: e.message }; }
}

/* Australia, generously. A layer outside this is not ours, whatever it is
   called -- the two "ElectricalOutages" layers an earlier probe turned up
   were in a United States projection and cost a round trip to rule out. */
const inAustralia = (ext) => {
  if (!ext) return null;
  const { xmin, xmax, ymin, ymax } = ext;
  if (![xmin, xmax, ymin, ymax].every((v) => typeof v === 'number' && isFinite(v))) return null;
  if (Math.abs(xmax) <= 180 && Math.abs(ymax) <= 90) {
    return xmin > 100 && xmax < 160 && ymin > -45 && ymax < -8;
  }
  /* Web Mercator metres. */
  return xmin > 11000000 && xmax < 17000000 && ymin > -5600000 && ymax < -800000;
};

const OPERATORS = [
  'Essential Energy', 'Horizon Power', 'SA Power Networks', 'Ausgrid', 'Endeavour Energy',
  'CitiPower', 'Powercor', 'United Energy', 'Jemena', 'AusNet Services',
  'TasNetworks', 'Evoenergy', 'Power and Water Corporation', 'Energy Queensland'
];

const out = { at: new Date().toISOString(), operators: {} };

for (const op of OPERATORS) {
  console.log('\n======== ' + op);
  out.operators[op] = { searches: [], candidates: [] };
  const seen = new Set();

  for (const extra of [' outage', '']) {
    /* The operator name is quoted so the search treats it as a phrase.
       Unquoted, "Essential Energy" matches every layer containing the word
       energy, which is most of the catalogue. */
    const q = '"' + op + '"' + extra;
    const url = 'https://www.arcgis.com/sharing/rest/search?f=json&num=20&q='
      + encodeURIComponent(q + ' (type:"Feature Service" OR type:"Map Service")');
    const r = await json(url);
    const results = (r.json && r.json.results) || [];
    out.operators[op].searches.push({ query: q, total: r.json && r.json.total, hits: results.length });
    console.log('  search "' + q + '" -> ' + (r.json ? r.json.total + ' total, ' + results.length + ' shown'
      : (r.error || r.status)));
    results.forEach((x) => {
      if (!x.url || seen.has(x.url)) return;
      seen.add(x.url);
      out.operators[op].candidates.push({ title: x.title, owner: x.owner, url: x.url,
        type: x.type, modified: x.modified ? new Date(x.modified).toISOString().slice(0, 10) : null });
    });
    await sleep(400);
  }

  /* Open each candidate. A title is a claim; the layer list, the row count
     and the extent are the evidence. */
  for (const c of out.operators[op].candidates.slice(0, 6)) {
    const meta = await json(c.url + '?f=json');
    const layers = (meta.json && meta.json.layers) || [];
    c.serviceStatus = meta.status;
    c.extent = meta.json && (meta.json.fullExtent || meta.json.initialExtent);
    c.inAustralia = inAustralia(c.extent);
    c.layers = [];
    console.log('    ' + c.title + '  [' + c.owner + ']  ' + (c.modified || ''));
    console.log('      ' + c.url);
    console.log('      layers=' + layers.length + '  inAustralia=' + c.inAustralia);
    for (const l of layers.slice(0, 3)) {
      const cnt = await json(c.url + '/' + l.id + '/query?where=1%3D1&returnCountOnly=true&f=json');
      const sample = await json(c.url + '/' + l.id
        + '/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json');
      const feats = (sample.json && sample.json.features) || [];
      const fields = feats.length ? Object.keys(feats[0].attributes || {}) : [];
      /* The columns decide whether this is live outages or an asset layer
         that merely mentions them. */
      const outageish = fields.filter((f) => /outage|customer|restor|affect|suburb|locality|cause|eta|crew/i.test(f));
      c.layers.push({ id: l.id, name: l.name, count: cnt.json && cnt.json.count,
        fields: fields.slice(0, 24), outageFields: outageish });
      console.log('        layer ' + l.id + ' "' + l.name + '"  rows=' + (cnt.json && cnt.json.count));
      if (outageish.length) console.log('          outage-ish fields: ' + outageish.join(', '));
      await sleep(250);
    }
  }
  if (!out.operators[op].candidates.length) console.log('    (no feature services found)');
}

mkdirSync('data', { recursive: true });
writeFileSync('data/distributor-layers.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/distributor-layers.json');
