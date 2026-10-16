/* The cron schedule, and the two ceilings the refresh shape has to live
   inside.

   The scheduled handler turns the clock into a tick number, and that number
   is what rotates the news shards and the outage shards:

     const tick = Math.floor(nowMs / CRON_PERIOD_MS);

   If the cron fires faster than CRON_PERIOD_MS says, two consecutive firings
   compute the SAME tick. The same shard runs twice, the rotation never
   advances, and the feeds at every other position are never fetched at all.
   Nothing errors. The feed just quietly stops filling -- a failure this
   project has met more than once and is slow to spot.

   There are TWO ceilings, and only one of them was being watched.

   Subrequests: 50 external per invocation on the free plan. All three
   refreshes in one invocation measured 59, so the last fetches issued simply
   threw, which is what "some feeds populate and some never do" looked like.

   CPU: 10ms per invocation on the free plan. Fetching is I/O and costs none
   of it; PARSING is what spends it. This ceiling was never costed, and a
   change that gave outages their own every-minute trigger tripled the
   invocations doing that parsing (720/day to 2,160) while also doubling the
   parsing inside the main one. Cloudflare reported the account hitting the
   CPU limit. The second trigger is withdrawn, incidents are back to
   alternating with outages, and the assertions below exist so neither
   ceiling can be spent again without it showing up here.

   Run: node test/cron_period.test.mjs */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
/* The Worker with its comments removed, for the checks that must not be
   satisfied -- or broken -- by what a comment happens to say. The withdrawn
   second trigger is described at length in a comment, deliberately. */
const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const num = (re, what) => {
  const m = re.exec(worker);
  ck('the Worker declares ' + what, !!m);
  return m ? Number(m[1]) : 0;
};

/* Read the crons out of the jsonc without parsing it -- the file has
   comments, and a JSON parser would need them stripped first. */
const cronsM = /"crons"\s*:\s*\[([^\]]*)\]/.exec(wrangler);
ck('wrangler.jsonc declares crons', !!cronsM);
const crons = cronsM ? [...cronsM[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
console.log('  crons: ' + JSON.stringify(crons));
/* Exactly ONE. A second trigger dedicated to outages was added and withdrawn
   after the CPU limit was hit, so restoring it has to come back through this
   test rather than being a quiet edit to the config. */
ck('there is exactly one cron', crons.length === 1, crons);

const mainCronM = /const MAIN_CRON = '([^']+)'/.exec(worker);
ck('the Worker declares MAIN_CRON', !!mainCronM);
const mainCron = mainCronM ? mainCronM[1] : '';
const periodMs = num(/const CRON_PERIOD_MS = (\d+)/, 'CRON_PERIOD_MS');
console.log('  MAIN_CRON: ' + JSON.stringify(mainCron) + '   CRON_PERIOD_MS: ' + periodMs);

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
const mainMin = cronMinutes(mainCron);

console.log('\n== the string the handler matches is the string configured ==');
/* The handler decides what a firing is for by comparing event.cron against
   MAIN_CRON. If that stops matching, every firing takes the fallback branch
   -- which still works, but a schedule nobody can see is how this project
   has lost refresh paths before. */
ck('MAIN_CRON is the configured cron', crons.includes(mainCron), { mainCron, crons });
ck('the withdrawn outage-cron constants are gone from the code',
  !/const OUTAGE_CRON\b/.test(code) && !/const OUTAGE_CRON_PERIOD_MS\b/.test(code));

console.log('\n== the period matches the cron ==');
ck('the cron is a shape this test understands', mainMin !== null, mainCron);
ck('CRON_PERIOD_MS matches the cron', mainMin !== null && periodMs === mainMin * 60000,
  { mainCron, mainMin, periodMs });

console.log('\n== the handler uses the constants, not literals ==');
ck('the tick is derived from CRON_PERIOD_MS',
  /Math\.floor\(nowMs \/ CRON_PERIOD_MS\)/.test(worker));
/* Checked against the CODE, not the prose. The comments quote the old
   literals on purpose, to record what went wrong; a test that cannot tell an
   explanation from the thing it explains would force the explanation out. */
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

console.log('\n== the Worker starts the outage capture ==');
/* GitHub's scheduler ran this repo's scheduled jobs a median of 199 minutes
   late. The Worker's cron is the reliable clock, so it dispatches the
   capture. The cadence is in ticks, so it must be derived from the period
   -- the trap GDELT fell into when the cron sped up. */
{
  const day = /const CAPTURE_DAY_EVERY_TICKS = [^\n]*CRON_PERIOD_MS/.test(worker);
  const night = /const CAPTURE_NIGHT_EVERY_TICKS = [^\n]*CRON_PERIOD_MS/.test(worker);
  ck('the daytime capture cadence is derived from the period', day);
  ck('and the overnight one', night);
  const dayTicks = Math.max(1, Math.round(30 * 60000 / periodMs));
  const nightTicks = Math.max(1, Math.round(120 * 60000 / periodMs));
  ck('which works out to every 30 minutes by day', dayTicks * periodMs === 30 * 60000, dayTicks);
  ck('and every 2 hours overnight', nightTicks * periodMs === 120 * 60000, nightTicks);
  /* Only when there is something to capture for, and a credential to do it
     with -- and never in live mode, where the Worker fetches outages itself. */
  ck('dispatch is gated on capture mode and the secret',
    /!outageLiveFetch\(env\) && env && env\.GITHUB_DISPATCH_TOKEN && captureDue\(tick, nowMs\)/.test(code));
  ck('the token is a secret read from env, never a literal in the source',
    !/github_pat_[A-Za-z0-9_]{20,}/.test(worker) && !/ghp_[A-Za-z0-9]{20,}/.test(worker));
}

