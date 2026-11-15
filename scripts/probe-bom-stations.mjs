/* Where does BOM publish the locations of its river gauges?

   Asked for: the flooding gauges on a map. BOM's river height tables
   carry no coordinates, only a station number in each gauge's graph link
   (IDQ65389.540568 -- Blackfellow Creek at Junction View). Placing gauges
   by the place name in their title is not an option: an audit showed the
   word after "at" is as often a street or property as a town.

   This looks through BOM's anonymous FTP service -- the channel BOM
   directs automated users to -- for a file that maps those station
   numbers to a latitude and longitude:
     - the per-state .hcs files in /anon/gen/fwo/ (newest of each kind)
     - the .tgz bundles there (contents listed, text members sampled)
     - the river observation XML (IDx60920 is weather; others checked)
     - BOM's station site lists in /anon/home/ncc/metadata/sitelists/
   Every text found is searched for the station numbers of a handful of
   known gauges, and the hits are reported with the lines around them.

   Run: node scripts/probe-bom-stations.mjs   (writes data/bom-stations-probe.json) */
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const FWO = 'ftp://ftp.bom.gov.au/anon/gen/fwo/';
const SITELISTS = 'ftp://ftp.bom.gov.au/anon/home/ncc/metadata/sitelists/';
const TMP = 'data/.bom-stations';
/* Station numbers from graph links in data/rivers.json, with names to
   recognise them by. */
const KNOWN = { '540568': 'Blackfellow Creek at Junction View', '041499': 'Condamine River at Tummaville',
  '558018': 'Tweed River at Palmers Road', '540143': 'Lockyer Creek at Helidon', '058167': 'Tweed River at Uki' };

const curl = (args, max = 120) => {
  try { return execFileSync('curl', ['-sS', '--max-time', String(max), '--connect-timeout', '20', '-A', UA, ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { return { error: String(e.stderr || e.message).slice(0, 300) }; }
};
const report = { at: new Date().toISOString(), files: {}, sitelists: null, hits: [] };
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const listing = curl(['--list-only', FWO], 60);
if (typeof listing !== 'string') { console.log('listing failed', listing.error); process.exit(0); }
const names = listing.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/* Newest file of each .hcs stem, every .tgz, and the series-6 XML that is
   not the weather observations. Queensland and NSW only for the .hcs --
   the known gauges are there -- to keep the download small. */
const newest = {};
for (const n of names.filter((x) => /^ID[QN]659\d\d.*\.hcs$/.test(x))) {
  const stem = n.slice(0, 8);
  if (!newest[stem] || n > newest[stem]) newest[stem] = n;
}
const want = [...Object.values(newest), ...names.filter((x) => /\.tgz$/.test(x) && /^ID[QN]/.test(x)),
  ...names.filter((x) => /^ID[NQ]6\d{4}\.xml$/.test(x) && !/60920/.test(x))];
const args = ['--parallel', '--parallel-max', '3'];
for (const f of want) args.push(FWO + f, '-o', TMP + '/' + f);
curl(args, 300);

const texts = {};
for (const f of want) {
  const p = TMP + '/' + f;
  let size = 0;
  try { size = statSync(p).size; } catch (e) { report.files[f] = { error: 'not downloaded' }; continue; }
  const entry = { bytes: size };
  if (/\.tgz$/.test(f)) {
    try {
      const list = execFileSync('tar', ['-tzf', p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
      entry.members = list.length; entry.sample = list.slice(0, 15);
      const dir = TMP + '/' + f + '.d';
      mkdirSync(dir, { recursive: true });
      execFileSync('tar', ['-xzf', p, '-C', dir]);
      /* Text members only, a few, so the search below can read them. */
      for (const m of list.filter((x) => /\.(txt|csv|xml|json|kml|dat)$/i.test(x)).slice(0, 20)) {
        try { texts[f + ':' + m] = readFileSync(dir + '/' + m, 'utf8'); } catch (e) { /* skip */ }
      }
    } catch (e) { entry.error = 'tar: ' + String(e.message).slice(0, 120); }
  } else {
    const t = readFileSync(p, 'utf8');
    texts[f] = t;
    entry.head = t.slice(0, 1500);
  }
  report.files[f] = entry;
  console.log(f.padEnd(34) + String(size).padStart(10) + 'B' + (entry.members ? '  ' + entry.members + ' members' : ''));
}

/* BOM's site lists: listed, and the small ones read. */
const sl = curl(['--list-only', SITELISTS], 60);
if (typeof sl === 'string') {
  const files = sl.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  report.sitelists = { files };
  console.log('sitelists: ' + files.join(', '));
  for (const f of files.filter((x) => /\.(txt|csv)$/i.test(x)).slice(0, 6)) {
    const t = curl([SITELISTS + f], 120);
    if (typeof t === 'string') { texts['sitelists:' + f] = t; report.files['sitelists:' + f] = { bytes: t.length, head: t.slice(0, 1500) }; }
  }
  for (const f of files.filter((x) => /\.zip$/i.test(x)).slice(0, 2)) {
    const out = TMP + '/' + f;
    curl([SITELISTS + f, '-o', out], 180);
    try {
      const dir = out + '.d';
      mkdirSync(dir, { recursive: true });
      execFileSync('unzip', ['-o', '-q', out, '-d', dir]);
      for (const m of readdirSync(dir)) {
        const t = readFileSync(dir + '/' + m, 'utf8');
        texts['sitelists:' + f + ':' + m] = t;
        report.files['sitelists:' + f + ':' + m] = { bytes: t.length, head: t.slice(0, 1500) };
      }
    } catch (e) { report.files['sitelists:' + f] = { error: String(e.message).slice(0, 160) }; }
  }
} else report.sitelists = sl;

/* Where do the known station numbers appear, and with what around them? */
for (const [src, t] of Object.entries(texts)) {
  const lines = t.split(/\r?\n/);
  for (const [id, label] of Object.entries(KNOWN)) {
    const i = lines.findIndex((l) => l.includes(id));
    if (i < 0) continue;
    report.hits.push({ source: src, id, label, line: i + 1,
      context: lines.slice(Math.max(0, i - 2), i + 3).join('\n').slice(0, 800) });
  }
}
console.log('\nhits for known station numbers:');
for (const h of report.hits) console.log('  ' + h.source + '  ' + h.id + ' (' + h.label + ')  line ' + h.line + '\n    ' + h.context.replace(/\n/g, '\n    ').slice(0, 400));
rmSync(TMP, { recursive: true, force: true });
mkdirSync('data', { recursive: true });
writeFileSync('data/bom-stations-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/bom-stations-probe.json');
