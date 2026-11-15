/* Captures flooded-road reports from the state road authorities into
   data/road-flooding.json.

   Runs beside the river capture, on the same schedule, so the flooding
   section's two tabs are as old as each other. See
   scripts/lib/road-floods.mjs for the sources, their licences and how a
   report's severity is read.

   Each source is asked once, all at the same time. One that needs a key
   and has none is recorded as needing one; one that fails is recorded as
   failed -- neither is written as "no flooded roads". A key comes only
   from the environment (a GitHub Actions secret), and neither it nor a
   URL carrying it is ever printed. If nothing at all could be read the
   previous file is kept.

   Run: node scripts/capture-roads.mjs */
import { writeFileSync, mkdirSync } from 'node:fs';
import { ROAD_SOURCES, buildRoadSnapshot } from './lib/road-floods.mjs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const OUT = 'data/road-flooding.json';

async function read(source) {
  let url = source.url;
  if (source.keyEnv) {
    const key = process.env[source.keyEnv];
    if (!key) return { needsKey: true };
    url += (url.includes('?') ? '&' : '?') + source.keyParam + '=' + encodeURIComponent(key);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, application/geo+json' },
      signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const body = await res.text();
    try { return { json: JSON.parse(body) }; }
    catch (e) { return { error: 'answered, but not with JSON' }; }
  } catch (e) {
    /* The message only -- never the URL, which may carry a key. */
    return { error: e.name === 'AbortError' ? 'timed out after 20s' : 'could not be reached' };
  } finally { clearTimeout(timer); }
}

const results = {};
await Promise.all(ROAD_SOURCES.map(async (s) => { results[s.state] = await read(s); }));
const snap = buildRoadSnapshot(results, Date.now());
for (const s of snap.sources) {
  console.log(s.state.padEnd(4) + (s.ok ? 'ok   ' + String(s.count).padStart(4) + ' flooded-road reports from ' + s.read + ' records'
    : s.needsKey ? 'needs a key (not configured)' : 'FAILED ' + s.error) + '  -- ' + s.name);
}
/* What the NT feed calls its obstruction types: its flood wording was not
   on show when the parser was written, so the log keeps it visible. */
const nt = results.NT && results.NT.json && results.NT.json.response;
if (Array.isArray(nt)) {
  const c = {};
  nt.forEach((o) => { const k = String(o.obstructionType).slice(0, 40) + ' / ' + o.restrictionType; c[k] = (c[k] || 0) + 1; });
  console.log('NT types: ' + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => k + ' x' + n).join('; '));
}
console.log('flooded roads: ' + snap.counts.closed + ' closed, ' + snap.counts.restricted + ' restricted, ' + snap.counts.caution + ' caution');
if (!snap.sources.some((s) => s.ok)) { console.log('no source could be read -- keeping the previous ' + OUT); process.exit(0); }
mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify(snap) + '\n');
console.log('wrote ' + OUT + ' (' + Math.round(JSON.stringify(snap).length / 1024) + ' KB)');
