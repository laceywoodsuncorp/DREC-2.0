/* Cloudflare Worker entry point.
   - "/" is rewritten to the actual site file (there's no index.html in this
     repo, and the ASSETS binding otherwise 404s at the root).
   - "/api/gdelt" and "/api/incidents" are handled here directly -- see the
     comments above handleGdelt()/handleIncidents() below.
   - A scheduled Cron Trigger (see wrangler.jsonc's "triggers.crons", and
     the scheduled() export at the bottom) independently refreshes both
     caches every 5 minutes. That's the actual fix for visitors hitting
     slow/rate-limited GDELT calls: a visitor's own page load NEVER
     triggers a live upstream fetch anymore (as long as a cache entry
     exists at all) -- it just reads whatever the last scheduled run
     found, so the request is instant regardless of how GDELT or
     emergencyapi.com happen to be behaving at that moment. The only time a
     visitor's request still does a live fetch is a genuine cold start
     (fresh deploy, before the first cron tick has ever run).
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

/* Shared cache helpers, reused for both GDELT and the incidents feed --
   parameterised on cache URL rather than duplicated. CACHE_ENTRY_LIFETIME is
   just the outer bound Cloudflare uses to eventually evict an entry (via
   Cache-Control: max-age) if scheduled refreshes stop happening entirely
   (e.g. the cron gets disabled) -- it's not a "freshness" gate any more.
   Since the cron is what's responsible for keeping these current, an
   on-demand request just serves whatever's cached, however old, rather than
   comparing its age against a threshold. */
const CACHE_ENTRY_LIFETIME_SECONDS = 7200; // 2h -- generous outer bound, not a freshness check

async function readSharedCache(cacheUrl) {
  const cached = await caches.default.match(cacheUrl);
  if (!cached) return null;
  const fetchedAt = Number(cached.headers.get('X-Fetched-At') || 0);
  return { response: cached, ageSeconds: (Date.now() - fetchedAt) / 1000 };
}

async function writeSharedCache(cacheUrl, bodyText, contentType) {
  const stored = new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_ENTRY_LIFETIME_SECONDS,
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* Does the actual GDELT fetch and, on success, writes the shared cache.
   Called from both the scheduled cron tick (the normal case) and
   handleGdelt()'s cold-start bootstrap fetch. On failure it just leaves
   whatever's already cached untouched -- a failed refresh means visitors
   keep seeing the last known-good result instead of an error.
   Retries up to 3 times, 5 seconds apart, specifically on a 429 -- GDELT's
   429 body literally says "limit requests to one every 5 seconds", and in
   practice it has been rejecting close to every single attempt from
   Cloudflare's shared outbound IP range regardless of how infrequently we
   ask, which meant the cache could go indefinitely without ever being
   written even with the 5-minute cron in place. A 429 comes back fast (not
   a timeout), so a few retries here only cost a few seconds -- and it's
   time spent in the background (a cron tick, or rarely a cold start),
   never on a warm visitor's request. */
async function refreshGdeltCache() {
  const target = buildGdeltUrl();
  let lastFailure = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    /* 15s, not 8s: GDELT has been observed taking 10-16s just to return an
       error response during slow periods, so 8s was aborting before GDELT
       had any real chance to succeed. */
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': 'NewsRadar/1.0' }, signal: ctrl.signal });
      if (upstream.ok) {
        const body = await upstream.text();
        const stored = await writeSharedCache(GDELT_CACHE_URL, body, upstream.headers.get('content-type'));
        return { ok: true, stored };
      }
      lastFailure = { ok: false, status: upstream.status, body: await upstream.text() };
      if (upstream.status !== 429 || attempt === 3) return lastFailure;
    } catch (err) {
      return { ok: false, error: err.message }; // don't retry network/timeout errors, only explicit 429s
    } finally {
      clearTimeout(timer);
    }
    await sleep(5000);
  }
  return lastFailure;
}
const GDELT_CACHE_URL = 'https://newsradar-internal-cache.example/gdelt';

async function handleGdelt() {
  const cached = await readSharedCache(GDELT_CACHE_URL);
  if (cached) return respondFromCache(cached);

  /* No cache at all yet -- a fresh deploy before the first cron tick, or the
     cron has been disabled. Bootstrap with one live fetch so the site isn't
     broken while waiting; every subsequent request will hit the cache this
     writes. */
  const result = await refreshGdeltCache();
  if (result.ok) {
    return new Response(result.stored.body, {
      status: 200,
      headers: { 'Content-Type': result.stored.headers.get('content-type'), 'Cache-Control': 'no-store' }
    });
  }
  if (result.error) return new Response('Upstream fetch failed: ' + result.error, { status: 502 });
  return new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/* /api/incidents proxies emergencyapi.com's unified incident feed (all 8
   states/territories in one GeoJSON response). The API key is a Cloudflare
   secret (env.EMERGENCY_API_KEY, set via `wrangler secret put`) -- it must
   never reach the browser, since this static site has no other backend to
   hide it in and anyone can view-source a public page. Refreshed by the
   same scheduled cron as GDELT, for the same reason: a visitor's request
   should never be the thing that triggers a live upstream call. */
const INCIDENTS_CACHE_URL = 'https://newsradar-internal-cache.example/incidents';
const INCIDENTS_STATES = 'nsw,vic,qld,sa,wa,tas,nt,act';

/* Same 429-specific retry as refreshGdeltCache() above -- see its comment
   for why. Not observed on emergencyapi.com yet, but cheap insurance
   against the same shared-IP rate-limiting risk. */
async function refreshIncidentsCache(env) {
  if (!env.EMERGENCY_API_KEY) return { ok: false, error: 'EMERGENCY_API_KEY secret not configured' };
  const target = 'https://emergencyapi.com/api/v1/incidents?state=' + INCIDENTS_STATES + '&limit=500';
  let lastFailure = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const upstream = await fetch(target, {
        headers: { Authorization: 'Bearer ' + env.EMERGENCY_API_KEY },
        signal: ctrl.signal
      });
      if (upstream.ok) {
        const body = await upstream.text();
        const stored = await writeSharedCache(INCIDENTS_CACHE_URL, body, upstream.headers.get('content-type'));
        return { ok: true, stored };
      }
      lastFailure = { ok: false, status: upstream.status, body: await upstream.text() };
      if (upstream.status !== 429 || attempt === 3) return lastFailure;
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      clearTimeout(timer);
    }
    await sleep(5000);
  }
  return lastFailure;
}

async function handleIncidents(env) {
  const cached = await readSharedCache(INCIDENTS_CACHE_URL);
  if (cached) return respondFromCache(cached);

  const result = await refreshIncidentsCache(env);
  if (result.ok) {
    return new Response(result.stored.body, {
      status: 200,
      headers: { 'Content-Type': result.stored.headers.get('content-type'), 'Cache-Control': 'no-store' }
    });
  }
  if (!env.EMERGENCY_API_KEY) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 501,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  if (result.error) return new Response('Upstream fetch failed: ' + result.error, { status: 502 });
  return new Response(result.body, {
    status: result.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
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
  },

  /* Fires on the cron schedule in wrangler.jsonc (every 5 minutes). Runs
     both refreshes independently via ctx.waitUntil so one failing doesn't
     stop the other, and so the Worker instance isn't recycled before both
     finish. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshGdeltCache());
    ctx.waitUntil(refreshIncidentsCache(env));
  }
};
