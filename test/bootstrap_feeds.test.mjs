/* Which feeds a cold start fetches.

   Without NEWS_KV every Cloudflare location keeps its own news record, so a
   reader routed to a cold one sees only what the bootstrap managed until the
   slow top-up fills the rest. That makes the bootstrap set the whole of the
   first impression, and it was chosen purely by list order.

   Two consequences, both observed live.

   insuranceNEWS sits at position 29 of 30 and is the ONLY source for the
   Insurance category, so that chip read "Insurance (3)" while 25 of 30
   sources were returning articles -- which looks like a quiet day in
   insurance rather than a feed that has not been fetched. On a dashboard
   built for an insurer that is a primary category, not a long tail.

   9News was marked priority and its configured address answers 404,
   measured by the live feed-health check. Priority feeds are the four the
   cold start fetches, so a quarter of that budget went to nothing.

   Run: node test/bootstrap_feeds.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error('not found in worker.js: ' + what);
  return m[0];
};

const NEWS_FEEDS = new Function(grab(/const NEWS_FEEDS = \[[\s\S]*?\n\];/, 'NEWS_FEEDS')
  + '; return NEWS_FEEDS;')();
const LIMIT = Number(/BOOTSTRAP_FEED_LIMIT = (\d+)/.exec(src)[1]);
const bootstrapFeeds = new Function('NEWS_FEEDS', 'BOOTSTRAP_FEED_LIMIT',
  grab(/function bootstrapFeeds\(\) \{[\s\S]*?\n\}/, 'bootstrapFeeds')
  + '; return bootstrapFeeds;')(NEWS_FEEDS, LIMIT);

const picked = bootstrapFeeds();
let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

console.log('picked: ' + picked.map((f) => f.name).join(', '));

console.log('\n== the category with a single source is always fetched ==');
ck('insuranceNEWS is in the bootstrap set',
  picked.some((f) => /insurancenews/.test(f.domain)), picked.map((f) => f.name));
ck('and it is the only trade feed, which is why that matters',
  NEWS_FEEDS.filter((f) => f.group === 'trade').length === 1,
  NEWS_FEEDS.filter((f) => f.group === 'trade').map((f) => f.name));

console.log('\n== the dead feed does not hold a slot ==');
/* Measured 404. Keeping the outlet is right; spending a quarter of the cold
   start on it is not. */
ck('9News is not fetched on a cold start',
  !picked.some((f) => f.domain === '9news.com.au'), picked.map((f) => f.name));
ck('but 9News is still configured, so the outlet is not lost',
  NEWS_FEEDS.some((f) => f.domain === '9news.com.au'));

console.log('\n== the set is still small and still varied ==');
ck('no more than the limit', picked.length <= LIMIT, { picked: picked.length, limit: LIMIT });
ck('at least three outlets', picked.length >= 3, picked.length);
/* One feed per outlet. Taking the first N in list order once spent two of
   three slots on ABC, which has two feeds, and a cold start that also lost
   SBS produced a page of nothing but ABC. */
const domains = picked.map((f) => f.domain);
ck('one feed per outlet', new Set(domains).size === domains.length, domains);
ck('more than one group represented',
  new Set(picked.map((f) => f.group)).size > 1, picked.map((f) => f.group));

console.log('\n== every picked feed is one that can work ==');
ck('all have a URL', picked.every((f) => /^https:\/\//.test(f.url || '')), picked.map((f) => f.url));
ck('none is the known-dead insuranceNEWS address',
  !picked.some((f) => /rss\/all-news/.test(f.url || '')), picked.map((f) => f.url));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
