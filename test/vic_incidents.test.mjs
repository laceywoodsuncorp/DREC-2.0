/* VicEmergency puts three kinds of record in one feed and tells them apart
   with `feedType`. The same key means different things in each, and reading
   it as one field produced three separate faults on the live dashboard.

     1. Invented alert levels. category1 is the alert level only for a
        warning; for an incident it is the event type. The live service was
        reporting Earthquake, Tree Down, Building Damage and
        Accident / Rescue as Victoria's alert levels. None is a warning any
        agency issued.

     2. Rows titled "Advice". For a warning, `name` is literally the level,
        and `name` outranks `location` in the shared title hints -- so the
        row read "Advice" and "Barwon River downstream of Inverleigh" was
        thrown away.

     3. No coordinates at all. Victoria's features carry a
        GeometryCollection, which has no `coordinates` of its own, so
        pickCoords fell through to lat/lon columns VicEmergency does not
        publish. Every Victorian incident was unplaceable, which on a map
        reads as Victoria having nothing happening.

   The samples below are the real records captured from the live feed into
   data/shape-probe.json, one per feedType.

   Run: node test/vic_incidents.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re) => { const m = re.exec(src); if (!m) throw new Error('not found: ' + re); return m[0]; };
const build = (name) => new Function([
  grab(/const FIELD_CANDIDATES = \{[\s\S]*?\n\};/),
  grab(/function lowerKeyMap\(obj\) \{[\s\S]*?\n\}/),
  grab(/function pickField\(lowered, kind\) \{[\s\S]*?\n\}/),
  grab(/function geometryPoint\(geometry, depth = 0\) \{[\s\S]*?\n\}/),
  grab(/function pickCoords\(record, geometry\) \{[\s\S]*?\n\}/),
  grab(/function normaliseWhen\([\s\S]*?\n\}/),
  grab(/function parseVic\(json\) \{[\s\S]*?\n\}/)
].join('\n') + '; return ' + name + ';')();
const parseVic = build('parseVic');
const geometryPoint = build('geometryPoint');

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const one = (props, geometry) => parseVic({ features: [{ properties: props, geometry }] }).incidents[0];

let samples = {};
try {
  samples = JSON.parse(readFileSync(new URL('../data/shape-probe.json', import.meta.url), 'utf8'))
    .vicByFeedType || {};
} catch (e) { /* probe output absent */ }

console.log('== a warning: category1 IS the level, and the place is elsewhere ==');
const warnProps = (samples.warning && samples.warning.sample) || {
  feedType: 'warning', category1: 'Advice', category2: 'Met', name: 'Advice',
  sourceTitle: 'Advice', location: 'Barwon River downstream of Inverleigh',
  status: 'Minor', updated: '2026-10-05T13:44:34+11:00'
};
const w = one(warnProps);
ck('the level is read', w && w.alertLevel === 'Advice', w && w.alertLevel);
ck('the title is the place, not the level', w && /Barwon River/.test(w.title), w && w.title);
ck('the title is never just the level', w && w.title.toLowerCase() !== 'advice', w && w.title);
ck('status stays separate from the level', w && w.status === 'Minor', w && w.status);

console.log('\n== an incident: category1 is a TYPE and must not become a level ==');
const incProps = (samples.incident && samples.incident.sample) || {
  feedType: 'incident', category1: 'Fire', category2: 'Bushfire',
  sourceTitle: 'Seacombe - Longford-Loch Sport Rd', status: 'Under Control',
  location: '4.1Km Nw Of Paradise Beach', updated: '2026-10-05T02:08:47Z'
};
const i = one(incProps);
ck('no level is invented', i && i.alertLevel === '', i && i.alertLevel);
ck('the title is the real label', i && /Seacombe|Paradise/.test(i.title), i && i.title);
ck('the type is kept', i && /Fire|Bushfire/i.test(i.type), i && i.type);

console.log('\n== an earthquake: also a type, also not a level ==');
const eqProps = (samples.earthquake && samples.earthquake.sample) || {
  feedType: 'earthquake', category1: 'Earthquake', category2: 'Earthquake',
  name: 'Magnitude 2.3 MLa075 - 15 km NW of Leongatha, VIC',
  sourceTitle: 'Magnitude 2.3 MLa075 earthquake - 15 km NW of Leongatha, VIC',
  location: '15 km NW of Leongatha, VIC', status: 'Minor'
};
const q = one(eqProps);
ck('"Earthquake" is not reported as an alert level', q && q.alertLevel === '', q && q.alertLevel);
ck('the magnitude and place survive as the title', q && /Leongatha/.test(q.title), q && q.title);

console.log('\n== the specific wrong values the live service was reporting ==');
['Tree Down', 'Building Damage', 'Accident / Rescue', 'Hazardous Material', 'Other', 'Met']
  .forEach((bad) => {
    const r = one({ feedType: 'incident', category1: bad, sourceTitle: 'Somewhere' });
    ck('"' + bad + '" is not an alert level', r && r.alertLevel === '', r && r.alertLevel);
  });

console.log('\n== GeometryCollection, which left Victoria unplaceable ==');
ck('a collection yields its first point',
  JSON.stringify(geometryPoint({ type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [144.5, -38.1] }] })) === '{"lon":144.5,"lat":-38.1}',
  geometryPoint({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [144.5, -38.1] }] }));
ck('a collection skips a member with no usable point',
  !!geometryPoint({ geometries: [{ coordinates: [] }, { coordinates: [145, -37] }] }));
ck('a polygon reduces to its first vertex',
  !!geometryPoint({ type: 'Polygon', coordinates: [[[145, -37], [146, -38]]] }));
ck('a plain point still works',
  JSON.stringify(geometryPoint({ type: 'Point', coordinates: [150, -33] })) === '{"lon":150,"lat":-33}');
ck('nothing usable returns null, not a guess', geometryPoint({ type: 'Point', coordinates: ['a', 'b'] }) === null);
ck('an empty collection returns null', geometryPoint({ geometries: [] }) === null);
ck('a VIC feature gets a position end to end',
  !!(one(warnProps, { type: 'GeometryCollection', geometries: [{ coordinates: [144.1, -38.2] }] }) || {}).lat);

console.log('\n== nothing is invented ==');
ck('a record with no usable title is dropped',
  parseVic({ features: [{ properties: { feedType: 'warning', category1: 'Advice', name: 'Advice' } }] })
    .incidents.length === 0);
ck('an empty feed says so', !!parseVic({ features: [] }).diagnostics);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
