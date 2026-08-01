/* Same-origin proxy for the GDELT DOC 2.0 API, for Cloudflare Pages Functions.
   A file at functions/api/gdelt.js is auto-routed by Cloudflare Pages to
   /api/gdelt. It takes NO query parameter -- the target GDELT URL is built
   here server-side rather than passed in via ?url=, because some corporate
   web filters block on URL substrings anywhere in the request (not just the
   hostname being requested), and a same-origin call carrying
   "gdeltproject.org" in its own query string got blocked exactly like a
   direct cross-origin call would. This function fetches GDELT from
   Cloudflare's edge (not the visitor's network) and relays the response
   back. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* GDELT's DOC API rejects overly-long query strings ("Your query was too
   short or too long") -- the original 17-domain OR-clause plus a
   sourcecountry filter exceeded that limit. Trimmed to the highest-traffic
   AU outlets and dropped the (redundant, since domains already scope this
   to Australian sources) sourcecountry clause to stay well under it. */
const AU_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
  'sbs.com.au', '7news.com.au', 'theguardian.com', 'insurancenews.com.au'];

const ALLOWED_HOURS = [24, 48, 72, 168];

function buildGdeltUrl(hours) {
  const domainClause = '(' + AU_DOMAINS.map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  return 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=' + hours + 'h&format=json&sort=datedesc';
}

export async function onRequestGet(context) {
  const requested = Number(new URL(context.request.url).searchParams.get('hours'));
  const hours = ALLOWED_HOURS.includes(requested) ? requested : 24;
  const target = buildGdeltUrl(hours);
  try {
    let upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' } });
    /* GDELT enforces a strict "one request every 5 seconds" limit that's easy
       to hit from a shared edge IP pool even under light use from this site
       alone. A single backoff-and-retry absorbs that transparently instead of
       surfacing a 429 to the browser. */
    if (upstream.status === 429) {
      await sleep(5200);
      upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' } });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  }
}
