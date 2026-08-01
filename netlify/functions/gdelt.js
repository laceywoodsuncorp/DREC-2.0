/* Same-origin proxy for the GDELT DOC 2.0 API.
   The browser calls /.netlify/functions/gdelt with NO query parameter -- the
   target GDELT URL is built here server-side rather than passed in via
   ?url=, because some corporate web filters block on URL substrings
   anywhere in the request (not just the hostname being requested), and a
   same-origin call carrying "gdeltproject.org" in its own query string got
   blocked exactly like a direct cross-origin call would. This function
   fetches that URL server-side (Netlify's infrastructure, not the visitor's
   network) and relays the response back. */
exports.handler = async function (event) {
  /* GDELT's DOC API rejects overly-long query strings ("Your query was too
     short or too long") -- the original 17-domain OR-clause plus a
     sourcecountry filter exceeded that limit. Trimmed to the highest-traffic
     AU outlets and dropped the (redundant, since domains already scope this
     to Australian sources) sourcecountry clause to stay well under it. */
  const AU_DOMAINS = ['abc.net.au', '9news.com.au', 'news.com.au', 'smh.com.au',
    'sbs.com.au', '7news.com.au', 'theguardian.com', 'insurancenews.com.au'];
  /* Dedicated World-news source -- see index_updated_abc_emergency_map.html's
     WORLD_DOMAINS/isWorldSource handling for why. */
  const WORLD_DOMAINS = ['aljazeera.com'];
  const ALLOWED_HOURS = [24, 48, 72, 168];
  const requested = Number((event.queryStringParameters || {}).hours);
  const hours = ALLOWED_HOURS.includes(requested) ? requested : 24;
  const domainClause = '(' + [...AU_DOMAINS, ...WORLD_DOMAINS].map((d) => 'domain:' + d).join(' OR ') + ')';
  const query = domainClause;
  const target = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=artlist&maxrecords=250&timespan=' + hours + 'h&format=json&sort=datedesc';
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
