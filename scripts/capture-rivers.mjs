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
import { RIVER_HEIGHT_PRODUCTS, buildRiversSnapshot } from './lib/bom-rivers.mjs';

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

const wanted = RIVER_HEIGHT_PRODUCTS.map(([id]) => id + '.html').filter((f) => present.has(f))
  .concat(listing.filter((f) => /^ID[NVQSWTD][23]\d{4}\.xml$/.test(f)));
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

const snap = buildRiversSnapshot(files, Date.now());
const read = snap.products.filter((p) => p.ok).length;
console.log('river height tables read: ' + read + '/' + snap.products.length +
  '; gauges ' + snap.counts.stations + '; flooding: major ' + snap.counts.major + ', moderate ' +
  snap.counts.moderate + ', minor ' + snap.counts.minor + '; warnings ' + snap.warnings.length);
for (const p of snap.products.filter((x) => !x.ok)) console.log('  missing ' + p.id + ' (' + p.state + ' ' + p.region + '): ' + p.error);
if (!read) { console.log('nothing read -- keeping the previous ' + OUT); process.exit(0); }
mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify(snap) + '\n');
console.log('wrote ' + OUT + ' (' + Math.round(JSON.stringify(snap).length / 1024) + ' KB)');
