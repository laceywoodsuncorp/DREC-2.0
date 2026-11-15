/* How many river gauges can be put on a map, from which source, and do the
   sources agree?

   Asked for: the flooding gauges on a map. BOM's river tables carry a
   station number (in each graph link) but no coordinates. Two BOM sources
   have coordinates:

     A. BOM's station list on its anonymous FTP service,
        /anon2/home/ncc/metadata/sitelists/alf_All.txt -- station number,
        name, lat, lon. Matched by number, so no guessing. Dated 2012, and
        it holds BOM site numbers (041499) but not, as far as seen, the
        5xxxxx numbers of ALERT gauges (540568).
     B. "River height observation sites", an ArcGIS layer published by an
        ABOM (Bureau of Meteorology) account: 1,521 sites with name and
        lat/lon, no station number. Matched by exact gauge name only.

   This measures, against the gauges in data/rivers.json: how many each
   places, how many in flood each places, and -- where both place the same
   gauge -- how far apart they put it. A name match that lands far from
   the number match is a name match that cannot be trusted. It also reads
   the ArcGIS item's own licence and description.

   Run: node scripts/probe-gauge-coords.mjs   (writes data/gauge-coords-probe.json) */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const ALF = 'ftp://ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists/alf_All.txt';
const LAYER = 'https://services8.arcgis.com/eJi5Ccfp64bqr5ym/arcgis/rest/services/River_height_observation_sites/FeatureServer/0';
const ITEM = 'https://www.arcgis.com/sharing/rest/content/items/0cb4dad26dc946d8a8c30613adf4ee07?f=json';
const report = { at: new Date().toISOString() };

const rivers = JSON.parse(readFileSync('data/rivers.json', 'utf8'));
const gauges = [];
for (const g of rivers.groups) for (const s of g.stations) {
  const id = s.plot ? (/\.(\d{5,7})\.plt/.exec(s.plot) || [])[1] : undefined;
  gauges.push({ state: g.state, catchment: g.catchment, name: s.name, id, level: s.level });
}
report.gauges = gauges.length;
report.withId = gauges.filter((g) => g.id).length;

