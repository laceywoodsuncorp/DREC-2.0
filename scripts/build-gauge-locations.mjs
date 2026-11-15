/* Builds data/river-gauge-locations.json: BOM river gauge station number ->
   [lat, lon], for the river map.

   BOM's river height tables give each gauge a station number (in its graph
   link) but no coordinates. Two BOM files on its anonymous FTP service do,
   both keyed by that number, so nothing is matched by name -- an audit
   showed a gauge's name is as often a street or property as a town:

     1. IDM00019, BOM's spatial product of river height observation sites
        (/anon/home/adfd/spatial/IDM00019.dbf): the sites behind the "Latest
        River Heights" tables, with ALT_REF as the station number. Preferred.
     2. BOM's station list (/anon2/home/ncc/metadata/sitelists/alf_All.txt),
        dated 2012: older sites IDM00019 lacks. Only numbers that appear in
        the current river tables are kept, so the file stays small.

   Measured 15 Nov 2026 (scripts/probe-gauge-coords.mjs): 1,698 of 3,578
   gauges placed; where both files place a gauge they agree within 5 km
   except one (Dumaresq River at Bonshaw, 18 km -- IDM00019 is used).
   Newer council-owned ALERT gauges, mostly in Queensland, are in neither;
   the page says so rather than guessing a place for them.

   Site lists change rarely, so this runs monthly, not with every capture.
   Run: node scripts/build-gauge-locations.mjs */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const IDM = 'ftp://ftp.bom.gov.au/anon/home/adfd/spatial/IDM00019.dbf';
const IDM18 = 'ftp://ftp.bom.gov.au/anon/home/adfd/spatial/IDM00018.dbf';
const ALF = 'ftp://ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists/alf_All.txt';
const STATIONS = 'ftp://ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists/stations.zip';
const OUT = 'data/river-gauge-locations.json';
const TMP = 'data/.IDM00019.dbf';

const get = (url, out) => execFileSync('curl', ['-sS', '--max-time', '180', '--connect-timeout', '20', '-A', UA, url,
  ...(out ? ['-o', out] : [])], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });

/* A minimal dBASE III reader: header, field descriptors, fixed-width
   records. Enough for a points table; no memo fields. */
export function readDbf(buf) {
  const n = buf.readUInt32LE(4), hlen = buf.readUInt16LE(8), rlen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; o < hlen - 1 && buf[o] !== 0x0d; o += 32) {
    fields.push({ name: buf.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: buf[o + 16] });
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const start = hlen + i * rlen;
    if (buf[start] === 0x2a) continue; // deleted
    let o = start + 1;
    const row = {};
    for (const f of fields) { row[f.name] = buf.toString('latin1', o, o + f.len).trim(); o += f.len; }
    rows.push(row);
  }
  return rows;
}

/* BOM's fixed-width station list: number, state, district, name (40),
   start, end, lat, lon. */
export function readAlf(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{6})\s+[A-Z]{2,3}\s+\S+\s+.{40}\s+\S+\s+\S+\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
    if (m) out.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  return out;
}

/* BOM's current station list (stations.txt): station number first, then a
   latitude and longitude further along the line. */
export function readStations(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^[\s"]*(\d{5,6})\b.*?(-\d{1,2}\.\d{2,})[\s,"]+(\d{3}\.\d{2,})/.exec(line);
    if (m) out.set(m[1].padStart(6, '0'), [Number(m[2]), Number(m[3])]);
  }
  return out;
}

const stationId = (plot) => ((/\.(\d{5,7})\.plt/.exec(plot || '') || [])[1] || '').padStart(6, '0');
const round = (x) => Math.round(x * 1e4) / 1e4;
const inAustralia = (lat, lon) => lat < -9 && lat > -45 && lon > 110 && lon < 160;

if (import.meta.url === 'file://' + process.argv[1]) {
  const sites = {};
  let fromIdm = 0, fromAlf = 0;
  get(IDM, TMP);
  for (const r of readDbf(readFileSync(TMP))) {
    const id = String(r.ALT_REF || '').replace(/\.0+$/, '');
    const lat = Number(r.LAT), lon = Number(r.LON);
    if (/^\d{4,7}$/.test(id) && inAustralia(lat, lon)) { sites[id.padStart(6, '0')] = [round(lat), round(lon)]; fromIdm++; }
  }
  rmSync(TMP, { force: true });
  /* IDM00018, BOM's flood forecast locations: the same shape, and a few
     gauges IDM00019 lacks. */
  let fromIdm18 = 0;
  try {
    get(IDM18, TMP);
    for (const r of readDbf(readFileSync(TMP))) {
      const id = String(r.ALT_REF || '').replace(/\.0+$/, '').padStart(6, '0');
      const lat = Number(r.LAT), lon = Number(r.LON);
      if (/^\d{6}$/.test(id) && id !== '000000' && !sites[id] && inAustralia(lat, lon)) { sites[id] = [round(lat), round(lon)]; fromIdm18++; }
    }
  } catch (e) { console.log('IDM00018 not read: ' + String(e.message).slice(0, 120)); }
  rmSync(TMP, { force: true });

  /* The older list fills in only gauges that are in the current tables. */
  const current = new Set();
  if (existsSync('data/rivers.json')) {
    const rivers = JSON.parse(readFileSync('data/rivers.json', 'utf8'));
    for (const g of rivers.groups || []) for (const s of g.stations || []) { const id = stationId(s.plot); if (id !== '000000') current.add(id); }
  }
  for (const [id, [lat, lon]] of readAlf(get(ALF))) {
    if (!sites[id] && current.has(id) && inAustralia(lat, lon)) { sites[id] = [round(lat), round(lon)]; fromAlf++; }
  }
  /* BOM's current station list, for the handful the 2012 one lacks. */
  let fromStations = 0;
  try {
    get(STATIONS, 'data/.stations.zip');
    const text = execFileSync('unzip', ['-p', 'data/.stations.zip'], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
    for (const [id, [lat, lon]] of readStations(text)) {
      if (!sites[id] && current.has(id) && inAustralia(lat, lon)) { sites[id] = [round(lat), round(lon)]; fromStations++; }
    }
  } catch (e) { console.log('stations.zip not read: ' + String(e.message).slice(0, 120)); }
  rmSync('data/.stations.zip', { force: true });
  const placed = [...current].filter((id) => sites[id]).length;
  writeFileSync(OUT, JSON.stringify({ builtAt: Date.now(),
    sources: ['BOM IDM00019 river height observation sites (ftp.bom.gov.au/anon/home/adfd/spatial)',
      'BOM station list alf_All.txt (ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists)'],
    counts: { fromIdm00019: fromIdm, fromIdm00018: fromIdm18, fromStationList: fromAlf, fromCurrentStations: fromStations,
      currentGauges: current.size, currentPlaced: placed },
    sites }) + '\n');
  console.log('IDM00019 sites: ' + fromIdm + '; IDM00018: ' + fromIdm18 + '; from the 2012 station list: ' + fromAlf +
    '; from the current station list: ' + fromStations +
    '; current gauges placed: ' + placed + '/' + current.size + '; wrote ' + OUT);
}
