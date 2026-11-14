/* BOM river heights and flood warnings, read from the files BOM's
   anonymous FTP service actually serves.

   Fixtures in test/fixtures/bom/ are real files captured 14 Nov 2026:
     IDQ60293.html  Condamine-Balonne table, with gauges at minor flood
     IDN60140.html  NSW Northern Rivers table, nothing in flood
     IDD60022.html  NT table
     IDQ20827.xml   Minor Flood Warning for the Upper Condamine River
     IDN36631.xml   Minor Flood Warning for the Warrego River (NSW)

   Run: node test/bom_rivers.test.mjs */
import { readFileSync } from 'node:fs';
import { parseIssued, stationTime, floodLevel, parseRiverHeights, parseFloodWarning,
  buildRiversSnapshot, RIVER_HEIGHT_PRODUCTS } from '../scripts/lib/bom-rivers.mjs';

const fx = (f) => readFileSync(new URL('./fixtures/bom/' + f, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ck = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); }
};

console.log('== when a table was issued, and when each reading was taken ==');
{
  const i = parseIssued('Issued at 08:54 PM AEST Saturday 14 November 2026');
  ck('the issue time is read in its own zone', i && new Date(i.ms).toISOString() === '2026-11-14T10:54:00.000Z', i);
  const d = parseIssued('Issued at 09:54 PM AEDT Saturday 14 November 2026');
  ck('daylight time too', d && new Date(d.ms).toISOString() === '2026-11-14T10:54:00.000Z', d);
  ck('a reading the same evening is dated that day',
    new Date(stationTime('08.20PM Sat', i)).toISOString() === '2026-11-14T10:20:00.000Z');
  ck('a morning reading the same day', new Date(stationTime('08.14AM Sat', i)).toISOString() === '2026-11-13T22:14:00.000Z');
  ck('a reading from the day before', new Date(stationTime('11.30PM Fri', i)).toISOString() === '2026-11-13T13:30:00.000Z');
  /* A reading stamped a few minutes after the table -- clocks differ --
     is that evening, not a week ago. */
  ck('a reading just after issue is not pushed back a week',
    new Date(stationTime('09.05PM Sat', i)).toISOString() === '2026-11-14T11:05:00.000Z');
  ck('a blank time is no time', stationTime('', i) === null);
}

console.log('\n== flood classification ==');
{
  ck('Minor, Moderate, Major are levels',
    floodLevel('Minor') === 'minor' && floodLevel('Moderate') === 'moderate' && floodLevel('Major') === 'major');
  ck('Below Flood Level is not a flood', floodLevel('Below Flood Level') === null);
  ck('No Classification is not a flood', floodLevel('No Classification') === null);
  ck('blank is not a flood', floodLevel('') === null);
}

console.log('\n== a river height table ==');
{
  const r = parseRiverHeights(fx('IDQ60293.html'));
  ck('stations are read', r.stations.length > 50, r.stations.length);
  ck('each has a name and a catchment', r.stations.every((s) => s.name && s.catchment), r.stations.find((s) => !s.name || !s.catchment));
  const tum = r.stations.find((s) => /Condamine River at Tummaville/.test(s.name));
  ck('Tummaville is at minor flood, as BOM says', tum && tum.level === 'minor', tum);
  ck('with its height and tendency', tum && typeof tum.height === 'number' && /rising|falling|steady/.test(tum.tendency), tum);
  ck('and BOM\'s own page for the gauge', tum && /^IDQ\d{5}\/IDQ\d{5}\.\d+\.plt\.shtml$/.test(tum.plot), tum && tum.plot);
  ck('every timed reading is dated no later than shortly after issue',
    r.stations.filter((s) => s.time).every((s) => s.time <= r.issued + 3600e3 && s.time > r.issued - 8 * 86400e3));
  ck('"Below Flood Level" is not carried on every row', !r.stations.some((s) => s.classText === 'Below Flood Level'));

  const n = parseRiverHeights(fx('IDN60140.html'));
  ck('a table with nothing in flood says so', n.stations.length > 50 && !n.stations.some((s) => s.level), n.stations.filter((s) => s.level));
  const nt = parseRiverHeights(fx('IDD60022.html'));
  ck('the NT table reads the same way', nt.stations.length > 20 && nt.issued, [nt.stations.length, nt.issued]);
}

