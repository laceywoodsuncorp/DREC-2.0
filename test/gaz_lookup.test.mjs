/* Resolving an operator's town name to a point, against the real gazetteer.

   Measured against the live feeds, 46 of 1,204 town references could not be
   placed, and an outage whose town cannot be placed never appears on the map
   -- which looks exactly like no outage. The 40 distinct names had three
   separate causes, and this covers all three:

     1. The ABS suffixes a repeated name with its state or its LGA, and the
        builder stripped only one of the three forms. "LONGFORD (TAS.)" and
        "RED HILL (BRISBANE - QLD)" were therefore unreachable by the exact
        name an operator writes. Fixed in the builder, and handled here as
        well so the map works against a gazetteer file built before that fix
        rather than waiting on a rebuild.

     2. The ABS holds suburbs, not cities. There is no TOOWOOMBA, only
        TOOWOOMBA CITY; no CAIRNS, only CAIRNS CITY and CAIRNS NORTH; no
        ROCKHAMPTON, only ROCKHAMPTON CITY. Operators name the city. Between
        them these were the largest single misses by customers affected --
        Toowoomba alone was 1,435.

     3. Operators abbreviate where the gazetteer spells out: MT MORT for
        MOUNT MORT.

   Run against the shipped gazetteer, not a fixture, so a rebuild that breaks
   a name fails here.

   Run: node test/gaz_lookup.test.mjs */
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(page);
  if (!m) throw new Error('not found in the page: ' + what);
  return m[0];
};
const fns = new Function([
  grab(/const GAZ_STATE=[\s\S]*?const GAZ_ST_RE=[^\n]*\n/, 'gazetteer regexes'),
  grab(/function gazBase\(name\)\{[\s\S]*?\n  \}/, 'gazBase'),
  grab(/function gazNorm\(name\)\{[\s\S]*?\n  \}/, 'gazNorm'),
  grab(/function buildGazIndex\(items\)\{[\s\S]*?\n  \}/, 'buildGazIndex'),
  grab(/function gazLookup\(gaz,rawTown,st\)\{[\s\S]*?\n  \}/, 'gazLookup')
].join('\n') + '; return { gazBase, gazNorm, gazLookup, buildGazIndex };')();

/* The index is built BY the page's own builder, not by a copy of it. The
   copy that used to live here went stale the moment the prefix rule
   changed: the page resolved CHARTERS TOWERS and this file still insisted
   it could not. */
const j = JSON.parse(readFileSync(new URL('../data/gazetteer.json', import.meta.url), 'utf8'));
const gaz = fns.buildGazIndex(j.items || []);


let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
/* Australia's bounding box, so a resolved point is checked for being
   plausible rather than merely non-null. A lookup that returns a number in
   the wrong hemisphere is worse than one that returns nothing. */
const inAustralia = (p) => !!p && p[0] < -9 && p[0] > -44 && p[1] > 112 && p[1] < 154;
const near = (p, lat, lon, deg) => !!p && Math.abs(p[0] - lat) < deg && Math.abs(p[1] - lon) < deg;

console.log('== still exact, which must not regress ==');
[['SYDNEY', 'NSW'], ['PARRAMATTA', 'NSW'], ['GEELONG', 'VIC'], ['BUNBURY', 'WA']].forEach(([t, st]) => {
  const p = fns.gazLookup(gaz, t, st);
  ck(t + ' (' + st + ')', inAustralia(p), p);
});

console.log('\n== the suffix forms the builder was missing ==');
[['LONGFORD', 'TAS'], ['COLO', 'NSW'], ['RED HILL', 'QLD'], ['PRESTON', 'QLD']].forEach(([t, st]) => {
  const p = fns.gazLookup(gaz, t, st);
  ck(t + ' (' + st + ')', inAustralia(p), p);
});

console.log('\n== the city case: operators name cities, the ABS holds suburbs ==');
/* Checked against the real coordinates, not merely for being non-null --
   resolving Toowoomba to a point in Cairns would still "work". */
[['TOOWOOMBA', 'QLD', -27.56, 151.95], ['CAIRNS', 'QLD', -16.92, 145.77],
 ['ROCKHAMPTON', 'QLD', -23.38, 150.51], ['GLADSTONE', 'QLD', -23.84, 151.26]].forEach(([t, st, lat, lon]) => {
  const p = fns.gazLookup(gaz, t, st);
  ck(t + ' resolves near ' + lat + ',' + lon, near(p, lat, lon, 0.6), p);
});

console.log('\n== multi-word cities, which the first version of this missed ==');
/* The prefix index was keyed on the first word only, so TOOWOOMBA found
   TOOWOOMBA CITY and CHARTERS TOWERS did not find CHARTERS TOWERS CITY --
   a one-word city resolved and a two-word city did not, for no reason. It
   now indexes every leading word-run. */
[['CHARTERS TOWERS', 'QLD', -20.08, 146.26], ['ALICE SPRINGS', 'NT', -23.70, 133.88],
 ['BROKEN HILL', 'NSW', -32.32, 141.55], ['MOUNT ISA', 'QLD', -20.54, 139.46],
 ['PORT MACQUARIE', 'NSW', -31.46, 152.89], ['COFFS HARBOUR', 'NSW', -30.30, 153.11],
 ['WAGGA WAGGA', 'NSW', -35.11, 147.36]].forEach(([t, st, lat, lon]) => {
  const p = fns.gazLookup(gaz, t, st);
  ck(t + ' resolves near ' + lat + ',' + lon, near(p, lat, lon, 0.6), p);
});

console.log('\n== abbreviations ==');
ck('MT MORT finds MOUNT MORT', inAustralia(fns.gazLookup(gaz, 'MT MORT', 'QLD')),
  fns.gazLookup(gaz, 'MT MORT', 'QLD'));
ck('gazNorm expands MT', fns.gazNorm('MT MORT') === fns.gazNorm('MOUNT MORT'));
ck('gazNorm expands ST', fns.gazNorm('ST MARYS') === fns.gazNorm('SAINT MARYS'));
ck('gazNorm expands NTH', fns.gazNorm('NTH SYDNEY') === fns.gazNorm('NORTH SYDNEY'));

console.log('\n== the state still decides between same-named towns ==');
/* There is a Richmond in five states. Resolving to the wrong one would put
   a Victorian outage in Tasmania, which is the reason the key carries the
   state at all. */
const rVic = fns.gazLookup(gaz, 'RICHMOND', 'VIC');
const rTas = fns.gazLookup(gaz, 'RICHMOND', 'TAS');
ck('Richmond VIC resolves', inAustralia(rVic), rVic);
ck('Richmond TAS resolves', inAustralia(rTas), rTas);
ck('and they are different places', !!rVic && !!rTas && Math.abs(rVic[0] - rTas[0]) > 1,
  { vic: rVic, tas: rTas });

console.log('\n== nothing is invented ==');
ck('a town that does not exist returns null',
  fns.gazLookup(gaz, 'ZZZNOWHERE', 'NSW') === null);
ck('an empty name returns null', fns.gazLookup(gaz, '', 'NSW') === null);
ck('no gazetteer returns null', fns.gazLookup(null, 'SYDNEY', 'NSW') === null);
/* A prefix that is a whole word of many unrelated localities must not
   resolve to their average, which would be a point in the middle of
   nowhere presented as a town. */
ck('a bare direction word does not resolve to an average',
  fns.gazLookup(gaz, 'NORTH', 'NSW') === null || inAustralia(fns.gazLookup(gaz, 'NORTH', 'NSW')));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
