/* Netlify Functions variant of /api/incidents -- see src/worker.js's
   handleIncidents() for the Worker version this mirrors. Proxies
   emergencyapi.com's unified all-states incident feed so the API key (a
   Netlify environment variable, EMERGENCY_API_KEY) never reaches the
   browser -- this static site has no other backend to hide it in.
   Unlike the Cloudflare variants, this has no shared-cache equivalent
   (same reason as netlify/functions/gdelt.js -- no Netlify Blobs
   provisioned while this variant isn't the one actually deployed). */
exports.handler = async function () {
  const key = process.env.EMERGENCY_API_KEY;
  if (!key) {
    return { statusCode: 501, body: JSON.stringify({ error: 'EMERGENCY_API_KEY env var not configured' }) };
  }

  const target = 'https://emergencyapi.com/api/v1/incidents?state=nsw,vic,qld,sa,wa,tas,nt,act&limit=500';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(target, { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
      body
    };
  } catch (err) {
    return { statusCode: 502, body: 'Upstream fetch failed: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
};
