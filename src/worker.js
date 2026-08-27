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
   NEWS -- straight from the outlets' own RSS feeds
   ============================================================
   GDELT (above) is kept as a fallback, but it can no longer be the primary
   source. It rate-limits per client IP, and a Worker goes out through
   Cloudflare's shared egress range, so we are competing for that budget with
   every other Cloudflare customer calling GDELT. In practice it rejects
   almost every attempt with 429 regardless of how infrequently we ask --
   pre-warming on a cron and retrying on 429 both helped and neither fixed
   it, because the limit isn't ours to stay under. When the cache eventually
   expired with no successful refresh behind it, the page fell all the way
   back to the hard-coded sample headlines, which is how a visitor ended up
   reading month-old articles presented as today's news.

   Reading each outlet's own RSS feed removes the middleman: no key, no
   shared quota, no single point of failure. These are merged rather than
   tried in sequence -- one outlet being down costs its share of the
   coverage, not the whole feed -- and per-feed status travels with the
   payload so a silently-dead source is visible rather than just meaning
   fewer articles. */
const NEWS_FEEDS = [
  { name: 'ABC News', domain: 'abc.net.au', url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
  { name: 'ABC News', domain: 'abc.net.au', url: 'https://www.abc.net.au/news/feed/10719986/rss.xml' },
  { name: 'SBS News', domain: 'sbs.com.au', url: 'https://www.sbs.com.au/news/feed' },
  { name: 'news.com.au', domain: 'news.com.au', url: 'https://www.news.com.au/content-feeds/latest-news-national/' },
  { name: '9News', domain: '9news.com.au', url: 'https://www.9news.com.au/rss' },
  { name: '7NEWS', domain: '7news.com.au', url: 'https://7news.com.au/feed' },
  { name: 'Sydney Morning Herald', domain: 'smh.com.au', url: 'https://www.smh.com.au/rss/feed.xml' },
  /* Trade press for the insurance category. UNVERIFIED URL: insuranceNEWS
     publishes RSS but lists the real feed addresses on a page this build
     environment can't reach (insurancenews.com.au/rss-channels), so this is
     the conventional path rather than a confirmed one. If it 404s it simply
     shows as a failed feed in the payload's `feeds` array and costs nothing
     else -- swap in the correct URL from that page. */
  { name: 'insuranceNEWS', domain: 'insurancenews.com.au', url: 'https://www.insurancenews.com.au/rss/all-news' },
  /* Dedicated World source -- exempt from the client's AU-relevance filter,
     same as it was under GDELT. */
  { name: 'Al Jazeera', domain: 'aljazeera.com', url: 'https://www.aljazeera.com/xml/rss/all.xml', world: true }
];

const NEWS_CACHE_URL = 'https://newsradar-internal-cache.example/news';
/* Deliberately much wider than the 24h the page prefers to display. The page
   falls back to older headlines when nothing recent is available rather than
   showing an empty feed, so this is the pool it draws that fallback from --
   it needs enough depth to cover a quiet stretch or a spell where several
   outlets are unreachable. Age is shown per article either way, so older
   items are never mistaken for current ones. */
const NEWS_WINDOW_MS = 7 * 24 * 3600 * 1000;

function parseRssArticles(xml, feed) {
  const out = [];
  const items = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  items.forEach((item) => {
    const tag = (name) => {
      const m = new RegExp('<' + name + '(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>', 'i').exec(item);
      return m ? stripTags(m[1]) : '';
    };
    const title = tag('title');
    if (!title) return;
    /* RSS puts the URL in <link>text</link>; Atom uses <link href="..."/>
       with no closing tag, so the element parse returns nothing there. */
    let link = tag('link');
    if (!link) {
      const m = /<link[^>]*href="([^"]+)"/i.exec(item);
      link = m ? m[1].replace(/&amp;/g, '&') : '';
    }
    if (!link) return;

    const when = tag('pubDate') || tag('published') || tag('updated') || tag('dc:date');
    const pubMs = Date.parse(when);
    /* An undated item can't be aged or ordered, and dating it "now" would
       promote stale content to the top of the feed. Skipping it is visible
       in the per-feed count rather than silently wrong. */
    if (isNaN(pubMs)) return;

    const summary = tag('description') || tag('summary') || tag('content');
    out.push({
      title,
      url: link,
      domain: feed.domain,
      source: feed.name,
      summary: summary && summary.length > 300 ? summary.slice(0, 300) + '…' : summary,
      pubMs,
      world: !!feed.world
    });
  });
  return out;
}

