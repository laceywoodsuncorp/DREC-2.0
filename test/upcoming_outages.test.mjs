/* An outage that has not started yet.

   Reported from the live dashboard on 16 October: HOLT ROCK, Western
   Power, "Customers off 4, Started 20/10/2026 08:00 AM", drawn as a red
   fault -- four days before the job was due to begin.

   Measured on Western Power's live layer that day: 123 of its 128 records
   started in the FUTURE, and its PLANNEDOUTAGE flag called 107 of those
   "Unplanned". Its OUTAGETYPE carried a third value, "F", on 105 records,
   which this project had never handled. Following the operator's label
   faithfully put a hundred scheduled jobs into the "customers off"
   headline. The rule that does not depend on decoding the operator's
   vocabulary: a job that has not started cannot be a current fault.

   The dangerous part is the timezone. These strings are local with no
   zone, so a naive parse reads WA's "08:00 AM" as 08:00 UTC -- eight hours
   late. At 09:00 in Perth that job started an hour ago, and a naive parse
   would call it upcoming and HIDE A LIVE OUTAGE. So the offset is the
   state's largest (daylight time where observed), making the computed
   instant the earliest the string could mean. A job is only ever marked
   upcoming when it certainly has not begun.

   Run: node test/upcoming_outages.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error('not found in worker.js: ' + what);
  return m[0];
};
const fns = new Function([
  grab(/const OUTAGE_STATE_MAX_UTC_OFFSET_H = \{[\s\S]*?\n\};/, 'OUTAGE_STATE_MAX_UTC_OFFSET_H'),
  grab(/function outageStartInstantMs\([\s\S]*?\n\}/, 'outageStartInstantMs'),
  grab(/function markUpcoming\([\s\S]*?\n\}/, 'markUpcoming')
].join('\n') + '; return { outageStartInstantMs, markUpcoming, OUTAGE_STATE_MAX_UTC_OFFSET_H };')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const H = 3600000;

console.log('== the record that was seen ==');
/* 16 October, about lunchtime in Perth. */
const NOW = Date.UTC(2026, 9, 16, 4, 0);
const holt = { network: 'Western Power', location: 'HOLT ROCK', customers: 4, kind: 'unplanned',
  start: '20/10/2026 08:00 AM', restore: '20/10/2026 04:00 PM' };
const n = fns.markUpcoming([holt], 'wa', NOW);
ck('HOLT ROCK is marked upcoming', holt.upcoming === true, holt);
ck('and is no longer an unplanned fault', holt.kind === 'planned', holt.kind);
ck('the operator\'s own label is kept beside it', holt.kindReported === 'unplanned', holt.kindReported);
ck('and the override is counted', n === 1, n);

console.log('\n== the timezone trap: never hide a job that has started ==');
/* 09:00 in Perth is 01:00 UTC. A job that began at 08:00 local started an
   hour ago. Parsed naively as UTC, "08:00" is seven hours in the future. */
const perth9am = Date.UTC(2026, 9, 20, 1, 0);
const begun = { kind: 'unplanned', start: '20/10/2026 08:00 AM' };
fns.markUpcoming([begun], 'wa', perth9am);
ck('a WA job that started an hour ago is NOT upcoming', !begun.upcoming, begun);
ck('and keeps its unplanned kind', begun.kind === 'unplanned', begun.kind);
/* And one minute before it starts, it is upcoming. */
const perth759 = Date.UTC(2026, 9, 19, 23, 59);
const notYet = { kind: 'unplanned', start: '20/10/2026 08:00 AM' };
fns.markUpcoming([notYet], 'wa', perth759);
ck('one minute before 08:00 Perth it is upcoming', notYet.upcoming === true, notYet);

/* Sydney in daylight time is UTC+11. 09:00 AEDT is 22:00 UTC the day
   before. A job that started at 08:00 AEDT must not read as upcoming. */
const sydney9am = Date.UTC(2026, 9, 19, 22, 0);
const syd = { kind: 'unplanned', start: '20/10/2026 08:00 AM' };
fns.markUpcoming([syd], 'nsw', sydney9am);
ck('an NSW job that started an hour ago in daylight time is NOT upcoming', !syd.upcoming, syd);

/* Brisbane has no daylight saving, so its largest offset is +10. */
ck('QLD uses +10, not +11', fns.OUTAGE_STATE_MAX_UTC_OFFSET_H.qld === 10);
ck('WA uses +8', fns.OUTAGE_STATE_MAX_UTC_OFFSET_H.wa === 8);
ck('NSW uses its daylight offset, +11', fns.OUTAGE_STATE_MAX_UTC_OFFSET_H.nsw === 11);
ck('every outage state has an offset',
  ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'nt', 'act'].every((s) => fns.OUTAGE_STATE_MAX_UTC_OFFSET_H[s] !== undefined));

console.log('\n== what is left alone ==');
const live = { kind: 'unplanned', start: '16/10/2026 09:00 AM' };
fns.markUpcoming([live], 'wa', NOW);
ck('a fault that started this morning stays a fault', !live.upcoming && live.kind === 'unplanned', live);
const noStart = { kind: 'unplanned' };
fns.markUpcoming([noStart], 'wa', NOW);
ck('a row with no start is not touched', !noStart.upcoming && noStart.kind === 'unplanned', noStart);
const junk = { kind: 'unplanned', start: 'TBC' };
fns.markUpcoming([junk], 'wa', NOW);
ck('an unreadable start is not touched', !junk.upcoming, junk);
const unknownState = { kind: 'unplanned', start: '20/10/2026 08:00 AM' };
fns.markUpcoming([unknownState], 'zz', NOW);
ck('an unknown state claims nothing', !unknownState.upcoming, unknownState);
/* Already planned: marked upcoming, but nothing was overridden. */
const planned = { kind: 'planned', start: '20/10/2026 08:00 AM' };
const n2 = fns.markUpcoming([planned], 'wa', NOW);
ck('a planned future job is marked upcoming', planned.upcoming === true, planned);
ck('without counting an override', n2 === 0 && planned.kindReported === undefined, { n2, planned });

console.log('\n== a date with no time is read as the start of the day ==');
/* "Starts 20/10/2026" must not be called upcoming at 10am on the 20th. */
const dateOnly = { kind: 'unplanned', start: '20/10/2026' };
fns.markUpcoming([dateOnly], 'wa', Date.UTC(2026, 9, 20, 2, 0));   // 10:00 Perth
ck('a date-only start is not upcoming on that day', !dateOnly.upcoming, dateOnly);

console.log('\n== real timestamps need no offset ==');
const iso = { kind: 'unplanned', startIso: new Date(NOW + 2 * H).toISOString() };
fns.markUpcoming([iso], 'wa', NOW);
ck('an ISO start two hours ahead is upcoming', iso.upcoming === true, iso);
const isoPast = { kind: 'unplanned', startIso: new Date(NOW - 2 * H).toISOString() };
fns.markUpcoming([isoPast], 'wa', NOW);
ck('an ISO start two hours ago is not', !isoPast.upcoming, isoPast);

console.log('\n== month-first operators still work ==');
/* Evoenergy writes 9/24/2026: 24 cannot be a month, so day-first fails and
   month-first is used -- the same fallback as the staleness rule. */
const evo = { kind: 'unplanned', start: '10/20/2026 8:00:00 AM' };
fns.markUpcoming([evo], 'act', NOW);
ck('a month-first future date is upcoming', evo.upcoming === true, evo);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
