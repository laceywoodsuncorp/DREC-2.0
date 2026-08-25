/* Cloudflare Worker entry point.
   - "/" is rewritten to the actual site file (there's no index.html in this
     repo, and the ASSETS binding otherwise 404s at the root).
   - "/api/gdelt" proxies the GDELT news feed -- see handleGdelt() below.
   - "/api/incidents/<state>" proxies ONE state's official government
     incident feed, normalised to a common shape; "/api/incidents" returns
     all eight states in a single response built from the same caches.
     See the INCIDENT FEEDS section below.
   - A scheduled Cron Trigger (see wrangler.jsonc's "triggers.crons", and
     the scheduled() export at the bottom) independently refreshes every
     cache every 5 minutes. That's the actual fix for visitors hitting
     slow/rate-limited upstreams: a visitor's own page load NEVER
     triggers a live upstream fetch anymore (as long as a cache entry
     exists at all) -- it just reads whatever the last scheduled run
     found, so the request is instant regardless of how any upstream
     happens to be behaving at that moment. The only time a visitor's
     request still does a live fetch is a genuine cold start (fresh
     deploy, before the first cron tick has ever run).
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

/* Shared cache helpers, reused for GDELT and for every state incident feed --
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

/* ============================================================
   INCIDENT FEEDS -- eight official government sources, no API key
   ============================================================
   This replaces the old emergencyapi.com dependency entirely. That service
   was a single point of failure behind an API key: when it stopped covering
   a state (or the key lapsed) that state's tab silently fell back to a
   stale hand-written snapshot, which is how "some states started failing"
   went unnoticed. Every source below is a keyless public government feed,
   fetched server-side so that:
     - there is no API key to expire, rotate or leak;
     - the browser never makes the cross-origin call itself, so neither CORS
       nor a corporate firewall's category blocking can break it (the old
       client-side fallbacks hit exactly that);
     - one state being down cannot affect the other seven.

   VIC, WA and NT are new here -- the old dashboard had no live source for
   them at all and only ever linked out to their official pages.

   IMPORTANT -- shape tolerance. NSW, QLD, SA and ACT were previously
   confirmed against real captured responses. VIC, WA, NT and TAS could not
   be verified from the build environment (outbound access to these hosts is
   blocked here), so rather than hard-coding a guessed field layout that
   would silently yield an empty list, those go through normaliseRecords()
   below, which probes a prioritised list of candidate field names against
   whatever shape actually comes back. When a feed parses to zero incidents
   the response carries a `diagnostics` block naming the keys that WERE
   present, so a schema drift shows up as a specific, fixable message rather
   than an empty tab. */

const INCIDENT_STATES = ['nsw', 'qld', 'vic', 'wa', 'sa', 'tas', 'nt', 'act'];

function incidentCacheUrl(state) {
  return 'https://newsradar-internal-cache.example/incidents/' + state;
}
const INCIDENTS_ALL_CACHE_URL = 'https://newsradar-internal-cache.example/incidents-all';

/* ---------- shared normalisation helpers ---------- */

/* Candidate field names per normalised field, in priority order, matched
   case-insensitively. Deliberately broad: these feeds are maintained by
   eight different agencies with no shared schema. */
const FIELD_CANDIDATES = {
  title: ['title', 'name', 'headline', 'webheadline', 'sourcetitle', 'incidentname',
    'location', 'location_name', 'locationname', 'locality', 'place', 'address', 'suburb'],
  status: ['status', 'currentstatus', 'incidentstatus', 'warninglevel', 'alertlevel',
    'level', 'category', 'category1'],
  type: ['type', 'incidenttype', 'eventtype', 'groupedtype', 'category2',
    'vehicletypedescription', 'subtype', 'class'],
  when: ['updated', 'lastupdate', 'lastupdated', 'last_update', 'pubdate', 'created',
    'datetime', 'reported', 'starttime', 'timestamp', 'date', 'time']
};

