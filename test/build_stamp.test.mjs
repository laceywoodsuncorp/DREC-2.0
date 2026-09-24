/* The page warns when the deployed Worker is older than itself, by comparing
   its own EXPECTED_WORKER_BUILD against the X-Worker-Build header. That only
   works while the two constants agree, and they are in different files that
   deploy together -- so bumping one and forgetting the other makes the page
   cry stale at a Worker that is perfectly current.

   Which is exactly what happened: the Worker moved through seven builds while
   the page stayed pinned to the first, and the dashboard told its reader to
   redeploy something that did not need redeploying. A warning that fires when
   nothing is wrong is worse than no warning, because the next real one gets
   ignored too.

   Run: node test/build_stamp.test.mjs */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');

const w = /const WORKER_BUILD\s*=\s*'([^']+)'/.exec(worker);
const p = /const EXPECTED_WORKER_BUILD\s*=\s*'([^']+)'/.exec(page);

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

console.log('== the page and the Worker agree on the build ==');
check('src/worker.js declares WORKER_BUILD', !!w);
check('the page declares EXPECTED_WORKER_BUILD', !!p);
check('and the two match', !!w && !!p && w[1] === p[1],
  { worker: w && w[1], page: p && p[1] });

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