/* A. BOM's station list. Fixed-width; parsed by its header's columns. */
const alf = execFileSync('curl', ['-sS', '--max-time', '120', '-A', UA, ALF], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
const byId = new Map();
for (const line of alf.split(/\r?\n/)) {
  const m = /^\s*(\d{6})\s+([A-Z]{2,3})\s+\S+\s+(.{40})\s+(\S+)\s+(\S+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
  if (m) byId.set(m[1], { name: m[3].trim(), state: m[2], start: m[4], end: m[5], lat: Number(m[6]), lon: Number(m[7]) });
}
report.alfRows = byId.size;

/* B. The ArcGIS layer, all of it (two pages at most), and its item page. */
const feats = [];
for (let off = 0; off < 5000; off += 1000) {
  const r = await fetch(LAYER + '/query?f=json&where=1%3D1&outFields=*&outSR=4326&returnGeometry=false&resultRecordCount=1000&resultOffset=' + off,
    { headers: { 'User-Agent': UA } });
  const j = await r.json();
  feats.push(...(j.features || []).map((f) => f.attributes));
  if (!j.exceededTransferLimit) break;
}
report.layerRows = feats.length;
report.layerSample = feats.slice(0, 5);
try {
  const it = await (await fetch(ITEM, { headers: { 'User-Agent': UA } })).json();
  report.item = { title: it.title, owner: it.owner, created: it.created && new Date(it.created).toISOString(),
    modified: it.modified && new Date(it.modified).toISOString(), access: it.access, licenseInfo: it.licenseInfo,
    accessInformation: it.accessInformation, description: it.description, snippet: it.snippet, tags: it.tags };
} catch (e) { report.item = { error: e.message }; }
/* C. The same layer as a BOM product: its description names it IDM00019,
   and BOM publishes IDM spatial products on its FTP service. If a copy is
   there, it is BOM's own and possibly newer than the 2022 layer. */
const SPATIAL = 'ftp://ftp.bom.gov.au/anon/home/adfd/spatial/';
const C = new Map();
try {
  const list = execFileSync('curl', ['-sS', '--max-time', '60', '-A', UA, '--list-only', SPATIAL], { encoding: 'utf8' })
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  report.spatialFiles = list.filter((f) => /IDM000(1|2)/.test(f));
  const f19 = list.find((f) => /^IDM00019.*\.zip$/i.test(f));
  if (f19) {
    execFileSync('curl', ['-sS', '--max-time', '120', '-A', UA, SPATIAL + f19, '-o', 'data/.idm00019.zip']);
    execFileSync('rm', ['-rf', 'data/.idm00019']);
    execFileSync('unzip', ['-o', '-q', 'data/.idm00019.zip', '-d', 'data/.idm00019']);
    const members = execFileSync('find', ['data/.idm00019', '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    report.idm00019 = { file: f19, members };
    const dbf = members.find((m) => /\.dbf$/i.test(m));
    if (dbf) {
      /* A minimal dBASE reader: header, field descriptors, fixed records. */
      const b = readFileSync(dbf);
      const n = b.readUInt32LE(4), hlen = b.readUInt16LE(8), rlen = b.readUInt16LE(10);
      const fields = [];
      for (let o = 32; b[o] !== 0x0d && o < hlen; o += 32) {
        fields.push({ name: b.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: b[o + 16] });
      }
      report.idm00019.fields = fields.map((f) => f.name);
      report.idm00019.rows = n;
      for (let i = 0; i < n; i++) {
        let o = hlen + i * rlen + 1;
        const row = {};
        for (const f of fields) { row[f.name] = b.toString('latin1', o, o + f.len).trim(); o += f.len; }
        if (i < 3) (report.idm00019.sample = report.idm00019.sample || []).push(row);
        const id = String(row.ALT_REF || row.STN_NUM || row.BOM_ID || '').replace(/\.0+$/, '');
        const lat = Number(row.LAT || row.LATITUDE), lon = Number(row.LON || row.LONGITUDE);
        if (id && isFinite(lat) && isFinite(lon)) C.set(id.padStart(6, '0'), { lat, lon, name: row.PT_NAME });
      }
    }
  }
} catch (e) { report.idm00019 = { error: String(e.message).slice(0, 200) }; }
report.idm00019Placed = C.size;

/* B by number: the layer's ALT_REF is a BOM station number. */
const byRef = new Map();
for (const f of feats) if (f.ALT_REF) byRef.set(String(f.ALT_REF).padStart(6, '0'), { lat: Number(f.LAT), lon: Number(f.LON), name: f.PT_NAME });

const norm = (s) => String(s || '').toUpperCase().replace(/\bCK\b/g, 'CREEK').replace(/\bR\b/g, 'RIVER').replace(/[^A-Z0-9]+/g, ' ').trim();
const byName = new Map();
for (const f of feats) {
  for (const k of [f.PT_NAME, f.DESCRIPTN]) {
    const n = norm(k);
    if (n) (byName.get(n) || byName.set(n, []).get(n)).push(f);
  }
}

const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));
let A = 0, B = 0, either = 0, both = 0, floodA = 0, floodB = 0, floodEither = 0, flooding = 0;
let R = 0, Cn = 0, any = 0, floodR = 0, floodC = 0, floodAny = 0;
const unplacedAny = [], refDisagree = [];
const disagree = [], unplacedFlooding = [], ambiguousB = [];
for (const g of gauges) {
  const a = g.id && byId.get(g.id.padStart(6, '0'));
  const cands = byName.get(norm(g.name)) || [];
  const sameState = cands.filter((f) => !f.STATE_CODE || String(f.STATE_CODE).toUpperCase().includes(g.state));
  if (sameState.length > 1) ambiguousB.push(g.name);
  const b = sameState.length === 1 ? { lat: Number(sameState[0].LAT), lon: Number(sameState[0].LON) } : null;
  if (a) A++;
  if (b) B++;
  if (a || b) either++;
  if (a && b) { both++; const d = km(a, b); if (d > 5) disagree.push({ name: g.name, id: g.id, km: Math.round(d), alf: a, layer: b }); }
  const id6 = g.id && g.id.padStart(6, '0');
  const r = id6 && byRef.get(id6);
  const c = id6 && C.get(id6);
  if (r) R++;
  if (c) Cn++;
  if (r || c || a) any++;
  if (r && a && km(r, a) > 5) refDisagree.push(g.name + ' ' + Math.round(km(r, a)) + 'km');
  if (g.level) {
    if (r) floodR++;
    if (c) floodC++;
    if (r || c || a) floodAny++; else unplacedAny.push(g.name + ' (' + g.id + ')');
    flooding++;
    if (a) floodA++;
    if (b) floodB++;
    if (a || b) floodEither++; else unplacedFlooding.push(g.name + ' (' + g.id + ')');
  }
}
Object.assign(report, { placedByStationList: A, placedByLayerName: B, placedByEither: either, placedByBoth: both,
  disagreeOver5km: disagree.length, disagreeSample: disagree.slice(0, 25), ambiguousNames: ambiguousB.length,
  flooding, floodingPlacedByList: floodA, floodingPlacedByLayer: floodB, floodingPlacedByEither: floodEither,
  floodingUnplaced: unplacedFlooding,
  placedByLayerRef: R, placedByIdm00019: Cn, placedByAnyNumber: any, refVsListDisagreeOver5km: refDisagree.length,
  refDisagreeSample: refDisagree.slice(0, 15),
  floodingPlacedByLayerRef: floodR, floodingPlacedByIdm00019: floodC, floodingPlacedByAnyNumber: floodAny,
  floodingUnplacedByNumber: unplacedAny });
console.log(JSON.stringify(Object.fromEntries(Object.entries(report).filter(([k]) => !/sample|item|Unplaced/i.test(k))), null, 1));
console.log('item:', JSON.stringify(report.item).slice(0, 1500));
console.log('flooding unplaced:', unplacedFlooding.join('; '));
console.log('disagreements:', disagree.slice(0, 10).map((d) => d.name + ' ' + d.km + 'km').join('; '));
writeFileSync('data/gauge-coords-probe.json', JSON.stringify(report, null, 1) + '\n');
