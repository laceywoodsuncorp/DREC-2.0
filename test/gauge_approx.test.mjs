/* Approximate positions for river gauges no published file locates.

   What must hold: an exact position is never touched; a town match counts
   only near the catchment's exactly-placed gauges; a street address is
   never matched to a town; a gauge is placed between neighbours only when
   there is a close one on both sides; and every approximate position says
   which kind it is.

   Run: node test/gauge_approx.test.mjs */
import { placeCandidates, gazetteerIndex, townPosition, neighbourPosition, placeApproximately, km,
  TOWN_MAX_KM_CATCHMENT, NEIGHBOUR_SPAN_MAX_KM } from '../scripts/lib/gauge-approx.mjs';

let pass = 0, fail = 0;
const ck = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); }
};

/* Real places: Junction View and Gatton in the Lockyer Valley; the
   Gundagai and Yarramalong that are in NSW, hundreds of km from the
   Queensland gauges that carry their names. */
const GAZ = [
  ['JUNCTION VIEW', 'QLD', -27.811, 152.182], ['GATTON', 'QLD', -27.564, 152.28],
  ['GUNDAGAI', 'NSW', -35.043, 148.104], ['YARRAMALONG', 'NSW', -33.211, 151.256],
  ['BRASSALL', 'QLD', -27.597, 152.744], ['MOUNT WALKER', 'QLD', -27.787, 152.553],
  ['RICHMOND', 'VIC', -37.82, 145.0], ['RICHMOND', 'QLD', -20.73, 143.14]
];
const gaz = gazetteerIndex(GAZ);

console.log('== the place in a gauge\'s name ==');
{
  ck('"at <town>"', placeCandidates('Blackfellow Creek at Junction View')[0] === 'JUNCTION VIEW');
  ck('a parenthetical is not part of the town', placeCandidates('Bremer River at Brassall (Hancocks Bridge)')[0] === 'BRASSALL');
  ck('a feature word is dropped as a second try', placeCandidates('Lockyer Creek at Gatton Weir').includes('GATTON'));
  ck('Mt is Mount, and Lower X also tries X', placeCandidates('Bremer River at Lower Mt Walker').includes('MOUNT WALKER'),
    placeCandidates('Bremer River at Lower Mt Walker'));
  ck('telemetry suffixes are not part of the name', placeCandidates('Brisbane River at Gatton Alert')[0] === 'GATTON');
  ck('a street address yields nothing', placeCandidates('Coffs Creek at Gundagai Street').length === 0);
  ck('nor a road', placeCandidates('Quart Pot Creek at Granite Rd').length === 0);
}

console.log('\n== a town match counts only near the catchment ==');
{
  const lockyer = [[-27.56, 152.28], [-27.63, 152.18]];
  const p = townPosition('Blackfellow Creek at Junction View', gaz, lockyer, []);
  ck('a town near the catchment\'s gauges is used', p && p[0] === -27.811, p);
  /* The Condamine's Yarramalong is a property near Warwick; the only
     Yarramalong in the gazetteer is 600 km away on the NSW Central Coast. */
  const condamine = [[-27.87, 151.5], [-28.2, 152.0]];
  ck('a same-named town far from the catchment is refused',
    townPosition('Condamine River at Yarramalong', gaz, condamine, []) === null);
  ck('of two towns with the name, the one near the catchment wins',
    townPosition('Flinders River at Richmond', gaz, [[-20.8, 143.2]], [])[0] === -20.73);
  ck('with no exactly-placed gauge to check against, nothing is matched',
    townPosition('Blackfellow Creek at Junction View', gaz, [], []) === null);
  ck('the limit is the documented one', TOWN_MAX_KM_CATCHMENT === 40 && km([-27.811, 152.182], lockyer[1]) < 40);
}

console.log('\n== between neighbours, only with a close one on both sides ==');
{
  const at = (pts) => (j) => pts[j] || null;
  const mid = neighbourPosition(1, 3, at([[-28.0, 152.0], null, [-28.2, 152.2]]));
  ck('halfway between two close neighbours', mid && Math.abs(mid[0] + 28.1) < 1e-9 && Math.abs(mid[1] - 152.1) < 1e-9, mid);
  const third = neighbourPosition(1, 4, at([[-28.0, 152.0], null, null, [-28.3, 152.3]]));
  ck('in proportion to its place in the table', third && Math.abs(third[0] + 28.1) < 1e-9, third);
  ck('one neighbour only is not enough', neighbourPosition(1, 2, at([[-28.0, 152.0], null])) === null);
  ck('nor two that are far apart', neighbourPosition(1, 3, at([[-28.0, 152.0], null, [-30.0, 152.0]])) === null);
  ck('the span limit is the documented one', NEIGHBOUR_SPAN_MAX_KM === 60);
}

console.log('\n== the whole pass ==');
{
  const groups = [{ state: 'QLD', product: 'IDQ60286', catchment: 'Lower Brisbane', stations: [
    { name: 'Lockyer Creek at Helidon', at: [-27.55, 152.12] },
    { name: 'Blackfellow Creek at Junction View' },
    { name: 'Tenthill Creek at Kilbronae Station' },
    { name: 'Lockyer Creek at Gatton', at: [-27.56, 152.28] },
    { name: 'Coffs Creek at Gundagai Street' }
  ] }];
  const res = placeApproximately(groups, GAZ);
  const s = groups[0].stations;
  ck('an exact position is untouched', s[0].at[0] === -27.55 && !s[0].approx && s[3].at[1] === 152.28 && !s[3].approx);
  ck('a town match is marked as one', s[1].approx === 't' && s[1].at[0] === -27.811, s[1]);
  ck('an unmatched name between two placed gauges is marked as that', s[2].approx === 'n' && s[2].at, s[2]);
  ck('and sits between them', s[2].at[0] < -27.56 && s[2].at[0] > -27.811 && s[2].at[1] > 152.18 && s[2].at[1] < 152.28, s[2].at);
  ck('a street address with nothing after it stays unplaced', !s[4].at && !s[4].approx, s[4]);
  ck('and the counts say so', res.town === 1 && res.neighbour === 1 && res.none === 1, res);
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
