/* Alert levels, as the agencies actually publish them.

   An alert level is what an agency is telling the public to do. There are
   three and they are named the same way nationally. An incident status is a
   different fact -- how the fire is behaving -- and the two used to be read
   into one field and guessed at, which meant the dashboard issued warnings
   nobody had issued: SA's "GOING" became "Watch and Act", and every
   unrecognised value, including NSW's explicit "Not Applicable", became
   "Advice".

   The values below are the real ones these feeds carry.

   Run: node test/alert_levels.test.mjs */
import { readFileSync } from 'node:fs';

/* Lifted from the page so the test exercises the shipped function rather
   than a copy that can drift away from it. */
const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const src = page.slice(page.indexOf('function alertCat(inc){'), page.indexOf('/* Kept for the map'));
const alertCat = new Function(src + '; return alertCat;')();

/* Sliced to the blank line after the function rather than to a brace, which
   the ternary inside it made unreliable. */
const sevStart = page.indexOf('function severityRank(inc){');
const sevSrc = page.slice(sevStart, page.indexOf('\n}', sevStart) + 2);
const severityRank = new Function(src + sevSrc + '; return severityRank;')();

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

console.log('== the three levels are read, exactly ==');
[['Emergency Warning', 'Emergency Warning'],
 ['EMERGENCY WARNING', 'Emergency Warning'],
 ['Watch and Act', 'Watch and Act'],
 ['Watch & Act', 'Watch and Act'],
 ['Advice', 'Advice'],
 ['advice', 'Advice']].forEach(([raw, want]) => {
  check(JSON.stringify(raw) + ' -> ' + want, alertCat({ alertLevel: raw }) === want,
    alertCat({ alertLevel: raw }));
});

console.log('\n== an incident status is not an alert level ==');
/* Every one of these was previously rendered as a warning. */
[['GOING', 'SA CFS: fire is active'],
 ['SAFE', 'SA CFS'],
 ['CONTAINED', 'SA CFS'],
 ['PATROL', 'SA CFS'],
 ['Under control', 'VIC'],
 ['Out of control', 'VIC'],
 ['Contained', 'QLD'],
 ['All Clear', 'WA'],
 ['', 'field missing entirely']].forEach(([raw, who]) => {
  check(JSON.stringify(raw) + ' (' + who + ') carries no level',
    alertCat({ status: raw, alertLevel: '' }) === null, alertCat({ status: raw, alertLevel: '' }));
});

console.log('\n== "Not Applicable" means no warning, not a small one ==');
['Not Applicable', 'N/A', 'None', 'nil', 'no warning'].forEach(raw => {
  check(JSON.stringify(raw) + ' is the absence of a warning',
    alertCat({ alertLevel: raw }) === null, alertCat({ alertLevel: raw }));
});

console.log('\n== a level is not inferred from surrounding words ==');
/* Loose substring matching promoted these. "Emergency Services Attending"
   describes who is there, not what the public should do. */
[['Emergency Services Attending', 'Emergency Warning'],
 ['Emergency services on scene', 'Emergency Warning'],
 ['Going', 'Watch and Act'],
 ['Ongoing', 'Watch and Act'],
 ['Watching brief', 'Watch and Act']].forEach(([raw, mustNotBe]) => {
  check(JSON.stringify(raw) + ' is not read as ' + mustNotBe,
    alertCat({ status: raw, alertLevel: '' }) !== mustNotBe);
});

console.log('\n== unrated sorts last, without being called less severe ==');
const rank = v => severityRank({ alertLevel: v });
check('Emergency Warning first', rank('Emergency Warning') === 0);
check('then Watch and Act', rank('Watch and Act') === 1);
check('then Advice', rank('Advice') === 2);
check('unrated after all three', rank('') === 3);
check('and unrated is its own rank, not Advice', rank('') !== rank('Advice'));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
