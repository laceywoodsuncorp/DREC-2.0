/* The cron schedule and the tick counter have to agree.

   The scheduled handler turns the clock into a tick number, and that number
   is what rotates the news shards and alternates the incident and outage
   refreshes:

     const tick = Math.floor(nowMs / CRON_PERIOD_MS);

   If the cron fires faster than CRON_PERIOD_MS says, two consecutive
   firings compute the SAME tick. The same shard runs twice, the rotation
   never advances, and the feeds at every other position are never fetched
   at all. Nothing errors. The feed just quietly stops filling -- which is a
   failure this project has met more than once and is slow to spot.

   The number used to be written out as 300000 in the handler, five hundred
   lines from the cron in wrangler.jsonc that produced it. Two places that
   must agree, with nothing checking. This is the check.

   Run: node test/cron_period.test.mjs */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

/* Read the cron out of the jsonc without parsing it -- the file has
   comments, and a JSON parser would need them stripped first. */
const cronM = /"crons"\s*:\s*\[\s*"([^"]+)"/.exec(wrangler);
ck('wrangler.jsonc declares a cron', !!cronM);
const cron = cronM ? cronM[1] : '';
console.log('  cron: ' + JSON.stringify(cron));

const constM = /const CRON_PERIOD_MS = (\d+)/.exec(worker);
ck('the Worker declares CRON_PERIOD_MS', !!constM);
const periodMs = constM ? Number(constM[1]) : 0;
console.log('  CRON_PERIOD_MS: ' + periodMs);

/* Minutes between firings, for the two shapes this project uses: a
   step minute field (star slash N) and a fixed minute. Anything else is
   rejected rather than guessed at -- a wrong period here is worse than no
   check at all.

   Written out in words because the literal step syntax contains the
   characters that end a block comment, which is how the first version of
   this file failed to parse. */
function cronMinutes(expr) {
  const minuteField = String(expr).trim().split(/\s+/)[0];
  if (/^\*\/(\d+)$/.test(minuteField)) return Number(/^\*\/(\d+)$/.exec(minuteField)[1]);
  if (/^\*$/.test(minuteField)) return 1;
  if (/^\d+$/.test(minuteField)) return 60;
  return null;
}
const minutes = cronMinutes(cron);
ck('the cron minute field is a shape this test understands', minutes !== null, cron);
console.log('  fires every: ' + minutes + ' min');

console.log('\n== the two agree ==');
ck('CRON_PERIOD_MS matches the cron',
  minutes !== null && periodMs === minutes * 60000,
  { cron, minutes, periodMs, expected: minutes === null ? null : minutes * 60000 });

console.log('\n== the handler uses the constant, not a literal ==');
ck('tick is derived from CRON_PERIOD_MS',
  /Math\.floor\(nowMs \/ CRON_PERIOD_MS\)/.test(worker));
/* The old literal must not come back anywhere in the scheduling path. */
ck('no bare 300000 left in the scheduled handler',
  !/const tick = Math\.floor\(nowMs \/ \d+\)/.test(worker));

console.log('\n== the limits this cadence has to live inside ==');
const perDay = minutes === null ? null : Math.round((24 * 60) / minutes);
console.log('  invocations/day: ' + perDay);
/* Cloudflare free plan: 100,000 requests a day, and a cron firing counts.
   Nowhere near binding, but asserted so a much faster cron cannot be set
   without someone seeing the number. */
ck('invocations stay well inside the daily request allowance',
  perDay !== null && perDay < 100000 / 10, perDay);

/* The real ceiling once NEWS_KV is bound. The news refresh writes one KV
   record per tick, and the free plan allows 1,000 writes a day. At two
   minutes that is 720 -- fine. At one minute it would be 1,440, which
   exceeds it, and the news record would simply stop updating partway
   through each day. Worth failing here rather than discovering it as an
   afternoon of stale headlines. */
ck('one KV write per tick stays under the 1,000/day free limit',
  perDay !== null && perDay <= 1000, { perDay, limit: 1000 });
if (perDay !== null && perDay > 700) {
  console.log('  note: ' + perDay + ' writes/day is ' + Math.round(perDay / 10)
    + '% of the KV free-tier allowance; a faster cron needs the paid plan.');
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