console.log('\n== incidents and outages alternate, which halves BOTH ceilings ==');
/* Not only subrequests. Parsing eight incident feeds next to four states of
   outage data is also the CPU cost, against 10ms. Running incidents on every
   tick is what this did until the CPU limit was hit. */
ck('the refreshes alternate by tick parity', /tick % 2 === 0/.test(code));
ck('incidents are on one parity',
  /tick % 2 === 0\)\s*\{[\s\S]{0,160}?refreshAllIncidents/.test(code));
/* Outages on the other parity -- but only when the Worker fetches them
   live. By default it serves a capture made on a runner, because outage
   parsing measured at hundreds of milliseconds against a 10ms allowance,
   and the odd tick is then news alone. */
ck('outages are on the other parity, behind the live-fetch switch',
  /\} else if \(outageLiveFetch\(env\)\) \{[\s\S]{0,200}?refreshOutageShard/.test(code));
ck('and nowhere in the scheduled handler is an outage shard refreshed unconditionally',
  !/\} else \{\s*ctx\.waitUntil\(refreshOutageShard/.test(code));
ck('news runs on every tick',
  /refreshNewsShard\(tick % NEWS_SHARDS/.test(code));
/* The regression to guard against by name: incidents unconditionally on
   every tick, which is twice the CPU for freshness nobody asked for. */
ck('incidents are NOT queued unconditionally every tick',
  !/refreshNewsShard\([^)]*\)\);\s*ctx\.waitUntil\(refreshAllIncidents\(\)\);/.test(code));

console.log('\n== what the cadence actually is ==');
const OUTAGE_SHARDS = num(/const OUTAGE_SHARDS = (\d+)/, 'OUTAGE_SHARDS');
const NEWS_SHARDS = num(/const NEWS_SHARDS = (\d+)/, 'NEWS_SHARDS');
const everyState = mainMin * 2 * OUTAGE_SHARDS;
const everyIncident = mainMin * 2;
const everyFeed = mainMin * NEWS_SHARDS;
console.log('  a given state\'s outages: every ' + everyState + ' min');
console.log('  all incident feeds:      every ' + everyIncident + ' min');
console.log('  a given news feed:       every ' + everyFeed + ' min');
/* The original was a 5-minute cron: outages every 20 minutes, incidents
   every 10. The CPU revert gave back today's gains, not the ones before it,
   so this must stay better than the original. */
ck('outages stay better than the original 20 minutes', everyState <= 8, everyState);
ck('incidents stay better than the original 10 minutes', everyIncident <= 4, everyIncident);

console.log('\n== the ceiling that was actually hit: CPU per invocation ==');
const perDay = Math.round((24 * 60) / mainMin);
console.log('  invocations/day: ' + perDay);
ck('invocations stay well inside the 100,000/day request allowance',
  perDay < 100000 / 10, perDay);
/* CPU is spent per invocation, on parsing, so the count of invocations doing
   it is the number that matters. It reached 2,160 with a second trigger and
   is back to 720 -- the level that ran for days without a CPU complaint. */
ck('invocations/day are back to the level that ran without a CPU complaint',
  perDay <= 720, perDay);

/* KV applies to the NEWS record only; the outage path never writes it. */
const newsWritesPerDay = perDay;
console.log('  KV writes/day (news only): ' + newsWritesPerDay);
ck('one KV write per tick stays under the 1,000/day free limit',
  newsWritesPerDay <= 1000, { newsWritesPerDay, limit: 1000 });
ck('the outage path writes no KV',
  !/refreshStateOutages[\s\S]{0,4000}?NEWS_KV/.test(worker));

console.log('\n== the other ceiling: 50 external subrequests per invocation ==');
/* Counted from the shipped config rather than from a comment, because the
   comment was written once and the config changes every time an operator is
   added. Worst case assumes every endpoint is tried -- which is what happens
   when each fails and falls through to the next.

   A floor, not the truth: it cannot see a feed's discovery attempt or a
   merge source, and measures about six under what the handler really does
   (test/worker_outages.test.mjs measures the real figure). It is kept
   because it is what rises the moment the config grows. */
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
const shardCost = [];
for (let sh = 0; sh < OUTAGE_SHARDS; sh++) {
  shardCost.push(OUTAGE_STATES.filter((_, i) => i % OUTAGE_SHARDS === sh)
    .reduce((n, st) => n + endpointsFor(st), 0));
}
const worstShard = Math.max(...shardCost);
const incBlock = grab(/const INCIDENT_FEEDS = \{[\s\S]*?\n\};/, 'INCIDENT_FEEDS');
const INCIDENT_FEEDS = new Function(stub(incBlock) + incBlock + '; return INCIDENT_FEEDS;')();
const incidentCost = Object.values(INCIDENT_FEEDS)
  .reduce((n, f) => n + (f.sources || []).length, 0);
