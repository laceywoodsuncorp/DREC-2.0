/* collectRecords finds the list of records inside whatever envelope a feed
   uses. It handled four shapes and missed a fifth, and the miss was silent.

   The Northern Territory sends:

     { title, note, lastupdated, incidents: { type, features: [ ... ] } }

   `incidents` is an object, so the longest-array search skipped it. The
   object-values fallback then returned the FeatureCollection itself as one
   record, which has no title and was dropped on the way out. The live
   service reported zero NT incidents from a feed carrying twenty-six, and
   reported ok while doing it -- because an empty list is also what a quiet
   day looks like, which is why this went unnoticed.

   Every envelope is asserted here, not just the new one: the fix inserts a
   branch ahead of two existing ones, and quietly changing which branch a
   feed takes would move the other states' data without anything failing.

   Run: node test/collect_records.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const m = /function collectRecords\(json\) \{[\s\S]*?\n\}/.exec(src);
if (!m) { console.log('FAIL could not find collectRecords in src/worker.js'); process.exit(1); }
const collectRecords = new Function(m[0] + '; return collectRecords;')();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const expect = (name, input, count, envelope) => {
  const r = collectRecords(input);
  check(name, r.records.length === count && r.envelope === envelope,
    { got: { records: r.records.length, envelope: r.envelope }, want: { records: count, envelope } });
  return r;
};

console.log('== the Northern Territory envelope, which was being missed ==');
const nt = {
  title: 'NT incidents', note: 'n', lastupdated: '2026-10-06',
  incidents: { type: 'FeatureCollection', features: [
    { properties: { Title: 'Fire near Katherine', alertLevel: 'Advice' }, geometry: { coordinates: [132, -14] } },
    { properties: { Title: 'Fire near Darwin' } }
  ] }
};
expect('records are found one level down', nt, 2, 'nested-geojson:incidents');
const ntr = collectRecords(nt);
check('properties are unwrapped, not the feature', ntr.records[0].props.Title === 'Fire near Katherine',
  ntr.records[0].props);
check('geometry survives the nested path', !!(ntr.records[0].geometry
  && ntr.records[0].geometry.coordinates), ntr.records[0].geometry);
check('a feature with no geometry is still a record', ntr.records[1].props.Title === 'Fire near Darwin');

console.log('\n== the four envelopes that already worked still take the same branch ==');
expect('a plain FeatureCollection', { type: 'FeatureCollection', features: [{ properties: { a: 1 } }] },
  1, 'geojson');
expect('a bare array', [{ a: 1 }, { b: 2 }], 2, 'array');
expect('an array wrapped under a key', { meta: 1, items: [{ a: 1 }, { b: 2 }, { c: 3 }] },
  3, 'wrapped:items');
/* South Australia keys its incidents by incident number rather than listing
   them, so the values are the records. */
expect('an object whose values are the records', { 101: { a: 1 }, 102: { b: 2 } }, 2, 'object-values');

console.log('\n== precedence, since the new branch sits ahead of two others ==');
/* A top-level FeatureCollection must not be diverted by a nested one. */
expect('top-level features win over a nested collection',
  { type: 'FeatureCollection', features: [{ properties: { a: 1 } }], extra: { features: [{ properties: { b: 2 } }] } },
  1, 'geojson');
/* And the nested match must beat the longest-array guess, which is the
   whole reason it is placed where it is. */
expect('a nested collection wins over the longest-array guess',
  { incidents: { features: [{ properties: { a: 1 } }] }, other: [{ x: 1 }, { x: 2 }, { x: 3 }] },
  1, 'nested-geojson:incidents');

console.log('\n== nothing usable says so, rather than inventing a record ==');
expect('an empty object', {}, 0, 'unrecognised');
expect('a nested empty collection', { incidents: { features: [] } }, 0, 'nested-geojson:incidents');
check('a string is not an envelope', collectRecords('nope').envelope === 'unrecognised');
check('null is not an envelope', collectRecords(null).envelope === 'unrecognised');

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
