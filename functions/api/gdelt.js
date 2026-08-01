/* Same-origin proxy for the GDELT DOC 2.0 API, for Cloudflare Pages Functions.
   A file at functions/api/gdelt.js is auto-routed by Cloudflare Pages to
   /api/gdelt, so the browser calls /api/gdelt?url=<encoded GDELT url>, this
   function fetches that URL from Cloudflare's edge (not the visitor's
   network) and relays the response back. This is the route that reliably
   works when a visitor is behind a corporate firewall that blocks public
   CORS-proxy sites (allorigins.win, corsproxy.io, etc.) as a "web proxy"
   category, since from the browser's point of view this is a same-origin
   request, not a call to a third-party relay. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
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