/* Lowercased-key view of an object so candidate lookups don't depend on each
   agency's capitalisation choices. */
function lowerKeyMap(obj) {
  const map = {};
  Object.keys(obj || {}).forEach((k) => { map[k.toLowerCase()] = obj[k]; });
  return map;
}

function pickField(lowered, kind) {
  const candidates = FIELD_CANDIDATES[kind] || [];
  for (const name of candidates) {
    const v = lowered[name];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    const s = String(v).trim();
    if (s && s.toLowerCase() !== 'null') return s;
  }
  return '';
}

/* Pulls coordinates out of whichever of the several conventions a feed uses:
   a GeoJSON geometry, separate lat/lon fields, or SA's "lat,lon" string. */
function pickCoords(record, geometry) {
  if (geometry && Array.isArray(geometry.coordinates)) {
    const c = geometry.coordinates;
    const flat = Array.isArray(c[0]) ? null : c;
    if (flat && isFinite(flat[0]) && isFinite(flat[1])) {
      return { lon: Number(flat[0]), lat: Number(flat[1]) }; // GeoJSON is [lon, lat]
    }
  }
  const lowered = lowerKeyMap(record);
  const latRaw = lowered.lat !== undefined ? lowered.lat : lowered.latitude;
  const lonRaw = lowered.lon !== undefined ? lowered.lon
    : (lowered.lng !== undefined ? lowered.lng : lowered.longitude);
  if (isFinite(latRaw) && isFinite(lonRaw) && latRaw !== '' && lonRaw !== '') {
    return { lat: Number(latRaw), lon: Number(lonRaw) };
  }
  const combined = lowered.location;
  if (typeof combined === 'string' && combined.includes(',')) {
    const parts = combined.split(',');
    if (parts.length === 2 && isFinite(parts[0].trim()) && isFinite(parts[1].trim())) {
      return { lat: Number(parts[0].trim()), lon: Number(parts[1].trim()) };
    }
  }
  return {};
}

/* Feeds report time as ISO strings, epoch milliseconds, epoch seconds, or an
   already-formatted local string. Keep the raw value for display, and add an
   ISO form whenever one can actually be derived so the browser can render it
   in the visitor's own timezone. Never invents a timestamp it can't parse. */
function normaliseWhen(raw) {
  const out = { when: raw ? String(raw).trim() : '' };
  if (!out.when) return out;
  let ms = null;
  if (/^\d{13}$/.test(out.when)) ms = Number(out.when);
  else if (/^\d{10}$/.test(out.when)) ms = Number(out.when) * 1000;
  else {
    const parsed = Date.parse(out.when);
    if (!isNaN(parsed)) ms = parsed;
  }
  if (ms !== null && isFinite(ms)) out.whenIso = new Date(ms).toISOString();
  return out;
}

/* Finds the list of incident records inside whatever envelope a feed uses:
   a GeoJSON FeatureCollection, a bare array, an object wrapping an array
   under some key, or an object whose values are the records (SA does this). */
function collectRecords(json) {
  if (!json || typeof json !== 'object') return { records: [], envelope: 'unrecognised' };

  if (Array.isArray(json.features)) {
    return {
      envelope: 'geojson',
      records: json.features.map((f) => ({ props: (f && f.properties) || {}, geometry: f && f.geometry }))
    };
  }
  if (Array.isArray(json)) {
    return { envelope: 'array', records: json.filter((r) => r && typeof r === 'object').map((r) => ({ props: r })) };
  }
  /* An object wrapping the real list under some key -- try the longest
     array-of-objects property rather than guessing its name. */
  let best = null;
  Object.keys(json).forEach((k) => {
    const v = json[k];
    if (Array.isArray(v) && v.some((e) => e && typeof e === 'object')) {
      if (!best || v.length > best.value.length) best = { key: k, value: v };
    }
  });
  if (best) {
    return {
      envelope: 'wrapped:' + best.key,
      records: best.value.filter((r) => r && typeof r === 'object').map((r) => ({ props: r }))
    };
  }
  const values = Object.values(json).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (values.length) {
    return { envelope: 'object-values', records: values.map((r) => ({ props: r })) };
  }
  return { records: [], envelope: 'unrecognised' };
}

