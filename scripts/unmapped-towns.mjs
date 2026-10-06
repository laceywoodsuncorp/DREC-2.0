/* Which outage locations cannot be placed on the map, and why.

   The map resolves a town name against the ABS gazetteer in the browser, so
   a name the operator spells differently simply never appears -- and an
   outage that does not appear is indistinguishable from one that is not
   happening. This lists them.

   The page's own looksLikePlace() and townCandidates() are extracted and
   run here rather than reimplemented, so this measures what the map actually
   does. A reimplementation would drift and start reporting misses the map
   does not have, or miss ones it does.

   Three outcomes are kept apart, because they need different fixes:

     placed       resolved to a point
     unplaced     looks like a place and is not in the gazetteer -- either a
                  spelling the gazetteer does not hold, or a locality that
                  genuinely is not in it
     not a place  never a town name: nav labels, a cookie notice, a path, a
                  fragment of markup from a scrape that went wrong. Counting
                  these as missing towns would bury the real ones.

   Run from somewhere that can reach the Worker:
     node scripts/unmapped-towns.mjs
*/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'https://drec-oncall-updates-site.lacey-wood.workers.dev';
const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(page);
  if (!m) throw new Error('not found in the page: ' + what);
  return m[0];
};
const fns = new Function(
  grab(/function looksLikePlace\(t\)\{[\s\S]*?\n  \}/, 'looksLikePlace') + '\n' +
  grab(/function townCandidates\(raw\)\{[\s\S]*?\n  \}/, 'townCandidates') +
  '; return { looksLikePlace, townCandidates };')();

const gaz = JSON.parse(readFileSync(new URL('../data/gazetteer.json', import.meta.url), 'utf8'));
const byKey = new Map();
const byName = new Map();
gaz.items.forEach((it) => {
  byKey.set(it[0] + '|' + it[1], [it[2], it[3]]);
  if (!byName.has(it[0])) byName.set(it[0], []);
  byName.get(it[0]).push(it);
});
console.log('gazetteer: ' + gaz.items.length + ' localities, edition ' + gaz.edition);

const states = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'nt', 'act'];
const fetchErrors = [];
const perState = {};
const unplaced = new Map(); // "TOWN|ST" -> { town, state, rows, customers, networks:Set }
const notPlaces = new Map();
let placed = 0, total = 0;

for (const st of states) {
  let payload;
  try {
    const res = await fetch(BASE + '/api/outages/' + st);
    payload = await res.json();
  } catch (e) { fetchErrors.push(st + ': ' + e.message); continue; }
  /* Said out loud. A state that returned nothing is not a state with no
     unplaceable towns, and the first run of this script finished in one
     second, which is the shape of every fetch having failed silently. */
  const n = (payload.outages || []).length;
  perState[st] = { rows: n, ok: payload.ok, count: payload.count };
  if (!n) fetchErrors.push(st + ': 0 rows (ok=' + payload.ok + ', count=' + payload.count + ')');

  (payload.outages || []).forEach((o) => {
    const rowState = (o.state || st).toUpperCase();
    const raw = (o.towns && o.towns.length) ? o.towns : (o.location ? [o.location] : []);
    const towns = raw.reduce((acc, t) => acc.concat(fns.townCandidates(t)), []);
    if (raw.length && !towns.length) {
      const k = String(raw[0]).slice(0, 60);
      notPlaces.set(k, (notPlaces.get(k) || 0) + 1);
      return;
    }
    towns.forEach((town) => {
      total++;
      const key = String(town).trim().toUpperCase();
      let pos = byKey.get(key + '|' + rowState) || null;
      if (!pos) {
        const cands = byName.get(key);
        if (cands && cands.length === 1) pos = [cands[0][2], cands[0][3]];
      }
      if (pos) { placed++; return; }
      if (!fns.looksLikePlace(town)) {
        notPlaces.set(town, (notPlaces.get(town) || 0) + 1);
        return;
      }
      const k = key + '|' + rowState;
      const e = unplaced.get(k) || { town: key, state: rowState, rows: 0, customers: 0, networks: new Set() };
      e.rows++;
      e.customers += Number(o.customers) || 0;
      if (o.network) e.networks.add(o.network);
      unplaced.set(k, e);
    });
  });
}

