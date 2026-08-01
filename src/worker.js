/* Cloudflare Worker entry point.
   - "/" is rewritten to the actual site file (there's no index.html in this
     repo, and the ASSETS binding otherwise 404s at the root).
   - "/api/gdelt" is handled here directly: it fetches GDELT from Cloudflare's
     edge (not the visitor's network) and relays the response back, so a
     visitor behind a corporate firewall that blocks public CORS-proxy sites
     still gets a working same-origin route. See index_updated_abc_emergency_map.html's
     GDELT_ROUTES for the client side of this.
   - Everything else falls through to the static assets binding. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleGdelt(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !/^https:\/\/api\.gdeltproject\.org\//.test(target)) {
    return new Response('Missing or disallowed url parameter', { status: 400 });
  }
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
