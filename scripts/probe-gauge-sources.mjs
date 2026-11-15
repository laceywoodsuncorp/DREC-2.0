/* Which published source knows where the river gauges the map cannot
   place are?

   After IDM00019 and BOM's 2012 station list, 1,881 of 3,578 gauges have
   no location -- nearly all with 5xxxxx station numbers (ALERT and agency
   gauges), including most gauges in flood. Reported from the dashboard:
   "some of the locations are not placed on the map".

   Candidates, each measured against the unplaced gauges' station numbers
   (never their names):
     - every station list in BOM's FTP sitelists directory (stations.txt,
       stations.zip, IDCJMC0017.zip, num_All.txt)
     - every spatial table in BOM's FTP spatial directory (IDM000xx.dbf)
     - Queensland flood-gauge layers on ArcGIS (QRA's flood warning
       infrastructure network; the "BOM Flood Gauges" layer), and any
       ArcGIS layer whose station field holds these numbers
     - Queensland's open data catalogue, searched for gauge datasets

   Run: node scripts/probe-gauge-sources.mjs   (writes data/gauge-sources-probe.json) */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readDbf } from './build-gauge-locations.mjs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const SITELISTS = 'ftp://ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists/';
const SPATIAL = 'ftp://ftp.bom.gov.au/anon/home/adfd/spatial/';
const TMP = 'data/.gauge-sources';
const report = { at: new Date().toISOString(), sources: [] };

const rivers = JSON.parse(readFileSync('data/rivers.json', 'utf8'));
const unplaced = new Map(), flooding = new Set();
for (const g of rivers.groups) for (const s of g.stations) {
  if (s.at) continue;
  const id = ((/\.(\d{5,7})\.plt/.exec(s.plot || '') || [])[1] || '').padStart(6, '0');
  if (id === '000000') continue;
  unplaced.set(id, g.state + ' ' + s.name);
  if (s.level) flooding.add(id);
}
report.unplaced = unplaced.size;
report.unplacedFlooding = [...flooding].map((id) => id + ' ' + unplaced.get(id));
console.log('unplaced gauges: ' + unplaced.size + ', in flood: ' + flooding.size);