console.log('\ntown references: ' + total + '   placed: ' + placed
  + '   unplaced: ' + (total - placed)
  + '   (' + (total ? Math.round(((total - placed) / total) * 100) : 0) + '% unplaced)');

const rows = [...unplaced.values()].sort((a, b) => b.customers - a.customers || b.rows - a.rows);
console.log('\nUNPLACED -- looks like a place, not found in the gazetteer');
console.log('customers  rows  state  name                                 network');
console.log('-'.repeat(96));
rows.forEach((r) => {
  console.log(String(r.customers).padStart(9) + String(r.rows).padStart(6) + '  '
    + r.state.padEnd(6) + ' ' + r.town.padEnd(36) + ' ' + [...r.networks].join(', '));
});
if (!rows.length) console.log('  (none)');

/* Printed after, and separately. These are not missing towns and must not be
   counted as such -- they are a sign the scrape read the wrong element. */
const junk = [...notPlaces.entries()].sort((a, b) => b[1] - a[1]);
console.log('\nNOT A PLACE -- the location field held something that was never a town');
junk.slice(0, 25).forEach(([k, n]) => console.log(String(n).padStart(5) + '  ' + JSON.stringify(k).slice(0, 86)));
if (!junk.length) console.log('  (none)');

/* A name that differs only by punctuation, spacing or a saint/mount
   abbreviation is a spelling problem with a cheap fix, so it is worth
   separating from a locality the gazetteer truly lacks. */
console.log('\nNEAR MISSES -- a gazetteer name differing only in punctuation or a common abbreviation');
const norm = (s) => s.toUpperCase().replace(/\bST\.?\b/g, 'SAINT').replace(/\bMT\.?\b/g, 'MOUNT')
  .replace(/\bNTH\b/g, 'NORTH').replace(/\bSTH\b/g, 'SOUTH')
  .replace(/\bE\b/g, 'EAST').replace(/\bW\b/g, 'WEST')
  .replace(/[^A-Z0-9]+/g, '');
const normIndex = new Map();
gaz.items.forEach((it) => {
  const k = norm(it[0]) + '|' + it[1];
  if (!normIndex.has(k)) normIndex.set(k, it);
});
let near = 0;
rows.forEach((r) => {
  const hit = normIndex.get(norm(r.town) + '|' + r.state);
  if (hit) { near++; console.log('  ' + r.town.padEnd(34) + ' -> ' + hit[0] + ' (' + hit[1] + ')'); }
});
if (!near) console.log('  (none)');
console.log('\nnear misses: ' + near + ' of ' + rows.length + ' unplaced names');

if (fetchErrors.length) {
  console.log('\nSTATES THAT CONTRIBUTED NOTHING (so their towns are not in the above)');
  fetchErrors.forEach((e) => console.log('  ' + e));
}

/* Written out as well as printed. Reading this back out of a workflow log
   means paging through twenty other steps, and a finding that is awkward to
   retrieve is one nobody retrieves. */
const report = {
  at: new Date().toISOString(),
  gazetteer: { items: gaz.items.length, edition: gaz.edition },
  totals: { townReferences: total, placed, unplaced: total - placed },
  perState,
  statesContributingNothing: fetchErrors,
  unplaced: rows.map((r) => ({ town: r.town, state: r.state, rows: r.rows,
    customers: r.customers, networks: [...r.networks],
    nearMiss: (normIndex.get(norm(r.town) + '|' + r.state) || [null])[0] })),
  notPlaces: junk.map(([name, n]) => ({ value: name, rows: n }))
};
mkdirSync('data', { recursive: true });
writeFileSync('data/unmapped-towns.json', JSON.stringify(report, null, 2));
console.log('\nwrote data/unmapped-towns.json');