async function fetchFeedText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: FEED_REQUEST_HEADERS, signal: ctrl.signal, redirect: 'follow', cf: { cacheTtl: 0 } });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, text: await r.text() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out after 15s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshNewsCache() {
  const results = await Promise.all(NEWS_FEEDS.map(async (feed) => {
    const res = await fetchFeedText(feed.url);
    if (!res.ok) return { feed, ok: false, error: res.error, articles: [] };
    try {
      return { feed, ok: true, articles: parseRssArticles(res.text, feed) };
    } catch (err) {
      return { feed, ok: false, error: 'Parse failed: ' + err.message, articles: [] };
    }
  }));

  const cutoff = Date.now() - NEWS_WINDOW_MS;
  const seenUrl = new Set();
  const seenTitle = new Set();
  const articles = [];
  results.forEach((r) => {
    r.articles.forEach((a) => {
      if (a.pubMs < cutoff || a.pubMs > Date.now() + 3600000) return; // ignore stale and implausibly-future items
      if (seenUrl.has(a.url)) return;
      /* The same story syndicated across outlets, or an outlet's own
         duplicate/AMP entry, would otherwise appear several times. */
      const key = a.title.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
      if (seenTitle.has(key)) return;
      seenUrl.add(a.url);
      seenTitle.add(key);
      articles.push(a);
    });
  });
  articles.sort((a, b) => b.pubMs - a.pubMs);

  const payload = {
    articles: articles.slice(0, 300),
    feeds: results.map((r) => ({
      name: r.feed.name,
      url: r.feed.url,
      ok: r.ok,
      count: r.articles.length,
      error: r.error
    })),
    fetchedAt: Date.now(),
    newestPubMs: articles.length ? articles[0].pubMs : null
  };

  /* Never overwrite a good cache with an empty one -- if every outlet is
     unreachable this round, the previous articles are far better than none. */
  if (!payload.articles.length) {
    const existing = await readSharedCache(NEWS_CACHE_URL);
    if (existing) return { ok: false, error: 'No articles retrieved; kept previous cache', payload };
  }
  await writeSharedCache(NEWS_CACHE_URL, JSON.stringify(payload), 'application/json');
  return { ok: true, payload };
}

