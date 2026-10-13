/* The cron schedules and the code that reads them have to agree.

   The scheduled handler turns the clock into a tick number, and that number
   is what rotates the news shards and the outage shards:

     const tick = Math.floor(nowMs / CRON_PERIOD_MS);

   If a cron fires faster than its period says, two consecutive firings
   compute the SAME tick. The same shard runs twice, the rotation never
   advances, and the feeds at every other position are never fetched at all.
   Nothing errors. The feed just quietly stops filling -- which is a failure
   this project has met more than once and is slow to spot.

   There are now TWO triggers, which adds a second way to fail silently: the
   handler decides what a firing is for by matching event.cron against a
   string constant, so a schedule edited in wrangler.jsonc and not in the
   Worker would mean a whole refresh path doing nothing. Both strings are
   checked here.

   Why two triggers at all: the 50-external-subrequest ceiling is per
   INVOCATION, not per day. A second schedule therefore comes with its own
   budget rather than dividing the first, which is what lets outages refresh
   every 2 minutes instead of every 8 while the peak per invocation goes
   DOWN. The daily allowance was never the constraint -- 2,160 invocations
   against 100,000.

   The last section is the one that earns its keep over time: it adds up the
   worst-case endpoint count from the real config and fails if either
   invocation could exceed 50. Adding an operator or a feed is a one-line
   change, and the limit it eats into is five hundred lines away.

   Run: node test/cron_period.test.mjs */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
/* The Worker with its comments removed, for the checks that must not be
   satisfied -- or broken -- by what a comment happens to say. */
const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

/* Read the crons out of the jsonc without parsing it -- the file has
   comments, and a JSON parser would need them stripped first. */
const cronsM = /"crons"\s*:\s*\[([^\]]*)\]/.exec(wrangler);
ck('wrangler.jsonc declares crons', !!cronsM);
const crons = cronsM ? [...cronsM[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
console.log('  crons: ' + JSON.stringify(crons));
ck('there are exactly two', crons.length === 2, crons);

const num = (re, what) => {
  const m = re.exec(worker);
  ck('the Worker declares ' + what, !!m);
  return m ? Number(m[1]) : 0;
};
const str = (re, what) => {
  const m = re.exec(worker);
  ck('the Worker declares ' + what, !!m);
  return m ? m[1] : '';
};

const periodMs = num(/const CRON_PERIOD_MS = (\d+)/, 'CRON_PERIOD_MS');
const outagePeriodMs = num(/const OUTAGE_CRON_PERIOD_MS = (\d+)/, 'OUTAGE_CRON_PERIOD_MS');
const mainCron = str(/const MAIN_CRON = '([^']+)'/, 'MAIN_CRON');
const outageCron = str(/const OUTAGE_CRON = '([^']+)'/, 'OUTAGE_CRON');
console.log('  CRON_PERIOD_MS: ' + periodMs + '   OUTAGE_CRON_PERIOD_MS: ' + outagePeriodMs);

/* Minutes between firings, for the two shapes this project uses: a step
   minute field (star slash N) and a bare star. Anything else is rejected
   rather than guessed at -- a wrong period here is worse than no check.

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

console.log('\n== the strings the handler matches are the strings configured ==');
/* This is the new failure mode. If event.cron stops matching, the branch for
   that schedule never runs and the refresh it owns silently stops. */
ck('MAIN_CRON is one of the configured crons', crons.includes(mainCron), { mainCron, crons });
ck('OUTAGE_CRON is one of the configured crons', crons.includes(outageCron), { outageCron, crons });
ck('and they are different schedules', mainCron !== outageCron, { mainCron, outageCron });
ck('between them they account for every configured cron',
  crons.every((c) => c === mainCron || c === outageCron), crons);

console.log('\n== each period matches its own cron ==');
const mainMin = cronMinutes(mainCron);
const outageMin = cronMinutes(outageCron);
ck('the main cron is a shape this test understands', mainMin !== null, mainCron);
ck('the outage cron is a shape this test understands', outageMin !== null, outageCron);
ck('CRON_PERIOD_MS matches the main cron', mainMin !== null && periodMs === mainMin * 60000,
  { mainCron, mainMin, periodMs });
ck('OUTAGE_CRON_PERIOD_MS matches the outage cron',
  outageMin !== null && outagePeriodMs === outageMin * 60000,
  { outageCron, outageMin, outagePeriodMs });

console.log('\n== the handler uses the constants, not literals ==');
ck('the main tick is derived from CRON_PERIOD_MS',
  /Math\.floor\(nowMs \/ CRON_PERIOD_MS\)/.test(worker));
/* The outage shard MUST be counted in its own period. Counted in the main
   one it would hold the same shard for two firings and the other shard
   would never be refreshed -- the exact silent-stall this file exists for. */