console.log('\n== flood warnings ==');
{
  const w = parseFloodWarning(fx('IDQ20827.xml'), 'IDQ20827.xml');
  ck('a flood warning is read', w && w.title === 'Minor Flood Warning for the Upper Condamine River', w && w.title);
  ck('its state, from the product id', w && w.state === 'QLD', w && w.state);
  ck('its level', w && w.level === 'minor', w && w.level);
  ck('the basins it covers', w && w.areas.includes('Upper Condamine River'), w && w.areas);
  ck('the situation in BOM\'s words', w && /MINOR FLOODING OCCURRING AT TUMMAVILLE/.test(w.situation), w && w.situation);
  ck('when it was issued and when it lapses', w && w.issued && w.expires && w.expires > w.issued, w && [w.issued, w.expires]);
  ck('a link to BOM\'s page for it', w && w.url === 'https://www.bom.gov.au/products/IDQ20827.shtml', w && w.url);
  const nsw = parseFloodWarning(fx('IDN36631.xml'), 'IDN36631.xml');
  ck('NSW warnings too', nsw && nsw.state === 'NSW' && nsw.level === 'minor', nsw && [nsw.state, nsw.level]);
  const marine = '<?xml version="1.0"?><product><amoc><identifier>IDN20400</identifier><service>WMW</service></amoc>' +
    '<warning><warning-info><text type="warning_title">Marine Wind Warning Summary for New South Wales</text></warning-info></warning></product>';
  ck('a marine wind warning in the same directory is not a flood warning', parseFloodWarning(marine, 'IDN20400.xml') === null);
  const final = fx('IDQ20827.xml').replace(/Minor Flood Warning for/, 'Final Flood Warning for').replace(/<element type="severity">Minor/, '<element type="severity">');
  const f = parseFloodWarning(final, 'IDQ20827.xml');
  ck('a final warning is marked final, with no level', f && f.final && !f.level, f && [f.final, f.level]);
}

console.log('\n== the snapshot ==');
{
  const issued = parseFloodWarning(fx('IDQ20827.xml')).issued;
  const files = { 'IDQ60293.html': fx('IDQ60293.html'), 'IDN60140.html': fx('IDN60140.html'),
    'IDQ20827.xml': fx('IDQ20827.xml'), 'IDN36631.xml': fx('IDN36631.xml') };
  const s = buildRiversSnapshot(files, issued + 3600e3);
  ck('every listed table is reported, read or not', s.products.length === RIVER_HEIGHT_PRODUCTS.length);
  ck('a table not in the capture is reported missing, not dropped',
    s.products.find((p) => p.id === 'IDV60201').ok === false, s.products.find((p) => p.id === 'IDV60201'));
  ck('the two read are ok', s.products.filter((p) => p.ok).map((p) => p.id).sort().join() === 'IDN60140,IDQ60293');
  const flooding = s.groups.flatMap((g) => g.stations.map((st) => Object.assign({ state: g.state, catchment: g.catchment }, st))).filter((x) => x.level);
  ck('the counts match the gauges in flood', s.counts.minor + s.counts.moderate + s.counts.major === flooding.length,
    [s.counts, flooding.length]);
  ck('each group carries its state and catchment once', s.groups.every((g) => g.state && g.catchment && g.stations.every((x) => !('catchment' in x))));
  ck('both warnings are current', s.warnings.length === 2, s.warnings.map((w) => w.id));
  const withFinal = Object.assign({}, files, { 'IDQ20845.xml': fx('IDQ20827.xml')
    .replace(/IDQ20827/g, 'IDQ20845').replace(/Minor Flood Warning for/, 'Final Flood Warning for') });
  const order = buildRiversSnapshot(withFinal, issued + 3600e3).warnings.map((w) => w.id);
  ck('a final warning sorts after the active ones, even with a severity', order[order.length - 1] === 'IDQ20845', order);
  const later = buildRiversSnapshot(files, Date.parse('2030-01-01'));
  ck('an expired warning is dropped', later.warnings.length === 0, later.warnings.map((w) => w.id));
  ck('the source is named', /Bureau of Meteorology/.test(s.source));
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