async function handleNews() {
  const cached = await readSharedCache(NEWS_CACHE_URL);
  if (cached) return respondFromCache(cached);

  const result = await refreshNewsCache();
  return new Response(JSON.stringify(result.payload), {
    status: result.payload.articles.length ? 200 : 502,
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

/* Several agencies sit behind a WAF that rejects requests which don't look
   like a normal browser -- an unrecognised User-Agent, or a missing Accept
   header, is enough to get a 403 from a cloud IP even though the data itself
   is public and the same URL answers fine from a desktop or a plain script.
   These are ordinary client headers, not an attempt to get at anything
   non-public: every feed here is a published, documented public data source.
   Sent to every upstream so no single agency needs a special case. */
const FEED_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)',
  'Accept': 'application/json, application/geo+json, application/xml, text/xml, application/rss+xml, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Cache-Control': 'no-cache'
};

/* Short, readable excerpt of an unexpected response body. A WAF block page,
   a maintenance notice and a genuine API error all arrive as "HTTP 403" or
   "HTTP 503" otherwise, and they need completely different fixes -- so the
   first line of what actually came back is worth carrying into the error. */
function bodyExcerpt(text) {
  const clean = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 160 ? clean.slice(0, 160) + '…' : clean;
}

/* Agencies routinely pack the useful detail into one free-text description
   ("Status: Under Control  Type: Bushfire  Updated: ...") instead of using
   discrete elements. Splitting that reliably needs a known label vocabulary:
   trying to infer where a label starts is genuinely ambiguous once newlines
   have been collapsed to spaces -- in "Status: Under Control Type: Bushfire"
   the text "Control Type:" looks exactly like a label, which silently
   truncates the status to "Under".
   Longer labels are listed before the shorter ones they contain, so
   "Alert Level:" wins over "Level:" and "Incident Type:" over "Type:". */
const FEED_LABELS = ['alert level', 'incident type', 'last updated', 'fire district',
  'warning level', 'status', 'type', 'level', 'updated', 'location', 'region',
  'size', 'agency', 'category', 'council', 'started'];

function labelledFields(text) {
  const alt = FEED_LABELS.map((l) => l.replace(/ /g, '\\s+')).join('|');
  const re = new RegExp('\\b(' + alt + ')\\s*:\\s*', 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    marks.push({ key: m[1].toLowerCase().replace(/\s+/g, ' '), start: m.index, end: re.lastIndex });
  }
  const out = {};
  marks.forEach((mk, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const value = text.slice(mk.end, stop).trim().replace(/[|,;·]+$/, '').trim();
    if (value && out[mk.key] === undefined) out[mk.key] = value; // first occurrence wins
  });
  return out;
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

/* RSS / GeoRSS / Atom. Several agencies publish a syndication feed alongside
   (or instead of) a JSON one, and those tend to live on a plainer host that
   is less likely to be sitting behind the same WAF as the main site -- which
   makes them a useful second source when the primary is being refused. */
function parseGeoRss(xml) {
  const incidents = [];
  const items = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  items.forEach((item) => {
    const tag = (name) => {
      const m = new RegExp('<' + name + '(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>', 'i').exec(item);
      return m ? stripTags(m[1]) : '';
    };
    const title = tag('title');
    if (!title) return;
    const desc = tag('description') || tag('summary') || tag('content');
    /* GeoRSS carries position as "<georss:point>lat lon</georss:point>". */
    const pt = /<georss:point>\s*([-\d.]+)[\s,]+([-\d.]+)\s*<\/georss:point>/i.exec(item);
    const coords = pt ? { lat: Number(pt[1]), lon: Number(pt[2]) } : {};
    /* This text has already been through stripTags(), so the newlines that
       separated the labels are now spaces -- see labelledFields(). */
    const f = labelledFields(desc);
    incidents.push(Object.assign(
      {
        title,
        status: f.status || f['alert level'] || f['warning level'] || f.level || tag('category') || '',
        type: f['incident type'] || f.type || 'Incident'
      },
      normaliseWhen(tag('updated') || tag('pubDate') || tag('published') || f.updated || f['last updated']),
      coords
    ));
  });
  const result = { incidents };
  if (!incidents.length && !items.length) result.diagnostics = { envelope: 'rss', itemsSeen: 0 };
  return result;
}

/* KML. Tasmania publishes its incidents this way (as does a fair bit of
   Australian emergency data), and it carries richer per-incident detail than
   the HTML page this replaces -- type, status, agency and coordinates are
   discrete rather than needing to be scraped out of a layout.
   Handles both conventions for the detail fields: a description blob with
   "Status: x" style labels, and ExtendedData <Data name="STATUS"> elements. */
function parseKml(xml) {
  const incidents = [];
  const marks = xml.match(/<Placemark[\s>][\s\S]*?<\/Placemark>/gi) || [];
  marks.forEach((mark) => {
    const tag = (name) => {
      const m = new RegExp('<' + name + '(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>', 'i').exec(mark);
      return m ? stripTags(m[1]) : '';
    };
    const title = tag('name');
    if (!title) return;

    /* ExtendedData wins when present -- it's structured, where the
       description is free text that varies between agencies. */
    const ext = {};
    const dataEls = mark.match(/<Data\s+name="[^"]*"[\s\S]*?<\/Data>/gi) || [];
    dataEls.forEach((d) => {
      const key = (/name="([^"]*)"/i.exec(d) || [])[1];
      const val = (/<value>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/value>/i.exec(d) || [])[1];
      if (key) ext[key.toLowerCase()] = stripTags(val || '');
    });

    const f = labelledFields(tag('description'));

    /* KML coordinates are "lon,lat[,altitude]" -- the reverse of the lat/lon
       order these feeds use in text, so getting this backwards would put
       every Tasmanian incident in the wrong hemisphere. */
    let coords = {};
    const c = /<coordinates>\s*([-\d.]+)\s*,\s*([-\d.]+)/i.exec(mark);
    if (c) coords = { lon: Number(c[1]), lat: Number(c[2]) };

    incidents.push(Object.assign(
      {
        title,
        status: pickField(ext, 'status') || f.status || f['alert level'] || f.level || '',
        type: pickField(ext, 'type') || f['incident type'] || f.type || 'Incident'
      },
      normaliseWhen(pickField(ext, 'when') || f.updated || f['last updated'] || tag('TimeStamp')),
      coords
    ));
  });
  const result = { incidents };
  if (!incidents.length && !marks.length) result.diagnostics = { envelope: 'kml', placemarksSeen: 0 };
  return result;
}

/* The registry. Each state lists one or more `sources`, tried in order until
   one returns usable data -- so a primary that starts refusing cloud traffic
   degrades to a secondary rather than to an empty tab. `format` says how to
   read the body; `parse` turns it into normalised incidents. Anything using
   normaliseRecords is going through the shape-tolerant path described in the
   section header. */
const INCIDENT_FEEDS = {
  nsw: {
    name: 'New South Wales', agency: 'NSW RFS',
    sources: [
      { url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json', format: 'json', parse: parseNsw },
      { url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.xml', format: 'text', parse: parseGeoRss }
    ]
  },
  qld: {
    name: 'Queensland', agency: 'QFES ESCAD',
    sources: [
      { url: 'https://services1.arcgis.com/vkTwD8kHw2woKBqV/arcgis/rest/services/ESCAD_Current_Incidents_Public/FeatureServer/0/query?f=geojson&where=1%3D1&outFields=*', format: 'json', parse: normaliseRecords }
    ]
  },
  vic: {
    name: 'Victoria', agency: 'VicEmergency',
    sources: [
      { url: 'https://emergency.vic.gov.au/public/events-geojson.json', format: 'json', parse: normaliseRecords },
      { url: 'https://www.emergency.vic.gov.au/public/events-geojson.json', format: 'json', parse: normaliseRecords }
    ]
  },
  /* WA's primary JSON feed is the documented one and answers fine from an
     ordinary client, but has been refusing this Worker. Falling back to
     DFES's own api. host covers the case where it's the main site's WAF
     doing the refusing. Note the fallback carries WARNINGS only, not every
     incident, so it is a reduced view rather than an equivalent one -- which
     is why it is second, and why the payload records which source answered. */
  wa: {
    name: 'Western Australia', agency: 'Emergency WA',
    sources: [
      { url: 'https://www.emergency.wa.gov.au/data/incident_FCAD.json', format: 'json', parse: normaliseRecords },
      { url: 'https://api.emergency.wa.gov.au/v1/rss/warnings', format: 'text', parse: parseGeoRss, partial: 'warnings only' },
      { url: 'https://www.emergency.wa.gov.au/data/message_FCAD.json', format: 'json', parse: normaliseRecords }
    ]
  },
  sa: {
    name: 'South Australia', agency: 'SA CFS',
    sources: [
      { url: 'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.json', format: 'json', parse: parseSa }
    ]
  },
  /* Tasmania was originally pointed at a TFS web page and scraped, because
     that was the URL to hand -- but TasALERT publishes the same incidents as
     real data feeds, which is both more reliable and much less likely to
     break on a site redesign. RSS first, then TasALERT's KML, then TFS's own
     KML, with the old HTML scrape kept as a last resort. */
  tas: {
    name: 'Tasmania', agency: 'Tasmania Fire Service / TasALERT',
    sources: [
      { url: 'https://alert.tas.gov.au/data/incidents-and-alerts.xml', format: 'text', parse: parseGeoRss },
      { url: 'https://alert.tas.gov.au/data/incidents-and-messages.kml', format: 'text', parse: parseKml },
      { url: 'https://www.fire.tas.gov.au/Show?pageId=bfKml', format: 'text', parse: parseKml },
      { url: 'https://www.fire.tas.gov.au/Show?pageId=colCurrentIncidents', format: 'text', parse: parseTas }
    ]
  },
  nt: {
    name: 'Northern Territory', agency: 'NT PFES',
    sources: [
      { url: 'https://www.pfes.nt.gov.au/incidentmap/json/incidents.json', format: 'json', parse: normaliseRecords }
    ]
  },
  act: {
    name: 'Australian Capital Territory', agency: 'ACT ESA',
    sources: [
      { url: 'https://data.esa.act.gov.au/feeds/esa-cap-incidents.xml', format: 'text', parse: parseAct }
    ]
  }
};

/* Fetches and normalises one state, then caches the NORMALISED result.
   Parsing happens here -- on a cron tick -- rather than on a visitor's
   request, so serving a state is just a cache read with no JSON parsing at
   all. That matters on the Workers free plan, where a request invocation
   gets a small CPU budget; the expensive work stays on the scheduled path.
   A failure leaves the previous cache entry alone, so a state that blips
   keeps serving its last known-good list rather than going blank. */
/* Tries one source and reports precisely what happened. Never throws -- an
   unreachable host is a result, not an exception, because the caller needs to
   move on to the next source either way. */
async function tryIncidentSource(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(source.url, {
      headers: FEED_REQUEST_HEADERS,
      signal: ctrl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0 }
    });
    if (!upstream.ok) {
      const excerpt = bodyExcerpt(await upstream.text().catch(() => ''));
      return { ok: false, error: 'HTTP ' + upstream.status + (excerpt ? ' — ' + excerpt : '') };
    }

    const bodyText = await upstream.text();
    if (source.format === 'text') return { ok: true, parsed: source.parse(bodyText) };

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      /* A JSON endpoint answering with HTML is the classic signature of a
         WAF interstitial or a login/maintenance page, so say what it
         actually sent rather than just "invalid JSON". */
      return { ok: false, error: 'Expected JSON, got ' + (/^\s*</.test(bodyText) ? 'HTML' : 'unparseable data') +
        (bodyExcerpt(bodyText) ? ' — ' + bodyExcerpt(bodyText) : '') };
    }
    return { ok: true, parsed: source.parse(json) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out after 15s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshStateIncidents(state) {
  const feed = INCIDENT_FEEDS[state];
  if (!feed) return { ok: false, state, error: 'Unknown state' };

  const attempts = [];
  let drifted = null; // a source that answered but whose shape wasn't recognised

  for (const source of feed.sources) {
    const result = await tryIncidentSource(source);
    if (!result.ok) {
      attempts.push({ url: source.url, error: result.error });
      continue;
    }
    /* A recognised response wins immediately. One that parsed to nothing
       *and* flagged drift is held back: a later source may still work, and
       only if none does is the drift reported. */
    if (result.parsed.diagnostics) {
      attempts.push({ url: source.url, error: 'Responded, but no recognisable incident fields' });
      if (!drifted) drifted = { source, parsed: result.parsed };
      continue;
    }

    const payload = {
      state: state.toUpperCase(),
      name: feed.name,
      agency: feed.agency,
      ok: true,
      count: result.parsed.incidents.length,
      incidents: result.parsed.incidents,
      sourceUrl: source.url,
      fetchedAt: Date.now()
    };
    /* Flag when the answer came from a reduced fallback, so "0 incidents"
       from a warnings-only source isn't read as "nothing is happening". */
    if (source.partial) payload.partial = source.partial;
    if (attempts.length) payload.attempts = attempts; // earlier sources that failed
    await writeSharedCache(incidentCacheUrl(state), JSON.stringify(payload), 'application/json');
    return { ok: true, state, payload };
  }

  /* Every source answered but none was recognisable -- report it as a schema
     problem (ok, with diagnostics) rather than an outage, since that's what
     it is and it needs a parser fix, not a retry. */
  if (drifted) {
    const payload = {
      state: state.toUpperCase(),
      name: feed.name,
      agency: feed.agency,
      ok: true,
      count: 0,
      incidents: [],
      sourceUrl: drifted.source.url,
      diagnostics: drifted.parsed.diagnostics,
      attempts,
      fetchedAt: Date.now()
    };
    await writeSharedCache(incidentCacheUrl(state), JSON.stringify(payload), 'application/json');
    return { ok: true, state, payload };
  }

  return {
    ok: false,
    state,
    error: attempts.length === 1 ? attempts[0].error
      : 'All ' + attempts.length + ' sources failed — ' + attempts.map((a) => a.error).join(' | '),
    attempts
  };
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
    ok: false,
    count: 0,
    incidents: [],
    error: result.error,
    /* Every source tried and exactly why each one failed. Hitting
       /api/incidents/<state> in a browser is the fastest way to tell a WAF
       block apart from a timeout, a moved URL or a schema change. */
    attempts: result.attempts || []
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

    if (url.pathname === '/api/news') {
      return handleNews();
    }

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
    ctx.waitUntil(refreshNewsCache());
    ctx.waitUntil(refreshAllIncidents());
    /* GDELT stays on the cron only as a fallback for /api/gdelt; the page
       reads /api/news first. Its refresh failing is expected and harmless. */
    ctx.waitUntil(refreshGdeltCache().catch(() => {}));
  }
};
