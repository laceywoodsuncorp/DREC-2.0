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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* GDELT's DOC API rejects overly-long query strings ("Your query was too
   short or too long") -- the original 17-domain OR-clause plus a
   sourcecountry filter exceeded that limit. Trimmed to the highest-traffic
   AU outlets and dropped the (redundant, since domains already scope this
   to Australian sources) sourcecountry clause to stay well under it. */
const AU_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
  'sbs.com.au', '7news.com.au', 'theguardian.com', 'insurancenews.com.au'];

function buildGdeltUrl() {
  const domainClause = '(' + AU_DOMAINS.map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  return 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=7d&format=json&sort=datedesc';
}

async function handleGdelt() {
  const target = buildGdeltUrl();
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/gdelt') {
      return handleGdelt();
    }

    if (url.pathname === '/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index_updated_abc_emergency_map.html';
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
