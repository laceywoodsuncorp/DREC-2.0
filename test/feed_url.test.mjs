/* Feed addresses that are known-dead, asserted against the configured list.

   A broken RSS feed is the quietest failure in this project. The Worker
   fetches it, gets a 404, records the error on that one entry and carries
   on -- which is the right behaviour, but it means the dashboard looks
   normal and simply never shows that outlet again. Nobody notices until
   they go looking for a story they know was published.

   insuranceNEWS has now been lost twice this way, both times on the same
   URL. It is '/rss/all'; '/rss/all-news' 404s. The site's own homepage
   declares the correct one via <link rel="alternate">, and the probe in
   data/feed-probe.json records /rss/all returning 200 with 20 items and
   /rss/all-news returning 404.

   This file exists so a third time fails in CI in under a second instead
   of silently in production.

   Run: node test/feed_url.test.mjs */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

/* Read the configured feed URLs out of the list rather than grepping the
   whole file -- a URL in a comment explaining what NOT to use must not
   trip the assertion, and the comment above the entry says '/rss/all-news'
   precisely because that is the trap. */
const feedUrls = [...worker.matchAll(/\{\s*name:\s*'[^']*'[^}]*?url:\s*'([^']+)'/g)]
  .map((m) => m[1]);

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

/* Each entry: a URL confirmed dead, and the live one to use instead. */
const DEAD = [
  ['https://www.insurancenews.com.au/rss/all-news',
   'https://www.insurancenews.com.au/rss/all']
];

console.log('== no feed is configured to a known-dead address ==');
check('the feed list was parsed', feedUrls.length > 10, { found: feedUrls.length });

DEAD.forEach(([dead, live]) => {
  check('not configured: ' + dead, !feedUrls.includes(dead));
  check('configured instead: ' + live, feedUrls.includes(live));
});

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
