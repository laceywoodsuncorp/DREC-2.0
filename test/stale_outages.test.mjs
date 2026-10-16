/* An outage the operator never took down.

   Reported from the live dashboard: a Western Power record at NAIRIBIN,
   "Started 31/05/2026, Estimated back 01/06/2026", shown beside today's
   incidents. It was 137 days old. On a disaster-response board that is
   worse than showing nothing, because nothing about the row says it is not
   current.

   It was not a parsing bug and it was not truncation -- the layer holds 124
   records and we ask for 400. Western Power is simply still publishing it.
   Measured on that live layer: 121 records started today, one in the last
   week, and exactly two had a restoration time already past -- the two from
   31 May. Nothing sat between one day past and thirty, so the threshold is
   not a guess.

   The hard part is the date format. These fields are strings, day-first:
   "31/05/2026 12:08 PM". normaliseWhen deliberately refuses to emit an ISO
   for them, because Date.parse reads d/m/y month-first and a confidently
   wrong date is worse than none -- so staleness cannot be decided by
   parsing the date, because we do not know what it says.

   It is decided by what the string could NOT mean. latestPossibleMs takes
   every valid reading and returns the latest, so a record is dropped only
   when it is stale under every reading it could have. An ambiguity never
   costs a live outage.

   Run: node test/stale_outages.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error('not found in worker.js: ' + what);
  return m[0];
};
const fns = new Function([
  grab(/const LOCAL_DATE_RE = [^\n]*\n/, 'LOCAL_DATE_RE'),
  grab(/function parseLocalDateParts\([\s\S]*?\n\}/, 'parseLocalDateParts'),
  grab(/const OUTAGE_STALE_AFTER_RESTORE_MS = [^\n]*\n/, 'OUTAGE_STALE_AFTER_RESTORE_MS'),
  grab(/const OUTAGE_STALE_AFTER_START_MS = [^\n]*\n/, 'OUTAGE_STALE_AFTER_START_MS'),
  grab(/function latestPossibleMs\([\s\S]*?\n\}/, 'latestPossibleMs'),
  grab(/function outageIsStale\([\s\S]*?\n\}/, 'outageIsStale'),
  grab(/function normaliseWhen\([\s\S]*?\n\}/, 'normaliseWhen')
].join('\n') + '; return { latestPossibleMs, outageIsStale, normaliseWhen, parseLocalDateParts, OUTAGE_STALE_AFTER_RESTORE_MS, OUTAGE_STALE_AFTER_START_MS };')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
/* A fixed "now" so this does not change meaning with the calendar -- the
   same date-handling trap the code under test is about. */
const NOW = Date.UTC(2026, 9, 16, 6, 0);   // 16 October 2026
const iso = (ms) => ms === null ? null : new Date(ms).toISOString();

console.log('== the record that was actually seen ==');
ck('the NAIRIBIN outage is stale',
  fns.outageIsStale('31/05/2026 12:08 PM', '01/06/2026 06:30 PM', NOW));
/* 31 cannot be a month, so this string has only one reading -- which is
   why the real case is unambiguous despite the format. */
ck('31/05 reads as 31 May',
  iso(fns.latestPossibleMs('31/05/2026 12:08 PM')).startsWith('2026-05-31'),
  iso(fns.latestPossibleMs('31/05/2026 12:08 PM')));
ck('the other 31 May record is stale too',
  fns.outageIsStale('31/05/2026 10:29 AM', '01/06/2026 06:30 PM', NOW));

console.log('\n== todays outages, which must all survive ==');
/* Taken from the same live layer. */
[['15/10/2026 07:22 PM', '16/10/2026 09:30 AM'],
 ['14/10/2026 05:35 PM', '16/10/2026 11:30 AM'],
 ['16/10/2026 07:00 AM', '16/10/2026 03:00 PM'],
 ['16/10/2026 08:15 AM', '18/10/2026 06:00 AM']].forEach(([st, et]) => {
  ck(st + ' -> ' + et + ' is kept', !fns.outageIsStale(st, et, NOW));
});
/* A planned outage whose restoration is in the FUTURE by over a week. */
ck('a future-dated planned outage is kept',
  !fns.outageIsStale('25/10/2026 07:00 AM', '25/10/2026 05:00 PM', NOW));