const feedsBlock = grab(/const NEWS_FEEDS = \[[\s\S]*?\n\];/, 'NEWS_FEEDS');
const NEWS_FEEDS = new Function(feedsBlock + '; return NEWS_FEEDS;')();
const newsCost = Math.ceil(NEWS_FEEDS.length / NEWS_SHARDS) + 1;

console.log('  outage endpoints per shard: ' + JSON.stringify(shardCost)
  + '  (all states: ' + OUTAGE_STATES.reduce((n, s) => n + endpointsFor(s), 0) + ')');
console.log('  incident endpoints: ' + incidentCost + '   news per shard: ' + newsCost);
const evenTick = newsCost + incidentCost + 1;   // news + incidents + gdelt
const oddTick = newsCost + worstShard;          // news + one outage shard
console.log('  even tick (news + incidents + gdelt): ' + evenTick);
console.log('  odd tick  (news + outage shard):      ' + oddTick);
ck('the incident tick fits', evenTick <= 50, { evenTick, limit: 50 });
ck('the outage tick fits', oddTick <= 50, { oddTick, limit: 50 });
/* Margin, allowing for the known undercount. */
ck('the incident tick keeps a real margin', evenTick + 8 <= 42, evenTick);
ck('the outage tick keeps a real margin', oddTick + 8 <= 42, oddTick);
/* Why they alternate at all. If all three fitted comfortably, the
   alternation would be unnecessary -- it does not, on either ceiling. */
console.log('  all three together: ' + (evenTick + worstShard) + ' (measured 59)');
ck('all three together do NOT fit, which is why they alternate',
  evenTick + worstShard > 50, { combined: evenTick + worstShard });

console.log('\n== what a READER sees, which the cron does not decide ==');
{
  /* The cron runs in one datacentre and the Cache API is per datacentre, so
     a faster cron makes outages fresher there and nowhere else. Everywhere
     else it is the warm sweep on the reader's own traffic.

     That sweep runs inside a VISITOR's invocation and spends that
     invocation's CPU parsing outage data. OUTAGE_STALE_S was briefly
     lowered to 4 minutes, which is where the sweep's rate limit rather than
     the threshold becomes the constraint -- right for subrequests and for
     upstream politeness, wrong for CPU: at 15 minutes most sweeps find
     nothing to do and cost nothing, at 4 minutes a sweep has work almost
     every time, on page loads. It is the one of today's changes that spent
     CPU on the REQUEST path. */
  const staleM = /const OUTAGE_STALE_S = ([^;]+);/.exec(worker);
  ck('the Worker declares OUTAGE_STALE_S', !!staleM);
  const staleS = staleM ? Function('return ' + staleM[1])() : 0;
  const perReq = num(/const OUTAGE_WARM_PER_REQUEST = (\d+)/, 'OUTAGE_WARM_PER_REQUEST');
  const minIntervalS = num(/const OUTAGE_WARM_MIN_INTERVAL_S = (\d+)/, 'OUTAGE_WARM_MIN_INTERVAL_S');

  const floorS = Math.ceil(OUTAGE_STATES.length / perReq) * minIntervalS;
  console.log('  ' + OUTAGE_STATES.length + ' states, ' + perReq + ' per sweep, one sweep per '
    + minIntervalS + 's  ->  floor on a full pass: ' + floorS + 's');
  console.log('  staleness threshold: ' + staleS + 's');
  /* Promising more than the rate limit can deliver would make the number
     fiction. This direction still holds. */
  ck('the threshold does not promise more than the sweep can deliver',
    staleS >= floorS, { staleS, floorS });
  /* And the CPU bound, which is why it is not set to the floor: a visitor's
     invocation must not be parsing outage data on most page loads. */
  ck('the threshold stays high enough that most sweeps find nothing to do',
    staleS >= floorS * 2, { staleS, floorS });

  const fetchesPerMin = perReq * (60 / minIntervalS);
  console.log('  upstream: at most ' + fetchesPerMin + ' states/min per datacentre');
  ck('the sweep stays polite to the operators', fetchesPerMin <= 4, fetchesPerMin);
  const worstStates = OUTAGE_STATES.map((st) => endpointsFor(st))
    .sort((a, b) => b - a).slice(0, perReq).reduce((a, b) => a + b, 0);
  console.log('  worst warm sweep: ' + worstStates + ' endpoints inside a visitor request');
  ck('a warm sweep fits inside a visitor invocation', worstStates <= 34, worstStates);
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
