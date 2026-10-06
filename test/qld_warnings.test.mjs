/* Queensland's public warnings feed, and the additive-source mechanism it
   needed to be reachable at all.

   The live service reported 52 Queensland incidents and not one alert level,
   because the configured feed is ESCAD -- which carries operational state,
   Going and Contained and Patrolled, not an instruction to the public. The
   warnings live in a separate feed carrying WarningLevel.

   Two things had to be true for that feed to help, and both are tested here:

     1. a parser that reads its actual field names. Three of them are in none
        of the shared hint lists, so the generic normaliser finds no title
        and drops every row.
     2. a way to fetch it at all. Incident sources are first-success-wins and
        ESCAD never fails, so a source listed after it is never read. That is
        not a hypothetical -- it is what has been happening to WA's warnings
        feed, which has sat in the config as a fallback behind a source that
        always succeeds.

   The Queensland record asserted below is the real one, read out of
   data/shape-probe.json rather than invented, so this test fails if the
   agency changes its schema instead of passing against a fixture that
   agrees with the parser by construction.

   Run: node test/qld_warnings.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re) => { const m = re.exec(src); if (!m) throw new Error('not found in worker.js: ' + re); return m[0]; };

const parseQldWarnings = new Function([
  grab(/const FIELD_CANDIDATES = \{[\s\S]*?\n\};/),
  grab(/function lowerKeyMap\(obj\) \{[\s\S]*?\n\}/),
  grab(/function pickField\(lowered, kind\) \{[\s\S]*?\n\}/),
  /* pickCoords calls geometryPoint, so it comes along. Leaving it out made
     this test throw ReferenceError rather than fail an assertion -- which is
     at least proof that these tests run the real worker code and not a copy
     of it. */
  grab(/function geometryPoint\(geometry, depth = 0\) \{[\s\S]*?\n\}/),
  grab(/function pickCoords\(record, geometry\) \{[\s\S]*?\n\}/),
  grab(/function normaliseWhen\([\s\S]*?\n\}/),
  grab(/function parseQldWarnings\(json\) \{[\s\S]*?\n\}/)
].join('\n') + '; return parseQldWarnings;')();

/* addMergeSources does network I/O through tryIncidentSource, so that one
   dependency is injected. Everything else is the real code. */
const makeMerge = (responder) => new Function('tryIncidentSource',
  grab(/async function addMergeSources\([\s\S]*?\n\}\n/) + '; return addMergeSources;')(responder);

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

console.log('== the live Queensland record, as the probe captured it ==');
let sample = null;
try {
  sample = JSON.parse(readFileSync(new URL('../data/shape-probe.json', import.meta.url), 'utf8'))
    .feeds.qld.recordArrays[0].firstProperties;
} catch (e) { /* probe output absent; the synthetic cases below still run */ }

if (!sample) {
  console.log('  -- data/shape-probe.json has no Queensland record; skipping live-shape checks');
} else {
  const inc = parseQldWarnings({ features: [{ properties: sample, geometry: null }] }).incidents[0];
  ck('a warning is parsed', !!inc);
  ck('alertLevel is the agency warning level', inc && inc.alertLevel === 'Advice', inc && inc.alertLevel);
  ck('title is the warning headline, not the level', inc && inc.title.length > 20, inc && inc.title);
  ck('type comes from EventType', inc && inc.type === 'Fire', inc && inc.type);
  ck('status is the call to action', inc && inc.status === 'Stay Informed', inc && inc.status);
  ck('coordinates come from the explicit pair', inc && isFinite(inc.lat) && isFinite(inc.lon),
    inc && { lat: inc.lat, lon: inc.lon });
  ck('the timestamp parses to ISO', inc && /^20\d\d-/.test(inc.whenIso || ''), inc && inc.whenIso);
}

console.log('\n== the parser, on its edges ==');
ck('no title means dropped, not a blank row',
  parseQldWarnings({ features: [{ properties: { WarningLevel: 'Advice' } }] }).incidents.length === 0);
ck('WarningArea serves as a title when the headline is absent',
  parseQldWarnings({ features: [{ properties: { WarningArea: 'Near Gympie', WarningLevel: 'Watch and Act' } }] })
    .incidents[0].title === 'Near Gympie');
ck('feature geometry is used when Lat/Long are absent',
  parseQldWarnings({ features: [{ properties: { WarningTitle: 'X' }, geometry: { coordinates: [153, -27.5] } }] })
    .incidents[0].lon === 153);
ck('an empty feed says so rather than looking like a quiet day',
  !!parseQldWarnings({ features: [] }).diagnostics);

console.log('\n== additive sources ==');
const warn = (title, level, lat, lon) => ({ title, alertLevel: level, lat, lon });
const ok = (incidents) => async () => ({ ok: true, parsed: { incidents } });

let attempts = [];
let merge = makeMerge(ok([warn('Fire near Gympie', 'Advice', -26.19, 152.66)]));
let out = await merge([{ url: 'w' }], [warn('Storm damage Brisbane', '', -27.47, 153.02)], attempts);
ck('a merge source adds to the primary list', out.incidents.length === 2, out.incidents.length);
ck('the merged URL is reported', out.urls.length === 1, out.urls);

attempts = [];
merge = makeMerge(ok([warn('Fire near Gympie', 'Advice', -26.191, 152.663)]));
out = await merge([{ url: 'w' }], [warn('Fire near Gympie', '', -26.19, 152.66)], attempts);
ck('the same fire from both feeds is counted once', out.incidents.length === 1, out.incidents);
ck('the duplicate is reported rather than hidden',
  attempts.some((a) => a.duplicates === 1), attempts);

attempts = [];
merge = makeMerge(ok([warn('Fire A', 'Advice', -26, 152), warn('Fire B', 'Emergency Warning', -27, 153)]));
out = await merge([{ url: 'w' }], [warn('Routine job', '', -28, 154)], attempts);
ck('an Emergency Warning sorts to the top of a merged list',
  out.incidents[0].alertLevel === 'Emergency Warning', out.incidents.map((i) => i.alertLevel));
ck('the unwarned incident sorts last',
  out.incidents[out.incidents.length - 1].alertLevel === '', out.incidents.map((i) => i.alertLevel));

attempts = [];
merge = makeMerge(async () => ({ ok: false, error: 'HTTP 500' }));
out = await merge([{ url: 'w' }], [warn('Storm damage', '', -27, 153)], attempts);
ck('a failing merge source never takes down a healthy state',
  out.incidents.length === 1, out.incidents.length);
ck('and the failure is recorded', attempts.some((a) => a.error === 'HTTP 500'), attempts);

attempts = [];
merge = makeMerge(async () => ({ ok: true, parsed: { incidents: [], diagnostics: { envelope: 'x' } } }));
out = await merge([{ url: 'w' }], [warn('Storm damage', '', -27, 153)], attempts);
ck('a merge source whose shape drifted is skipped and noted',
  out.incidents.length === 1 && attempts.some((a) => /no recognisable/.test(a.error || '')), attempts);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
