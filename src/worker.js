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
   for every visitor to get a fast, working feed.
   Same shared-cache mechanism is reused below for /api/incidents, just
   keyed on a different cache URL and TTLs -- parameterised rather than
   duplicated. */
const GDELT_CACHE_URL = 'https://newsradar-internal-cache.example/gdelt';
const GDELT_FRESH_SECONDS = 600; // matches the client's own 10-minute refresh cadence
const GDELT_STALE_MAX_SECONDS = 7200; // how long a stale copy stays usable as an emergency fallback

async function readSharedCache(cacheUrl) {
  const cached = await caches.default.match(cacheUrl);
  if (!cached) return null;
  const fetchedAt = Number(cached.headers.get('X-Fetched-At') || 0);
  return { response: cached, ageSeconds: (Date.now() - fetchedAt) / 1000 };
}

async function writeSharedCache(cacheUrl, bodyText, contentType, staleMaxSeconds) {
  const stored = new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'application/json',
      'Cache-Control': 'public, max-age=' + staleMaxSeconds,
      'X-Fetched-At': String(Date.now())
    }
  });
  await caches.default.put(cacheUrl, stored.clone());
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
  const cached = await readSharedCache(GDELT_CACHE_URL);
  if (cached && cached.ageSeconds < GDELT_FRESH_SECONDS) {
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
      const stored = await writeSharedCache(GDELT_CACHE_URL, body, upstream.headers.get('content-type'), GDELT_STALE_MAX_SECONDS);
      return new Response(stored.body, {
        status: 200,
        headers: { 'Content-Type': stored.headers.get('content-type'), 'Cache-Control': 'no-store' }
      });
    }
    /* Non-OK (e.g. a 429) -- prefer serving a stale-but-usable cached copy
       over surfacing the failure, if one exists within the stale window. */
    if (cached && cached.ageSeconds < GDELT_STALE_MAX_SECONDS) return respondFromCache(cached);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    if (cached && cached.ageSeconds < GDELT_STALE_MAX_SECONDS) return respondFromCache(cached);
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/* /api/incidents proxies emergencyapi.com's unified incident feed (all 8
   states/territories in one GeoJSON response). The API key is a Cloudflare
   secret (env.EMERGENCY_API_KEY, set via `wrangler secret put`) -- it must
   never reach the browser, since this static site has no other backend to
   hide it in and anyone can view-source a public page. Cached for 3 minutes
   (incidents change faster than news) with a 30-minute stale fallback, both
   to keep the site fast and to go easy on the account's request quota since
   every visitor would otherwise trigger its own upstream call. */
const INCIDENTS_CACHE_URL = 'https://newsradar-internal-cache.example/incidents';
const INCIDENTS_FRESH_SECONDS = 180;
const INCIDENTS_STALE_MAX_SECONDS = 1800;
const INCIDENTS_STATES = 'nsw,vic,qld,sa,wa,tas,nt,act';

async function handleIncidents(env) {
  if (!env.EMERGENCY_API_KEY) {
    return new Response(JSON.stringify({ error: 'EMERGENCY_API_KEY secret not configured' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const cached = await readSharedCache(INCIDENTS_CACHE_URL);
  if (cached && cached.ageSeconds < INCIDENTS_FRESH_SECONDS) {
    return respondFromCache(cached);
  }

  const target = 'https://emergencyapi.com/api/v1/incidents?state=' + INCIDENTS_STATES + '&limit=500';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target, {
      headers: { Authorization: 'Bearer ' + env.EMERGENCY_API_KEY },
      signal: ctrl.signal
    });
    if (upstream.ok) {
      const body = await upstream.text();
      const stored = await writeSharedCache(INCIDENTS_CACHE_URL, body, upstream.headers.get('content-type'), INCIDENTS_STALE_MAX_SECONDS);
      return new Response(stored.body, {
        status: 200,
        headers: { 'Content-Type': stored.headers.get('content-type'), 'Cache-Control': 'no-store' }
      });
    }
    if (cached && cached.ageSeconds < INCIDENTS_STALE_MAX_SECONDS) return respondFromCache(cached);
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    if (cached && cached.ageSeconds < INCIDENTS_STALE_MAX_SECONDS) return respondFromCache(cached);
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

    if (url.pathname === '/api/incidents') {
      return handleIncidents(env);
    }

    if (url.pathname === '/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index_updated_abc_emergency_map.html';
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
