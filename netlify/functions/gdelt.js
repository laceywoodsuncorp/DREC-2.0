/* Same-origin proxy for the GDELT DOC 2.0 API.
   The browser calls /.netlify/functions/gdelt with NO query parameter -- the
   target GDELT URL is built here server-side rather than passed in via
   ?url=, because some corporate web filters block on URL substrings
   anywhere in the request (not just the hostname being requested), and a
   same-origin call carrying "gdeltproject.org" in its own query string got
   blocked exactly like a direct cross-origin call would. This function
   fetches that URL server-side (Netlify's infrastructure, not the visitor's
   network) and relays the response back.

   Unlike the Cloudflare Worker/Pages Function variants of this same proxy,
   this one has no shared cache in front of GDELT (Netlify Functions have no
   built-in equivalent to Cloudflare's edge Cache API -- doing this properly
   here would mean provisioning Netlify Blobs, which isn't worth setting up
   while this variant isn't the one actually deployed). Each request still
   hits GDELT directly, bounded by the same 8s timeout below. */
exports.handler = async function () {
  /* The Guardian AU was dropped -- it pulls a disproportionate amount of
     international coverage even after the client's AU-relevance filtering. */
  const AU_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
    'sbs.com.au', '7news.com.au', 'insurancenews.com.au'];
  const WORLD_DOMAIN = 'aljazeera.com';
  const domainClause = '(' + [...AU_DOMAINS, WORLD_DOMAIN].map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  const target = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=24h&format=json&sort=datedesc';
  /* A bounded single attempt, not a wait-and-retry-on-429: stacking a 5.2s
     sleep on top of a sometimes-slow GDELT response risked exceeding the
     client's own fetch timeout, causing the browser to abort outright --
     worse than just returning a fast 429 and letting the client's route
     fallback / manual refresh handle it.
     15s, not 8s: GDELT has been observed taking 10-16s just to return an
     error response during slow periods, so 8s was aborting before GDELT had
     any real chance to succeed. Still safely under the client's own 20s
     timeout. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' }, signal: ctrl.signal });
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store'
      },
      body
    };
  } catch (err) {
    return { statusCode: 502, body: 'Upstream fetch failed: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
};
