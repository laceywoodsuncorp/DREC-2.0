/* Cloudflare Pages Functions variant of /api/incidents -- see src/worker.js's
   handleIncidents() for the Worker version this mirrors. Proxies
   emergencyapi.com's unified all-states incident feed so the API key (a
   Pages secret, env.EMERGENCY_API_KEY) never reaches the browser -- this
   static site has no other backend to hide it in. */
const CACHE_URL = 'https://newsradar-internal-cache.example/incidents';
const FRESH_SECONDS = 180;
const STALE_MAX_SECONDS = 1800;
const STATES = 'nsw,vic,qld,sa,wa,tas,nt,act';

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

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.EMERGENCY_API_KEY) {
    return new Response(JSON.stringify({ error: 'EMERGENCY_API_KEY secret not configured' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const cached = await readSharedCache();
  if (cached && cached.ageSeconds < FRESH_SECONDS) {
    return respondFromCache(cached);
  }

  const target = 'https://emergencyapi.com/api/v1/incidents?state=' + STATES + '&limit=500';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target, {
      headers: { Authorization: 'Bearer ' + env.EMERGENCY_API_KEY },
      signal: ctrl.signal
    });
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