/* Generic shape-tolerant normaliser -- used for the feeds whose exact field
   layout could not be verified from here (see the section header above).
   Returns the incidents plus, when nothing could be extracted, the keys that
   were actually present so the mismatch is diagnosable from the response. */
function normaliseRecords(json) {
  const { records, envelope } = collectRecords(json);
  const incidents = [];
  records.forEach(({ props, geometry }) => {
    const lowered = lowerKeyMap(props);
    const title = pickField(lowered, 'title');
    if (!title) return; // a record with no usable label would render as a blank row
    incidents.push(Object.assign(
      {
        title,
        status: pickField(lowered, 'status'),
        type: pickField(lowered, 'type') || 'Incident'
      },
      normaliseWhen(pickField(lowered, 'when')),
      pickCoords(props, geometry)
    ));
  });

  const result = { incidents };
  /* Only flag a problem when there is genuinely something wrong. Zero
     incidents out of zero records is a quiet day, not a broken feed -- the
     client keys off `diagnostics` to tell those two apart, so attaching it
     unconditionally would report every calm state as a schema failure.
     A drift is: records came back but none of their fields were recognised,
     or no list could be located in the payload at all. */
  const noListFound = envelope === 'unrecognised';
  if (!incidents.length && (records.length > 0 || noListFound)) {
    const sample = records.length && records[0].props ? Object.keys(records[0].props).slice(0, 25) : [];
    result.diagnostics = { envelope, recordsSeen: records.length, sampleKeys: sample };
  }
  return result;
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- per-state parsers ---------- */

/* NSW RFS majorIncidents.json -- GeoJSON whose useful detail lives inside a
   single HTML description blob ("LOCATION: ... STATUS: ... TYPE: ...")
   rather than in discrete properties, so it needs its own parser.
   Confirmed against real captured responses. */
function parseNsw(json) {
  const incidents = [];
  (json.features || []).forEach((f) => {
    const p = (f && f.properties) || {};
    const desc = p.description || '';
    const field = (label) => {
      const m = new RegExp(label + ':\\s*([^<\\r\\n]+)').exec(desc);
      return m ? m[1].trim() : '';
    };
    const title = p.title || field('LOCATION');
    if (!title) return;
    incidents.push(Object.assign(
      {
        title,
        status: p.category || field('STATUS') || '',
        type: field('TYPE') || 'Fire'
      },
      normaliseWhen(p.pubDate || field('UPDATED')),
      pickCoords(p, f && f.geometry)
    ));
  });
  return { incidents };
}

/* SA CFS current incidents -- either a bare array or an object keyed by
   incident number; fields IncidentNo/Date/Time/Location_name/Type/Status,
   with Location as a "lat,lon" string. Confirmed schema. */
function parseSa(json) {
  const arr = Array.isArray(json) ? json : Object.values(json || {});
  const incidents = [];
  arr.filter((inc) => inc && typeof inc === 'object').forEach((inc) => {
    const title = inc.Location_name || (inc.IncidentNo ? 'SA incident ' + inc.IncidentNo : '');
    if (!title) return;
    incidents.push(Object.assign(
      {
        title,
        status: inc.Status || '',
        type: inc.Type || 'Incident'
      },
      normaliseWhen(((inc.Date || '') + ' ' + (inc.Time || '')).trim()),
      pickCoords(inc)
    ));
  });
  return { incidents };
}

/* ACT ESA current incidents -- CAP/EDXL XML. Parsed with regexes rather than
   a DOM parse (Workers have no DOMParser) and in the same style as the NSW
   description blob above. Confirmed structure. */
function parseAct(xml) {
  const incidents = [];
  const blocks = xml.match(/<alert[^>]*>[\s\S]*?<\/alert>/g) || [];
  blocks.forEach((block) => {
    const headline = (/<headline>([\s\S]*?)<\/headline>/.exec(block) || [])[1] || '';
    const descMatch = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(block);
    const desc = descMatch ? descMatch[1] : '';
    const field = (label) => {
      const m = new RegExp(label + ':\\s*([^\\r\\n<]+)').exec(desc);
      return m ? m[1].trim() : '';
    };
    const title = stripTags(headline) || field('Incident');
    if (!title) return;
    const coordsMatch = /<circle>\s*([-\d.]+),([-\d.]+)/.exec(block);
    const coords = coordsMatch
      ? { lat: Number(coordsMatch[1]), lon: Number(coordsMatch[2]) }
      : {};
    incidents.push(Object.assign(
      { title, status: field('Status'), type: field('Type') || 'Incident' },
      normaliseWhen(field('Updated') || (/<sent>([\s\S]*?)<\/sent>/.exec(block) || [])[1] || ''),
      coords
    ));
  });
  return { incidents };
}

/* Tasmania Fire Service current incidents. Unlike the other seven this URL
   serves an HTML page, not a data feed, so the incidents table is scraped:
   header cells decide which column is which (rather than assuming a fixed
   column order that a site tweak would silently shift), and rows are mapped
   through the same candidate-name logic as the JSON feeds. If TFS ever
   publishes a real JSON/GeoJSON endpoint this parser should be retired in
   favour of it. */
function parseTas(html) {
  const incidents = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let envelope = 'no-table';

  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    /* Only a header row and no data rows is the correct look for a quiet
       day in Tasmania, so this must still count as "found the table" --
       requiring two rows here would report every calm period as a broken
       scrape. */
    if (!rows.length) continue;

    const headerCells = (rows[0].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map((c) => stripTags(c).toLowerCase());
    if (!headerCells.length) continue;
    const indexOfAny = (names) => headerCells.findIndex((h) => names.some((n) => h.includes(n)));
    const iTitle = indexOfAny(['location', 'incident', 'name', 'suburb', 'region']);
    const iStatus = indexOfAny(['status', 'alert', 'level']);
    const iType = indexOfAny(['type', 'category']);
    const iWhen = indexOfAny(['updated', 'time', 'date', 'started']);
    if (iTitle < 0) continue; // not the incidents table

    envelope = 'html-table';
    rows.slice(1).forEach((row) => {
      const cells = (row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map((c) => stripTags(c));
      if (!cells.length) return;
      const title = cells[iTitle] || '';
      if (!title) return;
      incidents.push(Object.assign(
        {
          title,
          status: iStatus >= 0 ? (cells[iStatus] || '') : '',
          type: (iType >= 0 ? cells[iType] : '') || 'Incident'
        },
        normaliseWhen(iWhen >= 0 ? cells[iWhen] : '')
      ));
    });
    if (incidents.length) break;
  }

  const result = { incidents };
  /* Same distinction as normaliseRecords(): finding the incidents table but
     no data rows means Tasmania is quiet; never finding the table at all
     means the page layout moved and this parser needs updating. */
  if (!incidents.length && envelope === 'no-table') {
    result.diagnostics = { envelope, tablesSeen: tables.length };
  }
  return result;
}

/* The registry. `format` says how to read the body; `parse` turns it into
   normalised incidents. Anything using normaliseRecords is going through the
   shape-tolerant path described in the section header. */
const INCIDENT_FEEDS = {
  nsw: {
    name: 'New South Wales', agency: 'NSW RFS',
    url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json',
    format: 'json', parse: parseNsw
  },
  qld: {
    name: 'Queensland', agency: 'QFES ESCAD',
    url: 'https://services1.arcgis.com/vkTwD8kHw2woKBqV/arcgis/rest/services/ESCAD_Current_Incidents_Public/FeatureServer/0/query?f=geojson&where=1%3D1&outFields=*',
    format: 'json', parse: normaliseRecords
  },
  vic: {
    name: 'Victoria', agency: 'VicEmergency',
    url: 'https://emergency.vic.gov.au/public/events-geojson.json',
    format: 'json', parse: normaliseRecords
  },
  wa: {
    name: 'Western Australia', agency: 'Emergency WA',
    url: 'https://www.emergency.wa.gov.au/data/incident_FCAD.json',
    format: 'json', parse: normaliseRecords
  },
  sa: {
    name: 'South Australia', agency: 'SA CFS',
    url: 'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.json',
    format: 'json', parse: parseSa
  },
  tas: {
    name: 'Tasmania', agency: 'Tasmania Fire Service',
    url: 'https://www.fire.tas.gov.au/Show?pageId=colCurrentIncidents',
    format: 'text', parse: parseTas
  },
  nt: {
    name: 'Northern Territory', agency: 'NT PFES',
    url: 'https://www.pfes.nt.gov.au/incidentmap/json/incidents.json',
    format: 'json', parse: normaliseRecords
  },
  act: {
    name: 'Australian Capital Territory', agency: 'ACT ESA',
    url: 'https://data.esa.act.gov.au/feeds/esa-cap-incidents.xml',
    format: 'text', parse: parseAct
  }
};

/* Fetches and normalises one state, then caches the NORMALISED result.
   Parsing happens here -- on a cron tick -- rather than on a visitor's
   request, so serving a state is just a cache read with no JSON parsing at
   all. That matters on the Workers free plan, where a request invocation
   gets a small CPU budget; the expensive work stays on the scheduled path.
   A failure leaves the previous cache entry alone, so a state that blips
   keeps serving its last known-good list rather than going blank. */
async function refreshStateIncidents(state) {
  const feed = INCIDENT_FEEDS[state];
  if (!feed) return { ok: false, state, error: 'Unknown state' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(feed.url, {
      headers: { 'User-Agent': 'NewsRadar/1.0 (+https://drec-oncall-updates-site.lacey-wood.workers.dev)' },
      signal: ctrl.signal,
      cf: { cacheTtl: 0 }
    });
    if (!upstream.ok) {
      return { ok: false, state, error: 'Upstream returned HTTP ' + upstream.status };
    }

    const bodyText = await upstream.text();
    let parsed;
    if (feed.format === 'text') {
      parsed = feed.parse(bodyText);
    } else {
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        return { ok: false, state, error: 'Upstream did not return valid JSON' };
      }
      parsed = feed.parse(json);
    }

    const payload = {
      state: state.toUpperCase(),
      name: feed.name,
      agency: feed.agency,
      ok: true,
      count: parsed.incidents.length,
      incidents: parsed.incidents,
      fetchedAt: Date.now()
    };
    /* Zero incidents is a legitimate answer (a quiet day) AND the symptom of
       a schema change. The diagnostics block only appears in the second case
       -- when the parser could see records but recognised no fields -- so the
       two are distinguishable instead of both looking like "no incidents". */
    if (parsed.diagnostics) payload.diagnostics = parsed.diagnostics;

    await writeSharedCache(incidentCacheUrl(state), JSON.stringify(payload), 'application/json');
    return { ok: true, state, payload };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Upstream timed out after 15s' : err.message;
    return { ok: false, state, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/* Reads a state's cached payload, or null if it has never been written. */
async function readStateIncidents(state) {
  const cached = await readSharedCache(incidentCacheUrl(state));
  if (!cached) return null;
  try {
    const payload = await cached.response.json();
    payload.cacheAgeSeconds = Math.round(cached.ageSeconds);
    return payload;
  } catch (e) {
    return null;
  }
}

/* Builds the eight-state aggregate and caches it, so the "/api/incidents"
   route is also a plain cache read. Called at the end of a cron tick, once
   every state has had its turn. */
async function rebuildIncidentsAggregate() {
  const states = await Promise.all(INCIDENT_STATES.map(async (state) => {
    const payload = await readStateIncidents(state);
    if (payload) return payload;
    const feed = INCIDENT_FEEDS[state];
    return {
      state: state.toUpperCase(),
      name: feed.name,
      agency: feed.agency,
      ok: false,
      count: 0,
      incidents: [],
      error: 'No data cached yet for this state'
    };
  }));

  const aggregate = {
    states,
    builtAt: Date.now(),
    liveStates: states.filter((s) => s.ok).map((s) => s.state)
  };
  await writeSharedCache(INCIDENTS_ALL_CACHE_URL, JSON.stringify(aggregate), 'application/json');
  return aggregate;
}

/* Refreshes all eight states in parallel. One state failing never affects
   another -- Promise.allSettled, and each refresh swallows its own error
   into a result object rather than throwing. */
async function refreshAllIncidents() {
  const results = await Promise.allSettled(INCIDENT_STATES.map((s) => refreshStateIncidents(s)));
  await rebuildIncidentsAggregate();
  return results;
}

/* GET /api/incidents/<state> -- one state, normalised. Serves cache when
   there is one (the normal path); only a genuine cold start does a live
   fetch. Always returns a JSON body, including on failure, so the client can
   render a specific per-state reason instead of a generic error. */
async function handleIncidentsState(state) {
  const feed = INCIDENT_FEEDS[state];
  if (!feed) {
    return new Response(JSON.stringify({ ok: false, error: 'Unknown state: ' + state }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const cached = await readSharedCache(incidentCacheUrl(state));
  if (cached) return respondFromCache(cached);

  const result = await refreshStateIncidents(state);
  if (result.ok) {
    return new Response(JSON.stringify(result.payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  return new Response(JSON.stringify({
    state: state.toUpperCase(),
    name: feed.name,
    agency: feed.agency,
    officialUrl: feed.url,
    ok: false,
    count: 0,
    incidents: [],
    error: result.error
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/* GET /api/incidents -- all eight states in one response. The client uses
   this rather than firing eight parallel requests per page load: it carries
   the same per-state ok/error detail, but costs one request instead of
   eight against the Workers request budget. */
async function handleIncidentsAll() {
  const cached = await readSharedCache(INCIDENTS_ALL_CACHE_URL);
  if (cached) return respondFromCache(cached);

  /* Cold start only: populate every state, then build the aggregate. */
  await refreshAllIncidents();
  const rebuilt = await readSharedCache(INCIDENTS_ALL_CACHE_URL);
  if (rebuilt) return respondFromCache(rebuilt);

  const aggregate = await rebuildIncidentsAggregate();
  return new Response(JSON.stringify(aggregate), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/gdelt') {
      return handleGdelt();
    }

    /* /api/incidents and /api/incidents/<state> */
    if (url.pathname === '/api/incidents' || url.pathname === '/api/incidents/') {
      return handleIncidentsAll();
    }
    if (url.pathname.startsWith('/api/incidents/')) {
      const state = url.pathname.slice('/api/incidents/'.length).replace(/\/+$/, '').toLowerCase();
      return handleIncidentsState(state);
    }

    if (url.pathname === '/') {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index_updated_abc_emergency_map.html';
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    return env.ASSETS.fetch(request);
  },

  /* Fires on the cron schedule in wrangler.jsonc (every 5 minutes). Runs the
     news and incident refreshes independently via ctx.waitUntil so one
     failing doesn't stop the other, and so the Worker instance isn't
     recycled before both finish. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshGdeltCache());
    ctx.waitUntil(refreshAllIncidents());
  }
};
