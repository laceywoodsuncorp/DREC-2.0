/* Cloudflare Worker entry point.
   - "/" is rewritten to the actual site file (there's no index.html in this
     repo, and the ASSETS binding otherwise 404s at the root).
   - "/api/gdelt" is handled here directly: it builds the GDELT query itself
     and fetches it from Cloudflare's edge (not the visitor's network), so a
     visitor behind a corporate firewall that blocks public CORS-proxy sites
     still gets a working same-origin route. The GDELT URL is built here
     rather than passed in as a query param so the literal string
     "gdeltproject.org" never appears in the browser's own request URL --
     some corporate web filters block on URL substrings, not just hostname,
     which broke this even as a same-origin call when the target URL was
     passed through as ?url=. See index_updated_abc_emergency_map.html's
     GDELT_ROUTES for the client side of this.
   - Everything else falls through to the static assets binding. */
/* GDELT's DOC API rejects overly-long query strings ("Your query was too
   short or too long") -- the original 17-domain OR-clause plus a
   sourcecountry filter exceeded that limit. Trimmed to the highest-traffic
   AU outlets and dropped the (redundant, since domains already scope this
   to Australian sources) sourcecountry clause to stay well under it. */
/* All domains a visitor can select in the Sources dropdown -- see
   index_updated_abc_emergency_map.html's ALL_SOURCES. The client passes its
   selection via ?sources=, validated against this list here (never trust a
   client-supplied domain list directly into an outbound URL). */
const ALL_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
  'sbs.com.au', '7news.com.au', 'theguardian.com', 'insurancenews.com.au', 'aljazeera.com'];

function buildGdeltUrl(domains) {
  const domainClause = '(' + domains.map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  return 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=24h&format=json&sort=datedesc';
}

async function handleGdelt(request) {
  const requested = (new URL(request.url).searchParams.get('sources') || '').split(',').filter(Boolean);
  const domains = requested.filter((d) => ALL_DOMAINS.includes(d));
  const target = buildGdeltUrl(domains.length ? domains : ALL_DOMAINS);
  /* Previously this waited 5.2s and retried once on a 429 before responding,
     to absorb GDELT's rate limit transparently. In practice that pushed the
     total request time past the client's own timeout when GDELT was also
     slow to answer, and the browser aborted the request outright (a wasted,
     silent failure that's worse than just returning the 429 quickly). A
     single bounded-timeout attempt is more reliable: if GDELT is rate
     limiting, the browser sees a fast 429 and the client's own route
     fallback / manual refresh handles it, rather than the worker holding the
     connection open and risking a client-side abort. */
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/gdelt') {
      return handleGdelt(request);
    }

    if (url.pathname === '/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index_updated_abc_emergency_map.html';
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