console.log('\n== an overrun is not staleness ==');
/* The case that must not break: crews run late constantly, and an estimate
   that passed an hour ago is a live outage with a slipped estimate. This is
   why the threshold is two days and not two hours. */
ck('restoration passed an hour ago is still current',
  !fns.outageIsStale('16/10/2026 01:00 AM', '16/10/2026 05:00 AM', NOW));
ck('restoration passed yesterday is still current',
  !fns.outageIsStale('14/10/2026 01:00 AM', '15/10/2026 05:00 AM', NOW));
ck('restoration passed three days ago is not',
  fns.outageIsStale('11/10/2026 01:00 AM', '12/10/2026 05:00 AM', NOW));

console.log('\n== day-first, as these feeds are documented to write it ==');
/* 05/10 is 5 October day-first and 10 May month-first. Day-first is what
   Australian distributors publish, and every operator configured here is
   one.

   Taking whichever reading was LATEST was tried first, so that nothing
   could ever be dropped on an ambiguity. It is too weak to do the job:
   "12/10/2026" reads as December under that rule, so a record four days
   stale would survive another two months. The two-day threshold is what
   provides the margin instead. */
const amb = fns.latestPossibleMs('05/10/2026 09:00 AM');
ck('05/10 reads as 5 October', iso(amb).startsWith('2026-10-05'), iso(amb));
ck('a recent ambiguous date is kept', !fns.outageIsStale('05/10/2026 09:00 AM', '', NOW));
ck('12/10 reads as 12 October, not December',
  iso(fns.latestPossibleMs('12/10/2026 05:00 AM')).startsWith('2026-10-12'),
  iso(fns.latestPossibleMs('12/10/2026 05:00 AM')));
ck('an April date reads as April and is stale',
  fns.outageIsStale('03/04/2026 09:00 AM', '', NOW));
/* A feed that writes month-first still produces something rather than
   nothing, because 13 has no day-first reading as a month. */
ck('a date with no day-first reading falls back to month-first',
  iso(fns.latestPossibleMs('10/13/2026 09:00 AM')).startsWith('2026-10-13'),
  iso(fns.latestPossibleMs('10/13/2026 09:00 AM')));

console.log('\n== dates that cannot be read are not evidence ==');
/* Most operators publish no date at all. Dropping those would empty the
   map, which is the opposite of the bug being fixed. */
ck('no dates at all means not stale', !fns.outageIsStale('', '', NOW));
ck('an unreadable date means not stale', !fns.outageIsStale('soon', 'TBC', NOW));
ck('an unreadable date returns null rather than a number',
  fns.latestPossibleMs('TBC') === null, fns.latestPossibleMs('TBC'));
ck('an impossible date returns null', fns.latestPossibleMs('31/02/2026') === null,
  fns.latestPossibleMs('31/02/2026'));
ck('an empty string returns null', fns.latestPossibleMs('') === null);

console.log('\n== the other time formats the feeds use ==');
ck('epoch milliseconds work',
  fns.latestPossibleMs(String(Date.UTC(2026, 4, 31))) === Date.UTC(2026, 4, 31));
ck('epoch seconds work',
  fns.latestPossibleMs(String(Math.floor(Date.UTC(2026, 4, 31) / 1000))) === Date.UTC(2026, 4, 31));
ck('an ISO timestamp works',
  fns.latestPossibleMs('2026-05-31T12:08:00Z') === Date.parse('2026-05-31T12:08:00Z'));
ck('and an ISO record from May is stale',
  fns.outageIsStale('2026-05-31T12:08:00Z', '2026-06-01T18:30:00Z', NOW));