ck('the outage tick is derived from OUTAGE_CRON_PERIOD_MS',
  /Math\.floor\(nowMs \/ OUTAGE_CRON_PERIOD_MS\)/.test(worker));
/* Checked against the CODE, not the prose. The comment above the constant
   quotes the old literal on purpose, to record what went wrong; a test that
   cannot tell an explanation from the thing it explains would force the
   explanation to be deleted. */
ck('no bare literal period left in the scheduled handler',
  !/Math\.floor\(nowMs \/ \d+\)/.test(code), (/Math\.floor\(nowMs \/ \d+\)/.exec(code) || [])[0]);
/* "Hourly" written as a tick count was 12 at a five-minute cron and became
   every 24 minutes when the cron sped up. Anything tied to wall-clock time
   has to be computed from the period. */
ck('the GDELT interval is derived from the period, not written out',
  /const GDELT_EVERY_TICKS = [^\n]*CRON_PERIOD_MS/.test(worker));
const gdeltTicks = Math.max(1, Math.round(3600000 / periodMs));
ck('and it still works out to about an hour',
  Math.abs(gdeltTicks * periodMs - 3600000) < 60000, { gdeltTicks, periodMs });

console.log('\n== outages get their own invocation, and nothing else shares it ==');
ck('the outage cron returns before the news and incident work',
  /cron === OUTAGE_CRON\)\s*\{[\s\S]{0,400}?refreshOutageShard[\s\S]{0,200}?return;/.test(worker));
/* Incidents alternated with outages only because they shared an invocation.
   With outages moved off, holding them to every other tick would be giving
   up the improvement for no reason. */
ck('incidents now run on every main tick',
  /ctx\.waitUntil\(refreshAllIncidents\(\)\);/.test(worker)
  && !/tick % 2 === 0\)\s*\{\s*ctx\.waitUntil\(refreshAllIncidents/.test(worker));
/* An unmatched cron must degrade to the OLD alternating shape, which is
   known to fit, and never to "run all three". The first version of this
   fallback did run all three and measured 59 subrequests against a ceiling
   of 50 -- it reproduced the starvation it was written to prevent, and
   test/worker_outages.test.mjs caught it because that test fires
   scheduled() without a cron and so exercises this very branch. */
const elseBranch = /cron === MAIN_CRON\)\s*\{[\s\S]*?\n    \} else \{([\s\S]*?)\n    \}/.exec(code);
ck('there is a fallback branch for an unrecognised cron', !!elseBranch);
const fb = elseBranch ? elseBranch[1] : '';
ck('the fallback still refreshes outages', /refreshOutageShard/.test(fb), fb.slice(0, 160));
ck('and still refreshes incidents', /refreshAllIncidents/.test(fb), fb.slice(0, 160));
ck('but ALTERNATES them rather than running both', /tick % 2 === 0/.test(fb), fb.slice(0, 160));

console.log('\n== what the cadence actually is now ==');
const OUTAGE_SHARDS = num(/const OUTAGE_SHARDS = (\d+)/, 'OUTAGE_SHARDS');
const NEWS_SHARDS = num(/const NEWS_SHARDS = (\d+)/, 'NEWS_SHARDS');
const everyState = outageMin * OUTAGE_SHARDS;
const everyFeed = mainMin * NEWS_SHARDS;
console.log('  a given state\'s outages: every ' + everyState + ' min');
console.log('  a given news feed:       every ' + everyFeed + ' min');
console.log('  all incident feeds:      every ' + mainMin + ' min');
/* The point of the change. Outages were every 8 minutes; anything slower
   than that would be a regression dressed as a refactor. */
ck('a state\'s outages refresh at least every 4 minutes', everyState <= 4, everyState);
ck('incidents refresh at least every 2 minutes', mainMin <= 2, mainMin);

console.log('\n== the limits this cadence has to live inside ==');
const perDay = Math.round((24 * 60) / mainMin) + Math.round((24 * 60) / outageMin);
console.log('  invocations/day (both crons): ' + perDay);
ck('invocations stay well inside the 100,000/day request allowance',
  perDay < 100000 / 10, perDay);

/* The KV ceiling applies to the NEWS record only -- the outage path never
   writes KV, which is why it can fire every minute. Once NEWS_KV is bound
   the news refresh writes one record per MAIN tick, against 1,000/day free. */
const newsWritesPerDay = Math.round((24 * 60) / mainMin);
console.log('  KV writes/day (news only):   ' + newsWritesPerDay);
ck('one KV write per main tick stays under the 1,000/day free limit',
  newsWritesPerDay <= 1000, { newsWritesPerDay, limit: 1000 });
ck('the outage path writes no KV, which is what lets it fire every minute',
  !/refreshStateOutages[\s\S]{0,4000}?NEWS_KV/.test(worker));

