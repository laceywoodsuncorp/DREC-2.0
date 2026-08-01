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
/* GDELT's DOC API rejects overly-long query strings ("Your query was too
   short or too long") -- the original 17-domain OR-clause plus a
   sourcecountry filter exceeded that limit. Trimmed to the highest-traffic
   AU outlets and dropped the (redundant, since domains already scope this
   to Australian sources) sourcecountry clause to stay well under it. */
/* The Guardian AU was dropped -- it pulls a disproportionate amount of
   international coverage even after the client's AU-relevance filtering. */
const AU_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
  'sbs.com.au', '7news.com.au', 'insurancenews.com.au'];
const WORLD_DOMAIN = 'aljazeera.com';

function buildGdeltUrl() {
  const domainClause = '(' + [...AU_DOMAINS, WORLD_DOMAIN].map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  return 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=24h&format=json&sort=datedesc';
}

export async function onRequestGet() {
  const target = buildGdeltUrl();
  /* A bounded single attempt, not a wait-and-retry-on-429: stacking a 5.2s
     sleep on top of a sometimes-slow GDELT response risked exceeding the
     client's own fetch timeout, causing the browser to abort outright --
     worse than just returning a fast 429 and letting the client's route
     fallback / manual refresh handle it. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' }, signal: ctrl.signal });
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
  } finally {
    clearTimeout(timer);
  }
}
