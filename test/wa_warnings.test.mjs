/* Emergency WA's warnings feed, where the alert level is the suffix of a
   slug rather than a field of its own.

   The live service reported 15 Western Australian incidents and not one
   alert level. The configured feed is incident_FCAD.json, which carries no
   level; the warnings are at api.emergency.wa.gov.au/v1/warnings and carry:

     entitySubType  "warnings_bushfire--advice"
     warning-type   "Bushfire Advice"
     title          "MONITOR CONDITIONS - DAMPIER PENINSULA"
     location       { latitude, longitude, value }

   The slug is what gets read, not the prose. "Bushfire Advice" and "Smoke
   Alert" are both warning-types and only the first is a level; telling them
   apart by parsing English would be guesswork, where the slug states it.

   The history is worth keeping in a test, because it is the reason this was
   invisible: api.emergency.wa.gov.au/v1/rss/warnings has been configured as
   a 'partial' fallback behind a source that never fails, so it has never
   once been fetched -- and when finally fetched directly it carries no level
   field at all. A fallback nobody reaches looks exactly like one that works.

   Run: node test/wa_warnings.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re) => { const m = re.exec(src); if (!m) throw new Error('not found: ' + re); return m[0]; };
const parseWa = new Function([
  grab(/const WA_LEVELS = \{[\s\S]*?\n\};/),
  grab(/function geometryPoint\(geometry, depth = 0\) \{[\s\S]*?\n\}/),
  grab(/function normaliseWhen\([\s\S]*?\n\}/),
  grab(/function parseWa\(json\) \{[\s\S]*?\n\}/)
].join('\n') + '; return parseWa;')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const one = (w) => parseWa({ warnings: [w] }).incidents[0];

console.log('== the live record, as the probe captured it ==');
let live = null;
try {
  live = JSON.parse(readFileSync(new URL('../data/shape-probe.json', import.meta.url), 'utf8'))
    .feeds.wa.recordArrays[0].firstRecord;
} catch (e) { /* probe output absent */ }

if (!live) {
  console.log('  -- data/shape-probe.json has no WA record; synthetic cases still run');
} else {
  /* The probe trims nested objects to a shape string, so the one field that
     cannot survive that is rebuilt from the values it printed. */
  const rec = Object.assign({}, live, { location: { latitude: -16.7, longitude: 122.9 } });
  const w = one(rec);
  ck('a warning is parsed', !!w);
  ck('the level comes out of the slug', w && w.alertLevel === 'Advice', w && w.alertLevel);
  ck('the title is the agency headline', w && /DAMPIER PENINSULA/.test(w.title), w && w.title);
  ck('the type is the hazard category', w && w.type === 'Fire', w && w.type);
  ck('the action statement is kept as status', w && /Monitor/i.test(w.status), w && w.status);
  ck('the timestamp parses to ISO', w && /^20\d\d-/.test(w.whenIso || ''), w && w.whenIso);
}

console.log('\n== every level the agency publishes ==');
[['warnings_bushfire--advice', 'Advice'],
 ['warnings_bushfire--watch-and-act', 'Watch and Act'],
 ['warnings_bushfire--emergency-warning', 'Emergency Warning'],
 ['warnings_bushfire--all-clear', 'All Clear']].forEach(([slug, want]) => {
  const w = one({ entitySubType: slug, title: 'T' });
  ck(slug + ' -> ' + want, w && w.alertLevel === want, w && w.alertLevel);
});

console.log('\n== and nothing else becomes a level ==');
/* A real warning-type that is not one of the levels. Promoting it would
   invent an instruction nobody issued, which is the fault this whole set of
   parsers exists to avoid. */
ck('Smoke Alert stays levelless',
  one({ entitySubType: 'warnings_smoke--smoke-alert', 'warning-type': 'Smoke Alert', title: 'T' })
    .alertLevel === '');
ck('an unknown suffix is left blank, not guessed',
  one({ entitySubType: 'warnings_flood--something-new', title: 'T' }).alertLevel === '');
ck('no slug at all is blank', one({ title: 'T' }).alertLevel === '');
ck('icon-name serves as the slug when entitySubType is absent',
  one({ 'icon-name': 'ew-bushfire--watch-and-act', title: 'T' }).alertLevel === 'Watch and Act');

console.log('\n== position ==');
ck('latitude/longitude are read from the location object',
  (one({ title: 'T', location: { latitude: -31.9, longitude: 115.8 } }) || {}).lat === -31.9);
ck('the mapped footprint is the fallback',
  (one({ title: 'T', 'geo-source': { type: 'FeatureCollection',
    features: [{ geometry: { type: 'Polygon', coordinates: [[[115.8, -31.9], [116, -32]]] } }] } }) || {}).lon === 115.8);
ck('no position at all is simply absent, not zero',
  (one({ title: 'T' }) || {}).lat === undefined);

console.log('\n== nothing is invented ==');
ck('a warning with no title is dropped', parseWa({ warnings: [{ entitySubType: 'x--advice' }] }).incidents.length === 0);
ck('an empty feed says so', !!parseWa({ warnings: [] }).diagnostics);
ck('a missing envelope says so', !!parseWa({}).diagnostics);
ck('junk rows are skipped', parseWa({ warnings: [null, 'x', 7] }).incidents.length === 0);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