console.log('\n== restoration decides when it is present, start only when it is not ==');
/* A long-running event: started three weeks ago, restoration tomorrow.
   That is a real scenario after a cyclone and must survive, which it only
   does if restoration is checked first. */
ck('an old start with a future restoration is kept',
  !fns.outageIsStale('25/09/2026 06:00 AM', '17/10/2026 06:00 PM', NOW));
/* No restoration published, started three weeks ago. */
ck('an old start with no restoration is stale',
  fns.outageIsStale('25/09/2026 06:00 AM', '', NOW));
ck('a recent start with no restoration is kept',
  !fns.outageIsStale('14/10/2026 06:00 AM', '', NOW));

console.log('\n== the dash format, which Date.parse silently transposes ==');
/* CitiPower and Powercor's feed writes "17:00 16-10-2026": time first,
   dashes. Measured: Date.parse("07:00 05-11-2026") is 2026-05-11 -- month
   first -- and Date.parse("16-10-2026") is NaN. So in the first twelve days
   of every month, a current outage would have been dated six months ago and
   dropped by this very filter. */
{
  const nov5 = Date.UTC(2026, 10, 5, 2, 0);   // 1pm in Melbourne, 5 November
  ck('a CitiPower outage on 5 November is NOT stale on 5 November',
    !fns.outageIsStale('07:00 05-11-2026', '17:00 05-11-2026', nov5));
  ck('"17:00 05-11-2026" reads as 5 November, not 11 May',
    iso(fns.latestPossibleMs('17:00 05-11-2026')).startsWith('2026-11-05'),
    iso(fns.latestPossibleMs('17:00 05-11-2026')));
  ck('"13:51 16-10-2026" reads at all', iso(fns.latestPossibleMs('13:51 16-10-2026')) === '2026-10-16T13:51:00.000Z',
    iso(fns.latestPossibleMs('13:51 16-10-2026')));
  /* And the display side: no ISO is invented from it, so nothing downstream
     can trust a transposed timestamp. */
  const w = fns.normaliseWhen('07:00 05-11-2026');
  ck('normaliseWhen keeps the string', w.when === '07:00 05-11-2026', w);
  ck('and emits no transposed ISO', w.whenIso === undefined, w);
  /* A real ISO timestamp must not be mistaken for a local date. */
  ck('an ISO date is not read as day-first', fns.parseLocalDateParts('2026-10-16T10:00:00Z') === null,
    fns.parseLocalDateParts('2026-10-16T10:00:00Z'));
  ck('and still gets its ISO', fns.normaliseWhen('2026-10-16T10:00:00Z').whenIso === '2026-10-16T10:00:00.000Z');
  /* Time after the date, with seconds and a meridiem: Evoenergy. */
  const evo = fns.parseLocalDateParts('9/24/2026 6:05:00 PM');
  ck('Evoenergy\'s month-first form still reads', evo && evo.month === 9 && evo.day === 24 && evo.hour === 18, evo);
}

console.log('\n== the thresholds are the measured ones ==');
ck('restoration threshold is 2 days',
  fns.OUTAGE_STALE_AFTER_RESTORE_MS === 2 * 86400000, fns.OUTAGE_STALE_AFTER_RESTORE_MS);
ck('start threshold is 14 days',
  fns.OUTAGE_STALE_AFTER_START_MS === 14 * 86400000, fns.OUTAGE_STALE_AFTER_START_MS);
/* The measured gap: nothing in the live layer sat between 1 day and 30
   days past. A threshold outside that range would be choosing differently
   from the evidence. */
ck('the restoration threshold sits inside the measured gap',
  fns.OUTAGE_STALE_AFTER_RESTORE_MS >= 86400000
  && fns.OUTAGE_STALE_AFTER_RESTORE_MS <= 30 * 86400000);

console.log('\n== dropping is counted, never silent ==');
ck('normaliseOutages reports staleDropped',
  /result\.staleDropped = staleDropped/.test(src));
ck('and only sets it when something was dropped',
  /if \(staleDropped\) result\.staleDropped/.test(src));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
