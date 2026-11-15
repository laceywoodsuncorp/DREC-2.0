/* Captures BOM river heights and flood warnings into data/rivers.json.

   Runs beside the outage capture, on the same schedule. A Cloudflare
   Worker cannot speak FTP, and FTP is the channel BOM directs automated
   users to, so this runs in Actions and the page reads the file it writes
   as a static asset. See scripts/lib/bom-rivers.mjs for what is read and
   on what terms.

   One directory listing, then every river height table and every warning
   XML in series 2/3 -- about ninety small files, three connections at a
   time. A capture that reads nothing leaves the previous file in place
   rather than replacing it with an empty one; the page shows its age.

   Run: node scripts/capture-rivers.mjs */
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RIVER_HEIGHT_PRODUCTS, buildRiversSnapshot, parseLatestReadings } from './lib/bom-rivers.mjs';
import { placeApproximately } from './lib/gauge-approx.mjs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const FTP = 'ftp://ftp.bom.gov.au/anon/gen/fwo/';
const OUT = 'data/rivers.json';
const TMP = 'data/.rivers-tmp';

const curl = (args, max) => execFileSync('curl', ['-sS', '--max-time', String(max), '--connect-timeout', '20', '-A', UA, ...args],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

let listing;
try { listing = curl(['--list-only', FTP], 60).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
catch (e) { console.log('FTP listing failed: ' + String(e.stderr || e.message).slice(0, 200)); process.exit(0); }
const present = new Set(listing);

/* The newest 15-minute observation file per state (IDx65910_<time>.hcs):
   the gauges' readings since the hourly tables were issued. */
const newestObs = {};
for (const f of listing.filter((x) => /^ID[NVQSWTD]65910_\d{14}\.hcs$/.test(x))) {
  if (!newestObs[f[2]] || f > newestObs[f[2]]) newestObs[f[2]] = f;
}
const wanted = RIVER_HEIGHT_PRODUCTS.map(([id]) => id + '.html').filter((f) => present.has(f))
  .concat(listing.filter((f) => /^ID[NVQSWTD][23]\d{4}\.xml$/.test(f)))
  .concat(Object.values(newestObs));
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
/* Three connections at once. One after another, ninety files would risk
   pushing the capture job past a minute, and Actions bills each run
   rounded up to the minute. Three is still a light load on BOM's server.
   The time taken is logged, so the budget can be checked against it. */
const args = ['--parallel', '--parallel-max', '3'];
for (const f of wanted) args.push(FTP + f, '-o', TMP + '/' + f);
const t0 = Date.now();
try { curl(args, 180); } catch (e) { console.log('some downloads failed: ' + String(e.stderr || e.message).slice(0, 300)); }

console.log('fetched ' + wanted.length + ' files in ' + Math.round((Date.now() - t0) / 1000) + 's');
const files = {};
for (const f of wanted) {
  if (existsSync(TMP + '/' + f)) files[f] = readFileSync(TMP + '/' + f, 'utf8');
}
rmSync(TMP, { recursive: true, force: true });

/* Where each gauge is, from BOM's site files (built monthly by
   scripts/build-gauge-locations.mjs). Without it the list still works; the
   map just has nothing to plot. */
let locations = {};
try { locations = JSON.parse(readFileSync('data/river-gauge-locations.json', 'utf8')).sites || {}; }
catch (e) { console.log('no gauge locations file -- gauges will not be placed on the map'); }
const latest = new Map();
for (const f of Object.values(newestObs)) {
  if (!files[f]) continue;
  for (const [id, r] of parseLatestReadings(files[f])) latest.set(id, r);
  delete files[f];
}
const snap = buildRiversSnapshot(files, Date.now(), locations, latest);
/* Gauges no published file locates are placed approximately -- from the
   town in their name or between their neighbours -- and marked as such.
   See scripts/lib/gauge-approx.mjs for the rules and measured accuracy. */
const exact = snap.groups.reduce((n, g) => n + g.stations.filter((x) => x.at).length, 0);
let approx = { town: 0, neighbour: 0, none: snap.counts.stations - exact };
try {
  approx = placeApproximately(snap.groups, JSON.parse(readFileSync('data/gazetteer.json', 'utf8')).items);
} catch (e) { console.log('approximate placement skipped: ' + String(e.message).slice(0, 120)); }
snap.counts.placed = { exact, town: approx.town, neighbour: approx.neighbour, none: approx.none };
const read = snap.products.filter((p) => p.ok).length;
console.log('river height tables read: ' + read + '/' + snap.products.length +
  '; gauges ' + snap.counts.stations + '; flooding: major ' + snap.counts.major + ', moderate ' +
  snap.counts.moderate + ', minor ' + snap.counts.minor + '; warnings ' + snap.warnings.length +
  '; on the map: ' + exact + ' exact, ' + approx.town + ' from their town, ' + approx.neighbour +
  ' between neighbours, ' + approx.none + ' not placed' +
  '; newer than their table ' + snap.counts.newerThanTable + ' (from ' + Object.keys(newestObs).length + ' observation files)');
for (const p of snap.products.filter((x) => !x.ok)) console.log('  missing ' + p.id + ' (' + p.state + ' ' + p.region + '): ' + p.error);
if (!read) { console.log('nothing read -- keeping the previous ' + OUT); process.exit(0); }
mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify(snap) + '\n');
console.log('wrote ' + OUT + ' (' + Math.round(JSON.stringify(snap).length / 1024) + ' KB)');