console.log('\n== the real ceiling: 50 external subrequests per invocation ==');
/* Counted from the shipped config rather than from a comment, because the
   comment was written once and the config changes every time an operator is
   added. Worst case assumes every endpoint is tried -- which is what happens
   when each one fails and falls through to the next. */
const stub = (block) => {
  const names = new Set([...block.matchAll(/parse: (\w+)/g)].map((m) => m[1]));
  return [...names].map((n) => 'const ' + n + '=()=>{};').join('\n') + '\n';
};
const grab = (re, what) => {
  const m = re.exec(worker);
  if (!m) throw new Error('not found in worker.js: ' + what);
  return m[0];
};

const netBlock = grab(/export const OUTAGE_NETWORKS = \{[\s\S]*?\n\};/, 'OUTAGE_NETWORKS');
const NETWORKS = new Function(stub(netBlock) + netBlock.replace('export ', '')
  + '; return OUTAGE_NETWORKS;')();
const OUTAGE_STATES = new Function(grab(/const OUTAGE_STATES = [^;]*;/, 'OUTAGE_STATES')
  + '; return OUTAGE_STATES;')();
const endpointsFor = (st) => {
  const v = NETWORKS[st];
  const arr = Array.isArray(v) ? v : (v && (v.networks || Object.values(v))) || [];
  return (Array.isArray(arr) ? arr : []).reduce((n, op) =>
    n + (op.endpoints ? op.endpoints.length : (op.sources ? op.sources.length : (op.url ? 1 : 0))), 0);
};
/* Shards are assigned by index, exactly as refreshOutageShard does it. */
const shardCost = [];
for (let sh = 0; sh < OUTAGE_SHARDS; sh++) {
  shardCost.push(OUTAGE_STATES.filter((_, i) => i % OUTAGE_SHARDS === sh)
    .reduce((n, st) => n + endpointsFor(st), 0));
}
const worstShard = Math.max(...shardCost);
console.log('  outage endpoints per shard: ' + JSON.stringify(shardCost)
  + '  (all states: ' + OUTAGE_STATES.reduce((n, s) => n + endpointsFor(s), 0) + ')');
ck('the worst outage shard fits in one invocation', worstShard <= 50, { shardCost, limit: 50 });
/* Leaving headroom, not just fitting. An operator added tomorrow should not
   be the thing that silently starves a fetch. */
ck('and leaves at least a third of the budget free', worstShard <= 34, worstShard);

const incBlock = grab(/const INCIDENT_FEEDS = \{[\s\S]*?\n\};/, 'INCIDENT_FEEDS');
const INCIDENT_FEEDS = new Function(stub(incBlock) + incBlock + '; return INCIDENT_FEEDS;')();
const incidentCost = Object.values(INCIDENT_FEEDS)
  .reduce((n, f) => n + (f.sources || []).length, 0);
const feedsBlock = grab(/const NEWS_FEEDS = \[[\s\S]*?\n\];/, 'NEWS_FEEDS');
const NEWS_FEEDS = new Function(feedsBlock + '; return NEWS_FEEDS;')();
/* The news shard, plus the one discovery attempt a tick makes, plus the
   hourly GDELT fetch which lands on a main tick. */
const newsCost = Math.ceil(NEWS_FEEDS.length / NEWS_SHARDS) + 1;
const mainCost = newsCost + incidentCost + 1;
/* A FLOOR, not the true cost. Counting the config cannot see the extra
   fetches a run makes -- a feed's discovery attempt, a merge source added
   to a state that already succeeded, a redirect followed. Measured against
   the real handler in test/worker_outages.test.mjs the main cron comes to
   35-37 where this arithmetic says 31, so this number is about six light.
   It is kept because it is the one that rises the moment an operator or a
   feed is added to the config, which is the change that would eat the
   margin; the measured figure is the one to trust for how close we are. */
console.log('  main invocation, counted from config: ' + newsCost + ' news + ' + incidentCost
  + ' incidents + 1 gdelt = ' + mainCost + '  (measured: 35-37)');
ck('the main invocation fits in one invocation', mainCost <= 50, { mainCost, limit: 50 });
/* 42 leaves the same 8-subrequest margin the measured test insists on,
   against a count known to run about six under. */
ck('and leaves a real margin once the undercount is allowed for',
  mainCost + 8 <= 42, { mainCost, allowedFloor: 34 });
/* The number that broke it before. Both paths together exceeded the limit,
   which is precisely why they are now two invocations. */
console.log('  both together, counted from config: ' + (mainCost + worstShard)
  + '  (measured: 59) -- over the limit, which is why they are separate invocations');
/* The justification for two triggers rather than one. If this ever comes
   comfortably under 50, the split is unnecessary complexity and should go. */
ck('the two paths together do NOT fit in one invocation',
  mainCost + worstShard > 50, { combined: mainCost + worstShard });

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
