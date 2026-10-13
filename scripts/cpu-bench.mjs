/* Where the Worker's CPU actually goes.

   Cloudflare's daily summary: "Your Workers hit the free tier CPU time
   limit at least 100+ times in the past 24 hours", and when a Worker hits
   it Cloudflare stops it mid-task -- which shows up as broken pages and
   failed API calls, not as a log line.

   The free plan allows 10ms of CPU per invocation. CPU is not wall time:
   waiting on fetch costs none of it. PARSING is what spends it, and this
   Worker parses a great deal -- eight incident feeds, four states of
   outage data scraped out of HTML tables, eight RSS feeds, and an
   aggregate rebuilt by re-parsing eight cached payloads.

   Every previous argument about budgets on this project was made about
   subrequests, which are easy to count from the config. CPU cannot be
   counted that way, so it was never counted at all. This measures it.

   process.cpuUsage() is the right instrument: it reports CPU consumed,
   excluding time blocked on I/O, which is the same thing Cloudflare bills.
   Node is not workerd and the absolute numbers will not match exactly --
   but a path that burns 40ms of CPU here is not fitting in 10ms there, and
   the RANKING of the costs is what tells us where to cut.

   Run on a runner, which can reach the agencies:
     node scripts/cpu-bench.mjs        (writes data/cpu-bench.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

/* Cache mock: per-process, so a run starts cold and each measurement says
   what a cold invocation costs. */
const store = new Map();
globalThis.caches = {
  default: {
    async match(url) {
      const e = store.get(url);
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
    async put(url, res) {
      store.set(url, { body: await res.text(), headers: Object.fromEntries(res.headers) });
    }
  }
};

const realFetch = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (...args) => { fetchCount++; return realFetch(...args); };

const worker = (await import('../src/worker.js')).default;
const env = { ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

const CEILING_MS = 10; // Workers free plan, per invocation

/* Measures CPU across an async operation INCLUDING the background work it
   queues, because ctx.waitUntil work is billed to the same invocation --
   which is the whole reason warming on the request path matters. */
async function cpu(label, fn) {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  fetchCount = 0;
  const before = process.cpuUsage();
  const t0 = Date.now();
  let err = null;
  try {
    await fn(ctx);
    await Promise.allSettled(waits);
  } catch (e) { err = e.message; }
  const d = process.cpuUsage(before);
  const ms = (d.user + d.system) / 1000;
  const row = {
    label, cpuMs: Math.round(ms * 10) / 10, wallMs: Date.now() - t0,
    subrequests: fetchCount, overCeiling: ms > CEILING_MS, error: err
  };
  console.log('  ' + (row.overCeiling ? 'OVER ' : '     ')
    + String(row.cpuMs).padStart(8) + 'ms cpu  '
    + String(row.wallMs).padStart(6) + 'ms wall  '
    + String(row.subrequests).padStart(3) + ' fetches   ' + label
    + (err ? '   ERROR: ' + err : ''));
  return row;
}

const report = { at: new Date().toISOString(), ceilingMs: CEILING_MS, rows: [] };
const add = async (l, f) => { report.rows.push(await cpu(l, f)); };

const MAIN_CRON = '*/2 * * * *';
const sched = (tick) => (ctx) =>
  worker.scheduled({ scheduledTime: tick * 120000, cron: MAIN_CRON }, env, ctx);

console.log('\n== one scheduled invocation, cold ==');
/* Both parities. Even runs the incident sweep, odd an outage shard. */
await add('cron tick, even parity (news shard + all 8 incident feeds)', sched(1000));
await add('cron tick, odd parity (news shard + one outage shard)', sched(1001));

console.log('\n== the same, warm (what a steady-state tick costs) ==');
await add('cron tick, even parity (warm)', sched(1002));
await add('cron tick, odd parity (warm)', sched(1003));

console.log('\n== each incident state on its own, cold ==');
/* Isolates the parse. A state refresh is one or two fetches and then
   whatever its parser does with the body. */
const STATES = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'nt', 'act'];
for (const s of STATES) {
  store.clear();
  await add('incidents: ' + s, (ctx) =>
    worker.fetch(new Request('https://x.test/api/incidents/' + s), env, ctx));
}

console.log('\n== each outage state on its own, cold ==');
for (const s of STATES) {
  store.clear();
  await add('outages: ' + s, (ctx) =>
    worker.fetch(new Request('https://x.test/api/outages/' + s), env, ctx));
}

console.log('\n== the request paths a reader actually hits ==');
/* These are the ones that become "broken pages" when they are cut off
   mid-task, so they matter more than the cron does. */
store.clear();
await add('GET /api/outages (cold: warms behind the response)', (ctx) =>
  worker.fetch(new Request('https://x.test/api/outages'), env, ctx));
await add('GET /api/outages (warm)', (ctx) =>
  worker.fetch(new Request('https://x.test/api/outages'), env, ctx));
await add('GET /api/incidents (all states, from cache)', (ctx) =>
  worker.fetch(new Request('https://x.test/api/incidents'), env, ctx));
store.clear();
await add('GET /api/news (cold: bootstraps feeds)', (ctx) =>
  worker.fetch(new Request('https://x.test/api/news'), env, ctx));
await add('GET /api/news (warm)', (ctx) =>
  worker.fetch(new Request('https://x.test/api/news'), env, ctx));

console.log('\n================ the verdict ================');
const over = report.rows.filter((r) => r.overCeiling);
const worst = report.rows.slice().sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 6);
console.log('over the ' + CEILING_MS + 'ms ceiling: ' + over.length + ' of ' + report.rows.length);
over.forEach((r) => console.log('  OVER  ' + String(r.cpuMs).padStart(8) + 'ms  ' + r.label));
console.log('\nmost expensive, in order:');
worst.forEach((r) => console.log('  ' + String(r.cpuMs).padStart(8) + 'ms  ' + r.label));

/* The split that decides the fix. If the cron is over and the request
   paths are not, this is a scheduling problem and sharding solves it. If
   the REQUEST paths are over, readers are getting broken pages and no
   amount of rescheduling helps -- the parse itself has to get cheaper or
   move off the request path. */
const cronOver = over.filter((r) => /cron tick/.test(r.label)).length;
const readOver = over.filter((r) => /^GET /.test(r.label)).length;
console.log('\nscheduled invocations over the ceiling: ' + cronOver);
console.log('reader request paths over the ceiling:  ' + readOver
  + (readOver ? '   <- these are the broken pages' : ''));
console.log('\nNote: Node, not workerd. Treat the ranking as sound and the'
  + '\nabsolute numbers as indicative.');

report.summary = { over: over.length, total: report.rows.length, cronOver, readOver };
mkdirSync(new URL('../data', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/cpu-bench.json', import.meta.url), JSON.stringify(report, null, 1));
console.log('\nwrote data/cpu-bench.json');
