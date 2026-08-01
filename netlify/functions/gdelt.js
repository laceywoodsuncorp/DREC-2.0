/* Same-origin proxy for the GDELT DOC 2.0 API.
   The browser calls /.netlify/functions/gdelt?url=<encoded GDELT url>, this
   function fetches that URL server-side (Netlify's infrastructure, not the
   visitor's network) and relays the response back. This is the only route
   that reliably works when a visitor is behind a corporate firewall that
   blocks public CORS-proxy sites (allorigins.win, corsproxy.io, etc.) as a
   "web proxy" category, since from the browser's point of view this is a
   same-origin request, not a call to a third-party relay. */
exports.handler = async function (event) {
  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target || !/^https:\/\/api\.gdeltproject\.org\//.test(target)) {
    return { statusCode: 400, body: 'Missing or disallowed url parameter' };
  }
  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' } });
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
  }
};
