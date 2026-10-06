/* Which side of a build mismatch is actually behind.

   The page and the Worker each carry a build stamp and the page warns when
   they differ. In both places it said so it asserted that the WORKER was the
   old one and told the reader to redeploy src/worker.js -- which it cannot
   know from a mismatch alone.

   The common case is the opposite. A push deploys the Worker immediately,
   while the page is an asset served from a per-datacentre cache, so a reader
   holds an older page against a current Worker. Observed exactly that way:
   the Worker reported 2026-10-06-sahonest, the newest build there was, and
   the page still told the reader it was out of date and to redeploy.

   Sending someone to redeploy a Worker that is already current, when the fix
   is to reload, is worse than saying nothing -- it is a confident answer
   pointing at the wrong thing. The stamps begin with the date they were cut,
   so the dates settle it, and two builds from the same day are admitted as
   unorderable rather than guessed at.

   Run: node test/build_skew.test.mjs */
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(page);
  if (!m) throw new Error('not found in the page: ' + what);
  return m[0];
};

/* buildSkew reads two outer variables, so they are supplied as parameters to
   the extracted copy rather than restating the function here. */
const make = new Function('EXPECTED_WORKER_BUILD', 'workerBuildSeen',
  grab(/function buildDate\(b\)\{[\s\S]*?\n  \}/, 'buildDate') + '\n' +
  grab(/function buildSkew\(\)\{[\s\S]*?\n  \}/, 'buildSkew') +
  '; return buildSkew;');
const skew = (pageBuild, workerBuild) => make(pageBuild, workerBuild)();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

console.log('== matching builds say nothing at all ==');
ck('identical stamps', skew('2026-10-06-sahonest', '2026-10-06-sahonest') === null);
ck('no worker build seen yet', skew('2026-10-06-sahonest', null) === null);

console.log('\n== the case that was observed: the page is the stale one ==');
const p1 = skew('2026-10-01-insnews', '2026-10-06-sahonest');
ck('identified as the page', p1 && p1.who === 'page', p1);
ck('tells the reader to reload', p1 && /reload/i.test(p1.short), p1 && p1.short);
ck('does NOT tell them to redeploy', p1 && !/redeploy/i.test(p1.short), p1 && p1.short);
ck('names the build they would get', p1 && p1.short.includes('2026-10-06-sahonest'), p1 && p1.short);

console.log('\n== the opposite case still works ==');
const w1 = skew('2026-10-06-sahonest', '2026-10-01-insnews');
ck('identified as the worker', w1 && w1.who === 'worker', w1);
ck('tells the reader to redeploy', w1 && /redeploy src\/worker\.js/.test(w1.short), w1 && w1.short);
ck('does NOT tell them to reload', w1 && !/reload/i.test(w1.short), w1 && w1.short);

console.log('\n== same day, different slug: unorderable, and said so ==');
/* Several builds a day is normal here, so this is not a corner case. Being
   wrong about the direction is what this file exists to prevent, and a
   confident guess between two same-day stamps would be exactly that. */
const u1 = skew('2026-10-06-tagging', '2026-10-06-sahonest');
ck('identified as unknown', u1 && u1.who === 'unknown', u1);
ck('claims neither direction', u1 && !/redeploy|reload/i.test(u1.short), u1 && u1.short);
ck('still names both builds',
  u1 && u1.short.includes('2026-10-06-tagging') && u1.short.includes('2026-10-06-sahonest'),
  u1 && u1.short);

console.log('\n== stamps without a parseable date ==');
/* An older Worker predating the stamp convention reports a placeholder. */
const n1 = skew('2026-10-06-sahonest', '(pre-build-stamp)');
ck('an unparseable stamp is unorderable, not assumed old', n1 && n1.who === 'unknown', n1);
ck('and does not send anyone anywhere', n1 && !/redeploy|reload/i.test(n1.short), n1 && n1.short);

console.log('\n== month and year boundaries ==');
ck('across a month', (skew('2026-09-30-x', '2026-10-01-y') || {}).who === 'page');
ck('across a year', (skew('2025-12-31-x', '2026-01-01-y') || {}).who === 'page');
ck('and the other way across a year', (skew('2026-01-01-y', '2025-12-31-x') || {}).who === 'worker');

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
