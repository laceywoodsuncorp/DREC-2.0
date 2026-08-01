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

/* GDELT itself is unreliable under load: slow responses, frequent 429s.
   Without a shared cache, every visitor's browser independently fights that
   flakiness, so everyone feels it at once whenever GDELT is having a bad
   moment. Cloudflare's edge Cache API lets this function keep one shared
   copy of the last successful GDELT response: fresh requests (<10 min old)
   are served straight from that cache with no GDELT round-trip at all, and
   if a refresh is due but GDELT fails, the stale copy (up to 2h old) is
   served instead of a hard failure. GDELT only needs to succeed once every
   so often for every visitor to get a fast, working feed. */
const CACHE_URL = 'https://newsradar-internal-cache.example/gdelt';
const FRESH_SECONDS = 600; // matches the client's own 10-minute refresh cadence
const STALE_MAX_SECONDS = 7200; // how long a stale copy stays usable as an emergency fallback

async function readSharedCache() {
  const cached = await caches.default.match(CACHE_URL);
  if (!cached) return null;
  const fetchedAt = Number(cached.headers.get('X-Fetched-At') || 0);
  return { response: cached, ageSeconds: (Date.now() - fetchedAt) / 1000 };
}

async function writeSharedCache(bodyText, contentType) {
  const stored = new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'application/json',
      'Cache-Control': 'public, max-age=' + STALE_MAX_SECONDS,
      'X-Fetched-At': String(Date.now())
    }
  });
  await caches.default.put(CACHE_URL, stored.clone());
  return stored;
}

function respondFromCache(cached) {
  return new Response(cached.response.body, {
    status: 200,
    headers: {
      'Content-Type': cached.response.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Cache-Age': String(Math.round(cached.ageSeconds))
    }
  });
}

export async function onRequestGet() {
  const cached = await readSharedCache();
  if (cached && cached.ageSeconds < FRESH_SECONDS) {
    return respondFromCache(cached);
  }

  const target = buildGdeltUrl();
  /* A bounded single attempt, not a wait-and-retry-on-429: stacking a 5.2s
     sleep on top of a sometimes-slow GDELT response risked exceeding the
     client's own fetch timeout, causing the browser to abort outright --
     worse than just returning a fast 429 and letting the client's route
     fallback / manual refresh handle it.
     15s, not 8s: GDELT has been observed taking 10-16s just to return an
     error response during slow periods, so 8s was aborting before GDELT had
     any real chance to succeed -- worth the extra wait since success here
     seeds the shared cache for every other visitor too. Still safely under
     the client's own 20s timeout. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' }, signal: ctrl.signal });
    if (upstream.ok) {
      const body = await upstream.text();
      const stored = await writeSharedCache(body, upstream.headers.get('content-type'));
      return new Response(stored.body, {
        status: 200,
        headers: { 'Content-Type': stored.headers.get('content-type'), 'Cache-Control': 'no-store' }
      });
    }
    if (cached && cached.ageSeconds < STALE_MAX_SECONDS) return respondFromCache(cached);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    if (cached && cached.ageSeconds < STALE_MAX_SECONDS) return respondFromCache(cached);
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