const curl = (args, max = 180) => {
  try { return execFileSync('curl', ['-sS', '--max-time', String(max), '--connect-timeout', '20', '-A', UA, ...args],
    { encoding: 'latin1', maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { return { error: String(e.stderr || e.message).slice(0, 200) }; }
};
const inAus = (lat, lon) => lat < -9 && lat > -45 && lon > 110 && lon < 160;
/* Records a source's coverage: `found` maps station number -> [lat, lon]. */
function measure(name, found, extra) {
  const hits = [...found.keys()].filter((id) => unplaced.has(id));
  const row = Object.assign({ name, located: found.size, unplacedCovered: hits.length,
    floodingCovered: [...flooding].filter((id) => found.has(id)).map((id) => id + ' ' + unplaced.get(id) + ' ' + JSON.stringify(found.get(id))),
    sample: hits.slice(0, 4).map((id) => id + ' ' + unplaced.get(id) + ' ' + JSON.stringify(found.get(id))) }, extra || {});
  report.sources.push(row);
  console.log(name.padEnd(46) + ' located ' + String(found.size).padStart(6) + '  covers ' + String(hits.length).padStart(5) +
    ' unplaced, ' + row.floodingCovered.length + ' in flood');
  return row;
}
/* Station number, then a latitude and longitude somewhere after it on the
   line: enough to measure any of BOM's fixed-width or CSV station lists. */
function fromText(text) {
  const found = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^[\s"]*(\d{5,6})\b.*?(-\d{1,2}\.\d{2,})[\s,"]+(\d{3}\.\d{2,})/.exec(line);
    if (!m) continue;
    const lat = Number(m[2]), lon = Number(m[3]);
    if (inAus(lat, lon)) found.set(m[1].padStart(6, '0'), [lat, lon]);
  }
  return found;
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

/* BOM station lists. */
for (const f of ['stations.txt', 'num_All.txt']) {
  const t = curl([SITELISTS + f]);
  if (typeof t !== 'string') { report.sources.push({ name: 'sitelists/' + f, error: t.error }); continue; }
  measure('sitelists/' + f, fromText(t), { bytes: t.length, head: t.slice(0, 700) });
}
for (const f of ['stations.zip', 'IDCJMC0017.zip']) {
  const out = TMP + '/' + f, dir = out + '.d';
  const r = curl([SITELISTS + f, '-o', out]);
  if (typeof r !== 'string') { report.sources.push({ name: 'sitelists/' + f, error: r.error }); continue; }
  mkdirSync(dir, { recursive: true });
  /* unzip exits 1 on a warning (this archive stores absolute paths) having
     extracted everything; only a missing output is a failure. */
  try { execFileSync('unzip', ['-o', '-q', out, '-d', dir], { stdio: 'ignore' }); } catch (e) { /* see below */ }
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = d + '/' + n; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const members = walk(dir);
  if (!members.length) { report.sources.push({ name: 'sitelists/' + f, error: 'nothing extracted' }); continue; }
  for (const m of members) {
    const t = readFileSync(m, 'latin1');
    measure('sitelists/' + f + ':' + m.slice(dir.length + 1), fromText(t), { bytes: t.length, head: t.slice(0, 700) });
  }
}

/* BOM spatial tables. */
const spatial = curl(['--list-only', SPATIAL], 60);
if (typeof spatial === 'string') {
  const dbfs = spatial.split(/\r?\n/).map((x) => x.trim()).filter((x) => /\.dbf$/i.test(x));
  report.spatialDbfs = dbfs;
  for (const f of dbfs) {
    const out = TMP + '/' + f;
    const r = curl([SPATIAL + f, '-o', out], 240);
    if (typeof r !== 'string') { report.sources.push({ name: 'spatial/' + f, error: r.error }); continue; }
    try {
      const rows = readDbf(readFileSync(out));
      const fields = rows.length ? Object.keys(rows[0]) : [];
      const latF = fields.find((n) => /^LAT/i.test(n)), lonF = fields.find((n) => /^LON/i.test(n));
      const found = new Map();
      if (latF && lonF) {
        for (const row of rows) {
          const lat = Number(row[latF]), lon = Number(row[lonF]);
          if (!inAus(lat, lon)) continue;
          /* Any field holding a station-number-shaped value. */
          for (const n of fields) {
            const v = String(row[n]).replace(/\.0+$/, '');
            if (/^\d{4,6}$/.test(v) && n !== latF && n !== lonF && !/ELEV|ORDER|FID/i.test(n)) found.set(v.padStart(6, '0'), [lat, lon]);
          }
        }
      }
      measure('spatial/' + f, found, { rows: rows.length, fields, sampleRow: rows[0] });
    } catch (e) { report.sources.push({ name: 'spatial/' + f, error: String(e.message).slice(0, 160) }); }
  }
} else report.sources.push({ name: 'spatial', error: spatial.error });

/* ArcGIS layers. Every layer of each service; every field tried as the
   station number. */
const getJson = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': UA } }); return r.json(); };
const sampleIds = [...flooding, ...[...unplaced.keys()].slice(0, 40)];
async function arcgisService(label, base) {
  try {
    const svc = await getJson(base.replace(/\/?$/, '') + '?f=json');
    const layers = (svc.layers || []).map((l) => l.id);
    if (!layers.length && svc.fields) layers.push(null);
    if (!layers.length) { report.sources.push({ name: label, error: (svc.error && svc.error.message) || 'no layers', url: base }); return; }
    for (const id of layers.slice(0, 6)) {
      const lurl = base.replace(/\/?$/, '') + (id === null ? '' : '/' + id);
      const meta = id === null ? svc : await getJson(lurl + '?f=json');
      const feats = [];
      for (let off = 0; off < 20000; off += 1000) {
        const j = await getJson(lurl + '/query?f=json&where=1%3D1&outFields=*&outSR=4326&returnGeometry=true&resultRecordCount=1000&resultOffset=' + off);
        if (j.error) { feats.error = j.error.message; break; }
        feats.push(...(j.features || []));
        if (!j.exceededTransferLimit || !(j.features || []).length) break;
      }
      const found = new Map();
      for (const f of feats) {
        const a = f.attributes || {}, g = f.geometry || {};
        const lat = isFinite(g.y) ? g.y : Number(a.Latitude ?? a.LAT ?? a.latitude), lon = isFinite(g.x) ? g.x : Number(a.Longitude ?? a.LON ?? a.longitude);
        if (!inAus(lat, lon)) continue;
        for (const [k, v] of Object.entries(a)) {
          const s = String(v == null ? '' : v).trim().replace(/\.0+$/, '');
          if (/^\d{5,6}$/.test(s) && !/objectid|fid|^id$/i.test(k)) found.set(s.padStart(6, '0'), [lat, lon]);
        }
      }
      measure(label + (id === null ? '' : ' /' + id) + ' ' + (meta.name || ''), found,
        { url: lurl, features: feats.length, queryError: feats.error, fields: (meta.fields || []).map((x) => x.name).slice(0, 40),
          sampleAttributes: feats[0] && feats[0].attributes });
    }
  } catch (e) { report.sources.push({ name: label, error: String(e.message).slice(0, 160), url: base }); }
}
await arcgisService('QRA flood warning infrastructure network', 'https://services2.arcgis.com/qfHNZ7BGWGkGBVqg/arcgis/rest/services/Flood_Warning_Infrastructure_Network/FeatureServer');
await arcgisService('QRA flood warning infrastructure (north)', 'https://services2.arcgis.com/qfHNZ7BGWGkGBVqg/arcgis/rest/services/Flood_Warning_Infrastructure_Network_North/FeatureServer');
await arcgisService('BOM Flood Gauges (QUU)', 'https://services1.arcgis.com/vkTwD8kHw2woKBqV/arcgis/rest/services/BOM_Flood_Gauges_Flood_Levels_15_min_update_RO/FeatureServer');

/* Other ArcGIS layers that mention these gauges: searched by words, kept
   only where a station field really holds the numbers. */
report.arcgisSearch = [];
const seen = new Set();
for (const q of ['"flood warning" gauge Queensland', 'ALERT rainfall river gauges Australia', '"Bureau of Meteorology" river rainfall stations',
  '"flood gauge" Queensland council', 'rainfall river height stations BOM flood warning network']) {
  try {
    const j = await getJson('https://www.arcgis.com/sharing/rest/search?f=json&num=25&q=' +
      encodeURIComponent('(' + q + ') AND (type:"Feature Service" OR type:"Map Service")'));
    for (const it of (j.results || [])) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      const row = { title: it.title, owner: it.owner, url: it.url, modified: it.modified && new Date(it.modified).toISOString() };
      try {
        const lurl = /\/\d+$/.test(it.url) ? it.url : it.url.replace(/\/?$/, '') + '/0';
        const meta = await getJson(lurl + '?f=json');
        const cand = (meta.fields || []).filter((f) => /station|site|gauge|bom|stn|asset_code|number|^id$|_id$|ref/i.test(f.name) && !/objectid|globalid/i.test(f.name)).slice(0, 4);
        for (const f of cand) {
          const str = /String/.test(f.type);
          const list = sampleIds.map((id) => (str ? "'" + id + "'" : String(Number(id)))).join(',');
          const qj = await getJson(lurl + '/query?f=json&returnCountOnly=true&where=' + encodeURIComponent(f.name + ' IN (' + list + ')'));
          if (qj.count) { row.matchField = f.name; row.matches = qj.count; break; }
        }
        row.fields = (meta.fields || []).map((x) => x.name).slice(0, 25);
      } catch (e) { row.error = String(e.message).slice(0, 100); }
      report.arcgisSearch.push(row);
      if (row.matches) console.log('ARCGIS MATCH ' + row.matches + '/' + sampleIds.length + '  ' + row.title + ' | ' + row.owner + ' | ' + row.matchField + ' | ' + row.url);
    }
  } catch (e) { report.arcgisSearch.push({ query: q, error: e.message }); }
}
console.log('arcgis layers checked: ' + report.arcgisSearch.length + ', with matches: ' + report.arcgisSearch.filter((x) => x.matches).length);

/* Queensland's open data catalogue. */
report.qldOpenData = [];
for (const q of ['flood warning gauge', 'river height gauge locations', 'rainfall river gauge network']) {
  try {
    const j = await getJson('https://www.data.qld.gov.au/api/3/action/package_search?rows=12&q=' + encodeURIComponent(q));
    for (const p of ((j.result || {}).results || [])) {
      report.qldOpenData.push({ query: q, title: p.title, org: p.organization && p.organization.title, license: p.license_title,
        resources: (p.resources || []).slice(0, 6).map((r) => ({ name: r.name, format: r.format, url: r.url })) });
    }
  } catch (e) { report.qldOpenData.push({ query: q, error: e.message }); }
}
console.log('qld open data: ' + [...new Set(report.qldOpenData.map((x) => x.title))].slice(0, 20).join(' | '));

rmSync(TMP, { recursive: true, force: true });
writeFileSync('data/gauge-sources-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/gauge-sources-probe.json');
