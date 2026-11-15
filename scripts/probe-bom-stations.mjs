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

/* First pass (15 Nov 2026), kept here as its finding: the flood directory
   has no coordinates. Its .hcs files are the gauges' raw readings keyed by
   the same station numbers (IndexNo, SensorType, SiteId, time, value...),
   its .tgz bundles are weather observations and forecast pages, and
   /anon/home/ncc/metadata/sitelists/ answers "permission denied".

   Second pass: BOM's station list at its other published path, and public
   ArcGIS layers of flood gauges. */
const texts = {};
const SITELISTS2 = 'ftp://ftp.bom.gov.au/anon2/home/ncc/metadata/sitelists/';
const sl = curl(['--list-only', SITELISTS2], 60);
report.sitelists = typeof sl === 'string' ? { files: sl.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) } : sl;
console.log('anon2 sitelists: ' + JSON.stringify(report.sitelists).slice(0, 300));
if (typeof sl === 'string') {
  for (const f of report.sitelists.files.filter((x) => /\.(zip|txt|csv)$/i.test(x)).slice(0, 4)) {
    const out = TMP + '/' + f;
    curl([SITELISTS2 + f, '-o', out], 180);
    try {
      if (/\.zip$/i.test(f)) {
        const dir = out + '.d';
        mkdirSync(dir, { recursive: true });
        execFileSync('unzip', ['-o', '-q', out, '-d', dir]);
        for (const m of readdirSync(dir)) {
          const t = readFileSync(dir + '/' + m, 'latin1');
          texts['anon2:' + f + ':' + m] = t;
          report.files['anon2:' + f + ':' + m] = { bytes: t.length, head: t.slice(0, 1500) };
          console.log('  ' + f + ':' + m + ' ' + t.length + 'B');
        }
      } else {
        const t = readFileSync(out, 'latin1');
        texts['anon2:' + f] = t;
        report.files['anon2:' + f] = { bytes: t.length, head: t.slice(0, 1500) };
        console.log('  ' + f + ' ' + t.length + 'B');
      }
    } catch (e) { report.files['anon2:' + f] = { error: String(e.message).slice(0, 160) }; }
  }
}

/* Public ArcGIS layers of flood or river gauges. The search API is
   anonymous; what is recorded is each candidate's title, owner, URL and
   the fields of its first layer, so a match on BOM station numbers can be
   judged before anything is built on it. */
report.arcgis = [];
const Q = '(title:"flood gauge" OR title:"flood gauges" OR title:"river gauge" OR title:"river height" OR title:"flood warning" OR title:"stream gauge") AND type:"Feature Service"';
try {
  const res = await fetch('https://www.arcgis.com/sharing/rest/search?f=json&num=60&q=' + encodeURIComponent(Q), { headers: { 'User-Agent': UA } });
  const j = await res.json();
  for (const it of (j.results || [])) {
    const row = { title: it.title, owner: it.owner, url: it.url, id: it.id, modified: it.modified && new Date(it.modified).toISOString() };
    if (it.url) {
      try {
        const r0 = await fetch(it.url.replace(/\/?$/, '') + '/0?f=json', { headers: { 'User-Agent': UA } });
        const l0 = await r0.json();
        row.fields = (l0.fields || []).map((x) => x.name).slice(0, 40);
        row.geometryType = l0.geometryType;
        /* Does any station-ish field hold a known BOM number? */
        const idField = (l0.fields || []).map((x) => x.name).find((n) => /station|site|gauge|bom|awrc|id/i.test(n) && !/objectid|fid/i.test(n));
        if (idField) {
          const where = encodeURIComponent(idField + " IN ('540568','041499','558018','058167','540143')");
          const r1 = await fetch(it.url.replace(/\/?$/, '') + '/0/query?f=json&outFields=*&returnGeometry=true&outSR=4326&where=' + where, { headers: { 'User-Agent': UA } });
          const q1 = await r1.json();
          row.idField = idField;
          row.matches = (q1.features || []).length;
          row.sample = (q1.features || []).slice(0, 2);
          row.queryError = q1.error && q1.error.message;
        }
        const rc = await fetch(it.url.replace(/\/?$/, '') + '/0/query?f=json&where=1%3D1&returnCountOnly=true', { headers: { 'User-Agent': UA } });
        row.count = (await rc.json()).count;
      } catch (e) { row.error = String(e.message).slice(0, 120); }
    }
    report.arcgis.push(row);
    console.log('arcgis: ' + (row.matches ? 'MATCH ' + row.matches + ' ' : '') + row.title + ' | ' + row.owner + ' | ' + row.count + ' features | ' + (row.idField || '') + ' | ' + row.url);
  }
} catch (e) { report.arcgis = { error: e.message }; }

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
