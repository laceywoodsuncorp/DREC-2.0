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
   moment. Cloudflare's edge Cache API lets this Worker keep one shared copy
   of the last successful GDELT response: fresh requests (<10 min old) are
   served straight from that cache with no GDELT round-trip at all, and if a
   refresh is due but GDELT fails, the stale copy (up to 2h old) is served
   instead of a hard failure. GDELT only needs to succeed once every so often
   for every visitor to get a fast, working feed. */
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

async function handleGdelt() {
  const cached = await readSharedCache();
  if (cached && cached.ageSeconds < FRESH_SECONDS) {
    return respondFromCache(cached);
  }

  const target = buildGdeltUrl();
  const ctrl = new AbortController();
  /* 15s, not 8s: GDELT has been observed taking 10-16s just to return an
     error response during slow periods, so 8s was aborting before GDELT had
     any real chance to succeed -- worth the extra wait since success here
     seeds the shared cache for every other visitor too. Still safely under
     the client's own 20s timeout. */
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
    /* Non-OK (e.g. a 429) -- prefer serving a stale-but-usable cached copy
       over surfacing the failure, if one exists within the stale window. */
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
