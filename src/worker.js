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
  'sbs.com.au', '7news.com.au', 'theaustralian.com.au', 'insurancenews.com.au'];
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
      'X-Cache-Age': String(Math.round(cached.ageSeconds)),
      /* Which code is answering, as opposed to how old the answer is.
         "Did my change deploy?" and "has the cron refreshed since it did?"
         are separate questions and they get separate headers: the build
         stamp is set when the response is written, so it reflects the
         running Worker even when the body it is serving predates it. */
      'X-Worker-Build': WORKER_BUILD
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
/* Sources. Grouped by role rather than alphabetically, because the mix is
   the point: national wires for breaking coverage, the capital-city
   mastheads, and regional papers so incidents outside the capitals surface
   at all -- a house fire in Ballarat or a flood in Tamworth rarely reaches a
   national feed, and those are exactly the events this dashboard is for.

   `priority: true` marks the feeds used to bootstrap a cold start (see
   handleNews) so a fresh deploy has content immediately rather than waiting
   for the shard rotation to come round.

   Feeds marked UNVERIFIED could not be confirmed from this build environment
   (no outbound access to these hosts). They follow each publisher's usual
   pattern; any that are wrong show up as a failed feed in /api/news with the
   HTTP status, and cost nothing else. */
const NEWS_FEEDS = [
  /* --- national / wire --- */
  { name: 'ABC News', domain: 'abc.net.au', group: 'national', url: 'https://www.abc.net.au/news/feed/51120/rss.xml', priority: true },
  { name: 'ABC News', domain: 'abc.net.au', group: 'national', url: 'https://www.abc.net.au/news/feed/10719986/rss.xml', priority: true },
  { name: 'SBS News', domain: 'sbs.com.au', group: 'national', url: 'https://www.sbs.com.au/news/feed', priority: true },
  { name: '9News', domain: '9news.com.au', group: 'national', url: 'https://www.9news.com.au/rss', priority: true },
  { name: '7NEWS', domain: '7news.com.au', group: 'national', url: 'https://7news.com.au/feed', priority: true },
  /* Back in now that the feed can be filtered by source -- anyone who doesn't
     want it can simply deselect it rather than it having to be dropped
     wholesale. */
  { name: 'news.com.au', domain: 'news.com.au', group: 'national', url: 'https://www.news.com.au/content-feeds/latest-news-national/' },
  /* Guardian Australia's own AU edition feed. It was dropped back when the
     source was GDELT, because a domain-scoped search pulled in the whole
     international site; this feed is already AU-scoped, so that objection
     doesn't apply. */
  { name: 'Guardian Australia', domain: 'theguardian.com', group: 'national', url: 'https://www.theguardian.com/au/rss', priority: true },
  /* The Australian is paywalled -- headlines and standfirsts come through,
     but following a link will hit the paywall unless the reader subscribes.
     UNVERIFIED URL. */
  { name: 'The Australian', domain: 'theaustralian.com.au', group: 'national', url: 'https://www.theaustralian.com.au/feed/' },
  { name: 'AAP', domain: 'aap.com.au', group: 'national', url: 'https://www.aap.com.au/feed/' },                                  // UNVERIFIED
  { name: 'The New Daily', domain: 'thenewdaily.com.au', group: 'national', url: 'https://thenewdaily.com.au/feed/' },             // UNVERIFIED
  { name: 'The Conversation AU', domain: 'theconversation.com', group: 'national', url: 'https://theconversation.com/au/articles.atom' },

  /* --- capital-city mastheads (Nine + Seven West) --- */
  { name: 'Sydney Morning Herald', domain: 'smh.com.au', group: 'capital', url: 'https://www.smh.com.au/rss/feed.xml', priority: true },
  { name: 'The Age', domain: 'theage.com.au', group: 'capital', url: 'https://www.theage.com.au/rss/feed.xml' },
  { name: 'Brisbane Times', domain: 'brisbanetimes.com.au', group: 'capital', url: 'https://www.brisbanetimes.com.au/rss/feed.xml' },
  { name: 'WAtoday', domain: 'watoday.com.au', group: 'capital', url: 'https://www.watoday.com.au/rss/feed.xml' },
  { name: 'The West Australian', domain: 'thewest.com.au', group: 'capital', url: 'https://thewest.com.au/rss' },                 // UNVERIFIED

  /* --- regional / local (Australian Community Media, /rss.xml pattern) --- */
  { name: 'The Canberra Times', domain: 'canberratimes.com.au', group: 'regional', url: 'https://www.canberratimes.com.au/rss.xml' },
  { name: 'Newcastle Herald', domain: 'newcastleherald.com.au', group: 'regional', url: 'https://www.newcastleherald.com.au/rss.xml' },
  { name: 'Illawarra Mercury', domain: 'illawarramercury.com.au', group: 'regional', url: 'https://www.illawarramercury.com.au/rss.xml' },
  { name: 'The Examiner (Launceston)', domain: 'examiner.com.au', group: 'regional', url: 'https://www.examiner.com.au/rss.xml' },
  { name: 'The Advocate (Burnie)', domain: 'theadvocate.com.au', group: 'regional', url: 'https://www.theadvocate.com.au/rss.xml' },
  { name: 'The Border Mail', domain: 'bordermail.com.au', group: 'regional', url: 'https://www.bordermail.com.au/rss.xml' },
  { name: 'The Courier (Ballarat)', domain: 'thecourier.com.au', group: 'regional', url: 'https://www.thecourier.com.au/rss.xml' },
  { name: 'Bendigo Advertiser', domain: 'bendigoadvertiser.com.au', group: 'regional', url: 'https://www.bendigoadvertiser.com.au/rss.xml' },
  { name: 'Northern Daily Leader (Tamworth)', domain: 'northerndailyleader.com.au', group: 'regional', url: 'https://www.northerndailyleader.com.au/rss.xml' },
  { name: 'The Daily Advertiser (Wagga)', domain: 'dailyadvertiser.com.au', group: 'regional', url: 'https://www.dailyadvertiser.com.au/rss.xml' },
  { name: 'Central Western Daily (Orange)', domain: 'centralwesterndaily.com.au', group: 'regional', url: 'https://www.centralwesterndaily.com.au/rss.xml' },
  { name: 'The Land (rural NSW)', domain: 'theland.com.au', group: 'regional', url: 'https://www.theland.com.au/rss.xml' },

  /* --- trade press for the insurance category --- */
  /* UNVERIFIED: insuranceNEWS publishes RSS but lists the real addresses on a
     page unreachable from here (insurancenews.com.au/rss-channels). */
  { name: 'insuranceNEWS', domain: 'insurancenews.com.au', group: 'trade', url: 'https://www.insurancenews.com.au/rss/all-news' },

  /* --- world --- */
  /* Exempt from the client's AU-relevance filter, same as under GDELT. */
  { name: 'Al Jazeera', domain: 'aljazeera.com', group: 'world', url: 'https://www.aljazeera.com/xml/rss/all.xml', world: true, priority: true }
];

/* Stamped into /api/news so the page can tell whether the Worker serving it
   is the one that matches. Deploying the HTML without src/worker.js (or vice
   versa) has repeatedly looked like a code bug from the outside -- the page
   can now say which it is instead. Bump this whenever the news pipeline
   changes in a way the page depends on. */
const WORKER_BUILD = '2026-09-17-outages';

/* Deliberately much wider than the 24h the page prefers to display. The page
   falls back to older headlines when nothing recent is available rather than
   showing an empty feed, so this is the pool it draws that fallback from --
   it needs enough depth to cover a quiet stretch or a spell where several
   outlets are unreachable. Age is shown per article either way, so older
   items are never mistaken for current ones. */
const NEWS_WINDOW_MS = 7 * 24 * 3600 * 1000;

function parseRssArticles(xml, feed) {
  const out = [];
  const all = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  /* Feeds are newest-first, and only the last day or so is ever displayed, so
     parsing the whole backlog is wasted CPU -- which matters here, see the
     sharding note on refreshNewsShard(). */
  const items = all.slice(0, MAX_ITEMS_PER_FEED);
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
      group: feed.group,
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
    return { ok: true, text: await r.text(), contentType: r.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out after 15s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* A cheap look at the first bytes before committing to a full regex parse.
   Probing candidate paths means most responses are ordinary HTML pages, and
   running the item regex over a whole news homepage is exactly the kind of
   CPU cost that has to stay off this Worker. */
function looksLikeFeed(text, contentType) {
  if (/(rss|atom|xml)/i.test(contentType || '')) return true;
  const head = String(text || '').slice(0, 1000);
  return /<\?xml|<rss[\s>]|<feed[\s>]|<channel[\s>]/i.test(head);
}

/* Publishers move their feeds and rarely redirect the old address. Rather
   than one configured guess per outlet, a failing feed is probed against the
   handful of paths publishers actually use. Ordered by how common they are,
   so the usual answer is found in the first couple of requests.
   This is what recovers, for example, a masthead whose sibling works on
   /rss/feed.xml while it serves /rss/feed -- a difference no amount of
   guessing from outside would reliably land on. */
const FEED_PATH_CANDIDATES = ['/rss', '/feed', '/rss.xml', '/rss/feed',
  '/feed.xml', '/rss/feed.xml', '/index.xml', '/atom.xml'];
/* Hard cap on probe requests per feed. The cron tick also refreshes the whole
   shard and all eight incident feeds, and a Worker invocation may make at most
   50 subrequests -- so this is a budget, not a preference. Two feeds probe per
   tick (MAX_DISCOVERIES_PER_TICK), giving ~12 probes plus ~8 shard fetches
   plus the incident feeds: comfortably inside the ceiling. */
const MAX_PATH_PROBES = 6;

function feedProbeUrls(feed) {
  /* Probe paths on the configured URL's own origin. That host is known to
     resolve -- the configured feed came back with an HTTP status, not a
     network error -- so spending half a small budget on www/non-www variants
     would just halve the number of paths actually tried. */
  let origin;
  try {
    origin = new URL(feed.url).origin;
  } catch (e) {
    origin = 'https://' + feed.domain;
  }
  return FEED_PATH_CANDIDATES.slice(0, MAX_PATH_PROBES).map((path) => origin + path);
}

/* Refreshing every feed in one go would parse ~28 XML documents in a single
   invocation, and the Workers free plan allows 10ms of CPU per invocation --
   fetch waiting time is free, but parsing is not. So the feeds are split into
   shards and each 5-minute cron tick refreshes one shard: roughly seven feeds
   per tick, every feed refreshed every 20 minutes. That is ample for a news
   feed, and keeps each tick well inside the budget.

   Each feed's parsed articles are cached individually, and the merged list is
   rebuilt from those caches -- so the merged view always reflects every feed,
   regardless of which shard last ran. */
const MAX_ITEMS_PER_FEED = 20;
const NEWS_SHARDS = 4;

/* Every feed's articles and the merged list live together in ONE record.

   Two reasons. First, correctness across locations: the Cloudflare Cache API
   is per-datacentre, so the colo the cron happens to run in gets a warm cache
   while every other colo serves visitors from an empty one -- which is how a
   reader can land on a thin feed even when the background refresh is working
   perfectly. Workers KV is globally replicated, so one background write is
   readable everywhere immediately.

   Second, cost: KV's free tier allows 1,000 writes a day. Writing 30 feeds
   separately on a 5-minute cron would be ~2,300 and blow through that,
   whereas one record per tick is 288. Reading it is one KV read per page load
   against a 100,000/day allowance. A single record also means a request does
   one JSON parse instead of thirty, which keeps it well inside the
   per-request CPU budget.

   KV is optional. Bind a namespace as NEWS_KV (see wrangler.jsonc) and it is
   used; without one this falls back to the Cache API and behaves as before,
   so nothing breaks while the binding is being set up. */
const NEWS_STATE_KEY = 'news-state-v1';
const NEWS_STATE_CACHE_URL = 'https://newsradar-internal-cache.example/news-state';

async function readNewsState(env) {
  if (env && env.NEWS_KV) {
    try {
      const v = await env.NEWS_KV.get(NEWS_STATE_KEY, 'json');
      if (v) return v;
    } catch (e) { /* fall through to the cache copy */ }
  }
  const cached = await readSharedCache(NEWS_STATE_CACHE_URL);
  if (cached) {
    try { return await cached.response.json(); } catch (e) { /* unreadable */ }
  }
  return null;
}

async function writeNewsState(env, state) {
  const body = JSON.stringify(state);
  if (env && env.NEWS_KV) {
    try { await env.NEWS_KV.put(NEWS_STATE_KEY, body); } catch (e) { /* cache copy still written */ }
  }
  /* Always keep the local cache copy too: it serves this colo without a KV
     round trip, and it is the whole mechanism when no namespace is bound. */
  await writeSharedCache(NEWS_STATE_CACHE_URL, body, 'application/json');
}

/* Finds an outlet's real feed URL by reading its homepage, the same way a
   feed reader does: publishers advertise their feeds with
   <link rel="alternate" type="application/rss+xml" href="...">.

   This exists because the configured URLs cannot be verified from the build
   environment -- outbound access to these hosts is blocked here -- so several
   were educated guesses at each publisher's usual pattern, and a guess that's
   wrong fails silently for that outlet forever. Discovery removes the
   guesswork: get it wrong and the site itself tells us the right answer.
   Only the document head is scanned, and only when the configured URL has
   already failed, so the cost is bounded. */
async function discoverFeedUrl(feed) {
  const home = 'https://' + feed.domain + '/';
  const res = await fetchFeedText(home);
  if (!res.ok) return null;

  /* Feed links live in <head>; scanning a whole news homepage would be a lot
     of regex work for nothing. */
  const headEnd = res.text.search(/<\/head>/i);
  const head = res.text.slice(0, headEnd > 0 ? headEnd : 60000);

  const candidates = [];
  (head.match(/<link[^>]*>/gi) || []).forEach((tag) => {
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) return;
    const href = (/href=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href) return;
    const title = (/title=["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    try { candidates.push({ url: new URL(href, home).toString(), title }); } catch (e) { /* unusable href */ }
  });
  if (!candidates.length) return null;

  /* Prefer a general/latest feed over a section-specific one when the
     publisher advertises several. */
  const preferred = candidates.find((c) => /latest|top|all|news|home/i.test(c.title)) || candidates[0];
  return preferred.url;
}

/* Fetches and caches one feed. A failure deliberately keeps whatever articles
   were cached previously and just records the error alongside them, so a feed
   that blips doesn't vanish from the merged list.

   A configured URL that fails, or that responds but yields no articles at all
   (an HTML error page parses to zero items just as an empty feed does), falls
   through to discovery. Whatever discovery finds is remembered in this feed's
   own cache entry and tried first next time, so the homepage fetch happens
   once rather than every refresh. */
/* Refreshes one feed and returns its new state entry. Pure with respect to
   storage -- the caller collects the entries and writes the record once,
   rather than each feed writing separately. */
async function refreshOneFeed(feed, opts, previousEntry) {
  const allowDiscovery = !!(opts && opts.allowDiscovery);
  const previous = (previousEntry && previousEntry.articles) || [];
  const knownGood = (previousEntry && previousEntry.resolvedUrl) || null;

  const attempt = async (url) => {
    const res = await fetchFeedText(url);
    if (!res.ok) return { ok: false, error: res.error };
    if (!looksLikeFeed(res.text, res.contentType)) {
      return { ok: false, error: 'Not a feed — got ' + (/^\s*</.test(res.text) ? 'an HTML page' : 'unrecognised content') };
    }
    try {
      return { ok: true, articles: parseRssArticles(res.text, feed) };
    } catch (err) {
      return { ok: false, error: 'Parse failed: ' + err.message };
    }
  };

  const tried = [];
  let lastError = null, sawEmpty = false;

  /* A URL resolved on a previous run goes first -- it's the one known to work
     for this outlet. */
  const first = (knownGood && knownGood !== feed.url) ? [knownGood, feed.url] : [feed.url];
  for (const url of first) {
    tried.push(url);
    const r = await attempt(url);
    if (r.ok && r.articles.length) {
      /* `discovered` means "this is not the configured URL", not "found on
         this run" -- once a resolved URL is stored it gets tried first and
         would otherwise look like an ordinary success, losing the very fact
         that makes it worth folding back into NEWS_FEEDS. */
      return { articles: r.articles, resolvedUrl: url,
        discovered: url !== feed.url || undefined, fetchedAt: Date.now() };
    }
    if (r.ok) sawEmpty = true; else lastError = r.error;
  }

  if (allowDiscovery) {
    const candidates = [];
    const advertised = await discoverFeedUrl(feed);
    if (advertised) candidates.push(advertised);
    feedProbeUrls(feed).forEach((u) => candidates.push(u));

    for (const url of candidates) {
      if (tried.indexOf(url) !== -1) continue;
      tried.push(url);
      const r = await attempt(url);
      if (r.ok && r.articles.length) {
        return { articles: r.articles, resolvedUrl: url, discovered: true, fetchedAt: Date.now() };
      }
    }
  }

  /* Nothing worked. Keep whatever articles were already there and record why,
     distinguishing "the request failed" from "it answered but had nothing we
     could read" -- those need different fixes and shouldn't look the same. */
  return {
    articles: previous,
    resolvedUrl: knownGood || undefined,
    lastError: lastError || (sawEmpty ? 'Responded, but no articles could be read from it' : 'Unavailable'),
    triedUrls: tried,
    checkedAt: Date.now()
  };
}

/* Builds the merged, de-duplicated article list from the per-feed entries. */
function buildMergedNews(feedState) {
  const entries = NEWS_FEEDS.map((feed) => {
    const e = (feedState && feedState[feed.url]) || null;
    const articles = (e && e.articles) || [];
    return {
      name: feed.name, url: feed.url, group: feed.group,
      ok: !!(e && !e.lastError),
      /* Never tried here yet is not the same as tried and failed: on the
         Cache API a fresh datacentre starts with every feed pending, and
         showing those as "unavailable" makes a warming location look like a
         broken one. */
      pending: e ? undefined : true,
      count: articles.length,
      error: e ? e.lastError : 'Not fetched in this location yet',
      resolvedUrl: e ? e.resolvedUrl : undefined,
      discovered: e ? e.discovered : undefined,
      triedUrls: e ? e.triedUrls : undefined,
      articles
    };
  });

  const cutoff = Date.now() - NEWS_WINDOW_MS;
  const seenUrl = new Set();
  const seenTitle = new Set();
  const articles = [];
  entries.forEach((entry) => {
    entry.articles.forEach((a) => {
      if (!a || !a.pubMs || a.pubMs < cutoff || a.pubMs > Date.now() + 3600000) return;
      if (seenUrl.has(a.url)) return;
      /* The same story syndicated across outlets, or an outlet's own duplicate
         or AMP entry, would otherwise appear several times -- common now that
         metro and regional papers are both in the mix. */
      const key = String(a.title).trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
      if (seenTitle.has(key)) return;
      seenUrl.add(a.url);
      seenTitle.add(key);
      articles.push(a);
    });
  });
  articles.sort((a, b) => b.pubMs - a.pubMs);

  return {
    build: WORKER_BUILD,
    feedCount: NEWS_FEEDS.length,
    articles: articles.slice(0, 300),
    feeds: entries.map((e) => ({ name: e.name, url: e.url, group: e.group, ok: e.ok, count: e.count,
      pending: e.pending, error: e.error, resolvedUrl: e.resolvedUrl,
      discovered: e.discovered, triedUrls: e.triedUrls })),
    fetchedAt: Date.now(),
    newestPubMs: articles.length ? articles[0].pubMs : null
  };
}

/* Refreshes one shard's feeds, then rewrites the record. */
const MAX_DISCOVERIES_PER_TICK = 2;
async function refreshNewsShard(shard, tick, env) {
  const state = (await readNewsState(env)) || { feeds: {} };
  state.feeds = state.feeds || {};

  const due = NEWS_FEEDS.filter((_, i) => i % NEWS_SHARDS === shard);
  /* Offset by how many times THIS shard has run, not by the raw tick. A shard
     only runs every NEWS_SHARDS ticks, so a raw-tick offset advances by
     (NEWS_SHARDS * budget) each time -- which for a shard of 8 feeds and a
     budget of 2 is a step of 8, i.e. no movement at all. Counting the shard's
     own runs advances the window by exactly the budget, so it walks the whole
     list regardless of its length. */
  const runNo = Math.floor((tick || 0) / NEWS_SHARDS);
  const offset = (runNo * MAX_DISCOVERIES_PER_TICK) % (due.length || 1);
  const allowed = new Set();
  for (let k = 0; k < Math.min(MAX_DISCOVERIES_PER_TICK, due.length); k++) {
    allowed.add((offset + k) % due.length);
  }

  const results = await Promise.all(due.map((f, i) =>
    refreshOneFeed(f, { allowDiscovery: allowed.has(i) }, state.feeds[f.url])));
  due.forEach((f, i) => { state.feeds[f.url] = results[i]; });

  state.merged = buildMergedNews(state.feeds);
  state.updatedAt = Date.now();
  await writeNewsState(env, state);
  return state.merged;
}

/* Cold start only, on a visitor's request: fetch just enough to put something
   on the page, and nothing more. A handful of feeds with no discovery -- this
   runs inside a request's CPU budget, and the top-up below fills in the rest.

   One feed per outlet. Taking the first N priority feeds in list order spent
   two of three slots on ABC (it has two feeds), so a cold start that also lost
   SBS produced a page of nothing but ABC. */
const BOOTSTRAP_FEED_LIMIT = 4;
function bootstrapFeeds() {
  const seen = new Set();
  const picked = [];
  for (const feed of NEWS_FEEDS) {
    if (!feed.priority || seen.has(feed.domain)) continue;
    seen.add(feed.domain);
    picked.push(feed);
    if (picked.length >= BOOTSTRAP_FEED_LIMIT) break;
  }
  return picked;
}

async function bootstrapNews(env) {
  const state = (await readNewsState(env)) || { feeds: {} };
  state.feeds = state.feeds || {};
  const primary = bootstrapFeeds();
  const results = await Promise.all(primary.map((f) =>
    refreshOneFeed(f, { allowDiscovery: false }, state.feeds[f.url])));
  primary.forEach((f, i) => { state.feeds[f.url] = results[i]; });
  state.merged = buildMergedNews(state.feeds);
  state.updatedAt = Date.now();
  await writeNewsState(env, state);
  return state.merged;
}

/* The record is only as complete as whatever filled it in. With NEWS_KV bound
   the cron fills it once for everywhere; on the Cache API it can only warm the
   datacentre it happened to run in, so a reader routed anywhere else sees what
   the cold-start bootstrap managed -- and sees only that, indefinitely, since
   handleNews serves any non-empty record without looking further. That is the
   difference between a feed of four outlets and a feed of thirty.

   So every request advances the record a little, after its response has gone
   out: feeds never fetched in this location first, then the stalest. Rate
   limited, so a busy location does this about once a minute rather than once
   per visitor -- which walks the whole list in roughly the ten minutes the
   cron rotation would take anyway. */
/* Two speeds, because filling a cold record and keeping a warm one fresh are
   different jobs. Filling is a race the visitor is watching -- they are
   looking at a spinner until it finishes -- so it runs in big steps with
   barely any gap. Refreshing is housekeeping nobody is waiting on, so it goes
   back to a slow trickle. At the cold rate a thirty-feed list is complete in
   about twenty seconds of polling; at the warm rate a feed is re-read every
   fifteen minutes or so. */
const TOPUP_FEEDS_COLD = 6;
const TOPUP_FEEDS_WARM = 3;
const TOPUP_INTERVAL_COLD_MS = 3 * 1000;
const TOPUP_INTERVAL_WARM_MS = 60 * 1000;
const TOPUP_STALE_MS = 15 * 60 * 1000;

/* Cold means at least one feed has never been fetched in this location -- not
   "the record is old". A record where everything has been tried once is warm
   even if all of it is now stale. */
function newsRecordIsCold(state) {
  const feeds = (state && state.feeds) || {};
  return NEWS_FEEDS.some((f) => !feeds[f.url]);
}

function feedsNeedingTopUp(state, limit) {
  const now = Date.now();
  const due = [];
  NEWS_FEEDS.forEach((feed) => {
    const entry = state.feeds[feed.url];
    if (!entry) { due.push({ feed, at: 0 }); return; }
    const at = entry.fetchedAt || entry.checkedAt || 0;
    if (now - at >= TOPUP_STALE_MS) due.push({ feed, at });
  });
  due.sort((a, b) => a.at - b.at);
  return due.slice(0, limit).map((d) => d.feed);
}

async function topUpNews(env) {
  const state = await readNewsState(env);
  if (!state) return;
  state.feeds = state.feeds || {};
  const cold = newsRecordIsCold(state);
  const now = Date.now();
  if (state.topUpAt && now - state.topUpAt < (cold ? TOPUP_INTERVAL_COLD_MS : TOPUP_INTERVAL_WARM_MS)) return;
  const due = feedsNeedingTopUp(state, cold ? TOPUP_FEEDS_COLD : TOPUP_FEEDS_WARM);
  if (!due.length) return;

  /* Two requests arriving together will both read, both refresh and the later
     write wins, losing the other's feeds until they come round again. Harmless
     at this cadence, and cheaper than coordinating. */
  state.topUpAt = now;
  const results = await Promise.all(due.map((f) =>
    refreshOneFeed(f, { allowDiscovery: false }, state.feeds[f.url])));
  due.forEach((f, i) => { state.feeds[f.url] = results[i]; });
  state.merged = buildMergedNews(state.feeds);
  state.updatedAt = Date.now();
  await writeNewsState(env, state);
}

/* Counts the feeds this location has actually tried, which is not the same as
   the number configured -- the gap is the whole cold-start story, so it goes
   in a header rather than staying invisible. */
function coveredFeedCount(state) {
  const feeds = (state && state.feeds) || {};
  return NEWS_FEEDS.filter((f) => feeds[f.url]).length;
}

async function handleNews(env, ctx) {
  const state = await readNewsState(env);
  if (state && state.merged && state.merged.articles && state.merged.articles.length) {
    /* Queued after the response, so the reader waits for none of it. */
    if (ctx && ctx.waitUntil) ctx.waitUntil(topUpNews(env).catch(() => {}));
    return new Response(JSON.stringify(state.merged), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-News-Age': String(Math.round((Date.now() - (state.updatedAt || 0)) / 1000)),
        'X-News-Store': (env && env.NEWS_KV) ? 'kv' : 'cache',
        'X-News-Feeds': coveredFeedCount(state) + '/' + NEWS_FEEDS.length
      }
    });
  }

  /* Nothing usable stored yet. Bootstrap a little, and never let a failure
     here take the route down -- the page handles an empty list gracefully and
     the cron will fill the record shortly. */
  let merged;
  try {
    merged = await bootstrapNews(env);
  } catch (err) {
    return new Response(JSON.stringify({
      build: WORKER_BUILD, articles: [], feeds: [],
      error: 'Cold-start bootstrap failed: ' + err.message
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (!merged.articles.length) merged.warming = true; // cron hasn't populated the record yet
  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-News-Store': (env && env.NEWS_KV) ? 'kv' : 'cache',
      'X-News-Feeds': String(bootstrapFeeds().length) + '/' + NEWS_FEEDS.length
    }
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
  /* 'when' itself is here because the table reader keys its records by the
     normalised field name -- without it a scraped "Last updated" column would
     be found, mapped, and then dropped on the way out. */
  when: ['updated', 'lastupdate', 'lastupdated', 'last_update', 'pubdate', 'created',
    'datetime', 'reported', 'starttime', 'timestamp', 'date', 'time', 'when']
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

/* ---------- reading a table out of a page ----------
   Several publishers -- electricity operators and at least one emergency
   agency -- put their current list on a page as an ordinary HTML table,
   alongside a map that is a JavaScript application a Worker cannot run. The
   table is the better target: it is linked from their own site, it is
   rendered on the server, and it is meant to stay readable.

   None of these pages could be inspected from the build environment, so the
   reader is driven by the table's own headings rather than by column
   positions -- a fixed layout would be a guess stacked on a guess. Callers
   supply the heading vocabulary for their domain; everything else is shared.

   The three outcomes are kept distinct, because they need different fixes:
   no table at all (the list is drawn client-side, so a data endpoint is
   needed instead), a table whose headings could not be matched (and here
   they are), or a table that was read. */

const TABLE_HTML_LIMIT = 400000; // guard against a page that is mostly inline script
const TABLE_CELL_LIMIT = 200;    // one runaway description shouldn't become the row

function headingToField(heading, hints) {
  const key = String(heading).toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return null;
  /* Hints are in priority order and the first match wins, so more specific
     vocabulary has to come first: "incident type" is a type, not an incident,
     and "areas affected" is a place, not a customer count. */
  for (const hint of hints) {
    for (const w of hint.words) if (key.includes(w)) return hint.field;
  }
  return null;
}

function tableCells(rowHtml) {
  const cells = [];
  const re = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripTags(m[1]).slice(0, TABLE_CELL_LIMIT));
  return cells;
}

/* Reads one table into records keyed by field name. Returns null when it has
   no usable heading row at all, so the caller can move on to the next table
   rather than treating a layout or navigation table as the answer. */
function readTableWith(tableHtml, hints, requiredField) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(tableHtml)) !== null) rows.push(m[1]);
  /* A header row on its own is kept, not discarded: a publisher with nothing
     to report publishes exactly that, and treating it as unreadable would
     turn a quiet day into a reported fault. */
  if (!rows.length) return null;

  /* The heading row is the first made of <th>, falling back to the first row
     -- plenty of these tables use <td> throughout. */
  let headIndex = rows.findIndex((r) => /<th\b/i.test(r));
  if (headIndex === -1) headIndex = 0;
  const headings = tableCells(rows[headIndex]);
  if (!headings.length) return null;

  const map = headings.map((h) => headingToField(h, hints));
  /* `mapped` is what separates "this is the list and it is empty" from "this
     is some other table": both yield no rows, and only the first is news. */
  if (!map.some((f) => f === requiredField)) return { headings, mapped: false, records: [] };

  const records = [];
  for (let i = headIndex + 1; i < rows.length; i++) {
    const cells = tableCells(rows[i]);
    if (!cells.length) continue;
    const rec = {};
    map.forEach((field, col) => {
      if (!field) return;
      const v = (cells[col] || '').trim();
      if (v && !rec[field]) rec[field] = v;
    });
    if (rec[requiredField]) records.push(rec);
  }
  return { headings, mapped: true, records };
}

/* Finds the list table on a page. Returns { records } on success, or
   { diagnostics } naming what was actually there. */
function scrapeTable(html, hints, requiredField) {
  const text = String(html || '').slice(0, TABLE_HTML_LIMIT);
  const tables = [];
  const re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(text)) !== null) tables.push(m[1]);

  if (!tables.length) {
    return { diagnostics: {
      envelope: 'no-table',
      recordsSeen: 0,
      note: /<html/i.test(text)
        ? 'Page loaded but contains no <table> — the list is probably rendered by JavaScript, so a data endpoint is needed instead'
        : 'Response was not HTML',
      sampleKeys: []
    } };
  }

  /* Several tables on a page is normal. Take the one that yields the most
     usable rows rather than the first, which is often layout or navigation. */
  let best = null;
  const headingsSeen = [];
  tables.forEach((t) => {
    const read = readTableWith(t, hints, requiredField);
    if (!read) return;
    read.headings.forEach((h) => { if (h && headingsSeen.indexOf(h) === -1) headingsSeen.push(h); });
    if (!read.mapped) return;
    if (!best || read.records.length > best.records.length) best = read;
  });

  if (!best) {
    return { diagnostics: {
      envelope: 'table-unmapped',
      recordsSeen: 0,
      note: 'Found ' + tables.length + ' table(s) but no column could be matched to a ' + requiredField,
      sampleKeys: headingsSeen.slice(0, 25)
    } };
  }
  return { records: best.records };
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
/* SecureNT publishes the NT's current bushfire alerts as a table on
   securent.nt.gov.au/respond/bushfire-alerts -- location, the message, and
   the alert level ("Advice", "Watch and Act", "Emergency Warning", "Planned
   Burn Advice"). That page is the Territory's own published list, which
   makes it a better primary than the incident map's internal JSON.

   Headings drive the mapping (see scrapeTable), so a column being renamed or
   reordered doesn't break it, and a column this doesn't recognise is
   reported by name rather than silently dropped. The message column is read
   as the incident's type/detail: it is the only place the actual fire is
   described, and TABLE_CELL_LIMIT keeps a long one from swamping the row. */
const INCIDENT_COLUMN_HINTS = [
  { field: 'when', words: ['updated', 'issued', 'published', 'datetime', 'date', 'time', 'reported'] },
  { field: 'status', words: ['alertlevel', 'alert', 'level', 'status', 'warning', 'severity'] },
  { field: 'type', words: ['incidenttype', 'type', 'category', 'message', 'description', 'detail'] },
  { field: 'title', words: ['location', 'area', 'place', 'suburb', 'region', 'locality',
    'incident', 'name', 'fire', 'title', 'event'] }
];

function parseIncidentTable(html) {
  const read = scrapeTable(html, INCIDENT_COLUMN_HINTS, 'title');
  if (read.diagnostics) return { incidents: [], diagnostics: read.diagnostics };
  /* An alerts page with the table present and no rows means no current
     alerts, which is the good outcome and must not read as a broken feed. */
  if (!read.records.length) return { incidents: [] };
  return normaliseRecords({ rows: read.records });
}

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
  /* SecureNT's bushfire alerts page is the Territory's own published list of
     current alerts, so it leads. The PFES incident map's JSON stays behind it
     as a fallback: it covers all incident types rather than bushfires alone,
     which makes it a wider net but a less direct answer to "what is alerting
     right now". */
  nt: {
    name: 'Northern Territory', agency: 'Bushfires NT / SecureNT',
    sources: [
      { url: 'https://securent.nt.gov.au/respond/bushfire-alerts', format: 'text', parse: parseIncidentTable },
      { url: 'https://securent.nt.gov.au/alerts-warnings', format: 'text', parse: parseIncidentTable },
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

/* ============================================================
   ELECTRICITY OUTAGES -- per state, from the network operators
   ============================================================
   This replaces an embedded third-party outage map. That map was a single
   iframe from one aggregator: when it stopped rendering there was nothing to
   fall back to, no way to tell "no outages" from "the embed broke", and no
   way to see anything per state.

   Electricity distribution in Australia is carved up by operator, not by
   state, so a state's picture is the union of two or three networks -- NSW is
   Ausgrid plus Endeavour plus Essential, Victoria is five. Each is fetched
   independently and reported independently, so one operator being unreachable
   degrades that state's list to "partial, and here's who is missing" rather
   than to nothing.

   ENDPOINT STATUS. Operators publish this data to their own outage maps
   rather than as documented open APIs, and this build environment cannot
   reach any of these hosts (every request is refused at the proxy before it
   leaves), so nothing here could be confirmed by trying it. Two are confirmed
   from published descriptions of the services instead, and carry
   `confirmed: true`:

     Energy Queensland  plain GeoJSON files, planned and unplanned separately
                        (energex_po_current_*.geojson, ergon_po_current_*)
     Western Power      a public anonymous ArcGIS feature service,
                        WP_Outage_Prod/FeatureServer/0

   The rest are read from each operator's own text or list view of current
   outages -- the accessible alternative to the map that most of them
   publish. That is a better target than the map's internal endpoint for two
   reasons: the page is findable and linked from their own site, where the
   endpoint is undocumented and changes without notice; and the page is
   rendered on the server, where the map is a JavaScript application a Worker
   cannot run. Whether any given one really does render its table server-side
   could not be checked from here, so parseOutageTable says which of the
   three things happened -- no table on the page (so it is drawn by
   JavaScript and needs a data endpoint after all), a table whose headings it
   could not match (and what those headings were), or a table it read.

   Those operators report as `unconfirmed` rather than as unavailable until
   one of their sources works, because "we have not connected this operator
   yet" and "this operator's feed is down" are different claims and only one
   of them is true. Every attempt is recorded with its HTTP status and a body
   excerpt in /api/outages/<state>. Correcting one is a single line below. */

const OUTAGE_STATES = ['nsw', 'qld', 'vic', 'sa', 'wa', 'tas', 'nt', 'act'];

function outageCacheUrl(state) {
  return 'https://newsradar-internal-cache.example/outages/' + state;
}
const OUTAGES_ALL_CACHE_URL = 'https://newsradar-internal-cache.example/outages-all';

/* Candidate field names per normalised field, matched case-insensitively and
   in priority order -- the same approach as the incident feeds, for the same
   reason: a dozen operators with no shared schema between them. */
const OUTAGE_FIELDS = {
  /* AFFECTED_AREA and NOCUSTOMERSIMPACTED are Western Power's real column
     names, confirmed from its published feature service; EVENT_ID is Energy
     Queensland's. The rest stay broad for the operators whose schema still
     hasn't been seen. */
  location: ['affected_area', 'affectedarea', 'suburb', 'suburbs', 'locality', 'localities',
    'location', 'locationname', 'location_name', 'area', 'areas', 'town', 'place',
    'street', 'streets', 'address', 'region', 'name', 'title'],
  status: ['status', 'outagestatus', 'currentstatus', 'jobstatus', 'stage', 'progress', 'phase'],
  cause: ['cause', 'reason', 'outagecause', 'causedescription', 'causedesc', 'faulttype',
    'description', 'comment', 'comments', 'details', 'event', 'eventdescription'],
  /* The total first: Western Power also carries AFFECTED_AREA_NOCUSTOMERS,
     which is a per-area breakdown and would understate the outage. */
  customers: ['nocustomersimpacted', 'customersaffected', 'customeraffected', 'affectedcustomers',
    'numcustomersaffected', 'numcustomers', 'custaffected', 'customercount', 'noofcustomers',
    'impactedcustomers', 'customers', 'custs', 'numberofcustomers', 'affected_area_nocustomers'],
  start: ['outagestarttime', 'starttime', 'startdate', 'start', 'begin', 'reportedtime',
    'reported', 'firstreported', 'datereported', 'created', 'createddate', 'timeoff', 'timeadded'],
  restore: ['estimatedrestorationtime', 'estimatedrestoretime', 'estimatedrestoration',
    'expectedrestoration', 'restorationtime', 'restoretime', 'etr', 'eta', 'timeon',
    'estimatedtimeofrestoration', 'estrestoretime', 'estimatedon', 'restore'],
  kind: ['plannedoutage', 'outagetype', 'type', 'plannedtype', 'worktype', 'jobtype',
    'category', 'classification', 'kind'],
  id: ['incidentref', 'event_id', 'outageid', 'jobid', 'eventid', 'incidentid', 'enarnumber',
    'id', 'reference', 'ref', 'objectid']
};

function pickOutageField(lowered, kind) {
  const candidates = OUTAGE_FIELDS[kind] || [];
  for (const name of candidates) {
    const v = lowered[name];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    const s = String(v).trim();
    if (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined') return s;
  }
  return '';
}

/* Customer counts arrive as numbers, numeric strings, "1,234", or a range
   like "50-100". Anything that isn't a definite number stays absent rather
   than becoming a 0 -- "0 customers affected" and "the operator didn't say"
   are very different claims to put on a dashboard. */
function parseCustomerCount(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const s = String(raw).replace(/,/g, '').trim();
  const m = /^(\d+)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return isFinite(n) ? n : null;
}

/* Planned works and faults read very differently to someone checking whether
   their power is coming back, so they are separated when the operator says
   which it is -- and left unlabelled when it doesn't, rather than guessed. */
function classifyOutage(kindText, statusText, causeText) {
  /* Western Power answers this with a PLANNEDOUTAGE flag rather than a word,
     and the flag arrives as a boolean, "Yes"/"No" or 1/0 depending on the
     output format asked for. Checked before the text match, because "No"
     contains none of the words below and would otherwise fall through to
     unlabelled. */
  const flag = String(kindText).trim().toLowerCase();
  if (flag === 'true' || flag === 'yes' || flag === '1') return 'planned';
  if (flag === 'false' || flag === 'no' || flag === '0') return 'unplanned';
  const hay = (kindText + ' ' + statusText + ' ' + causeText).toLowerCase();
  if (/\bunplanned|\bfault|emergency|unexpected/.test(hay)) return 'unplanned';
  if (/\bplanned|\bscheduled|maintenance/.test(hay)) return 'planned';
  return '';
}

/* Shape-tolerant normaliser for one operator's payload. Same contract as
   normaliseRecords(): returns the rows, plus `diagnostics` only when
   something genuinely looks wrong, so a network with no outages reads as
   quiet rather than broken. */
/* `opts.kindHint` is for operators that split planned from unplanned across
   separate files rather than flagging it on the record -- Energy Queensland
   does this -- so the file the row came from is the only thing that knows. A
   value carried on the record itself still wins. */
function normaliseOutages(json, opts) {
  const kindHint = (opts && opts.kindHint) || '';
  const { records, envelope } = collectRecords(json);
  const outages = [];
  records.forEach(({ props, geometry }) => {
    const lowered = lowerKeyMap(props);
    const location = pickOutageField(lowered, 'location');
    const id = pickOutageField(lowered, 'id');
    /* A row with neither a place nor an identifier can't be shown or
       de-duplicated, so it isn't a row. */
    if (!location && !id) return;
    const status = pickOutageField(lowered, 'status');
    const cause = pickOutageField(lowered, 'cause');
    const kindText = pickOutageField(lowered, 'kind');
    const start = normaliseWhen(pickOutageField(lowered, 'start'));
    const restore = normaliseWhen(pickOutageField(lowered, 'restore'));
    outages.push(Object.assign({
      id: id || undefined,
      location: location || 'Outage ' + id,
      status: status || undefined,
      cause: cause || undefined,
      kind: classifyOutage(kindText, status, cause) || kindHint || undefined,
      customers: parseCustomerCount(pickOutageField(lowered, 'customers')),
      start: start.when || undefined,
      startIso: start.whenIso,
      restore: restore.when || undefined,
      restoreIso: restore.whenIso
    }, pickCoords(props, geometry)));
  });

  const result = { outages };
  const noListFound = envelope === 'unrecognised';
  if (!outages.length && (records.length > 0 || noListFound)) {
    const sample = records.length && records[0].props ? Object.keys(records[0].props).slice(0, 25) : [];
    result.diagnostics = { envelope, recordsSeen: records.length, sampleKeys: sample };
  }
  return result;
}

/* ---------- the operators' text/list views ----------
   Most distributors publish a plain list or "text view" of current outages
   alongside the map. See scrapeTable() for why the page is the better target
   and how it is read. "affected" on its own is deliberately NOT a customer
   word -- "Affected areas" is a heading several of them use for the place. */
const OUTAGE_COLUMN_HINTS = [
  { field: 'restore', words: ['restor', 'estimat', 'etr', 'expected', 'backon'] },
  { field: 'start', words: ['start', 'began', 'begun', 'reported', 'commenc', 'since', 'timeoff'] },
  { field: 'customers', words: ['customer', 'premises', 'properties', 'impacted', 'supplies'] },
  { field: 'kind', words: ['planned', 'unplanned', 'outagetype', 'type', 'category'] },
  { field: 'id', words: ['reference', 'jobno', 'jobnumber', 'eventid', 'outageid', 'incident'] },
  { field: 'status', words: ['status', 'progress', 'stage', 'crew'] },
  { field: 'cause', words: ['cause', 'reason', 'fault', 'description', 'details', 'event'] },
  { field: 'location', words: ['suburb', 'locality', 'location', 'area', 'town', 'street',
    'address', 'region', 'place', 'name'] }
];

function parseOutageTable(html, opts) {
  const read = scrapeTable(html, OUTAGE_COLUMN_HINTS, 'location');
  if (read.diagnostics) return { outages: [], diagnostics: read.diagnostics };
  /* The table was found and understood. No rows means the operator has
     nothing out -- a result, not a failure -- so it returns a clean empty
     list with no diagnostics to make it look broken. */
  if (!read.records.length) return { outages: [] };
  return normaliseOutages({ rows: read.records }, opts);
}

/* The distribution networks, by state. `area` is what the operator actually
   covers -- worth showing, because "Essential Energy is unavailable" means
   something quite different in Sydney than it does in Dubbo.

   Each operator lists its candidate data URLs in order; the first that
   answers with recognisable rows wins and the rest aren't tried. `site` is
   the operator's own outage page, always shown so there is a way through even
   when every candidate fails. */
const OUTAGE_NETWORKS = {
  nsw: {
    name: 'New South Wales',
    networks: [
      /* Ausgrid publishes a list view of its outage map -- a page, not an
         application, so it can be read server-side. */
      { name: 'Ausgrid', area: 'Sydney, Central Coast and the Hunter',
        site: 'https://www.ausgrid.com.au/outages-list',
        sources: [
          { url: 'https://www.ausgrid.com.au/outages-list', format: 'text', parse: parseOutageTable },
          { url: 'https://www.ausgrid.com.au/Outages/Current-Outages', format: 'text', parse: parseOutageTable }
        ] },
      { name: 'Endeavour Energy', area: "Sydney's greater west, Blue Mountains, Southern Highlands and Illawarra",
        site: 'https://www.endeavourenergy.com.au/power-outages/outage-map',
        sources: [
          { url: 'https://www.endeavourenergy.com.au/power-outages/current-outages', format: 'text', parse: parseOutageTable },
          { url: 'https://www.endeavourenergy.com.au/power-outages/outage-map', format: 'text', parse: parseOutageTable }
        ] },
      { name: 'Essential Energy', area: 'Regional and rural NSW',
        site: 'https://www.essentialenergy.com.au/outages-and-faults/power-outages',
        sources: [
          { url: 'https://www.essentialenergy.com.au/outages-and-faults/power-outages', format: 'text', parse: parseOutageTable },
          { url: 'https://www.essentialenergy.com.au/outages-and-faults', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  /* Energy Queensland is the one operator whose feeds are properly confirmed:
     it publishes plain GeoJSON files, and they split planned from unplanned
     across separate files rather than flagging it per record -- hence
     `combine` (fetch both and merge, rather than first-one-wins) and the
     kind hints. A third file each, *_po_future_planned.geojson, carries works
     scheduled for later; left out deliberately, since a dashboard of what is
     happening now shouldn't be padded with next month's roadworks. */
  qld: {
    name: 'Queensland',
    networks: [
      { name: 'Energex', area: 'South East Queensland', confirmed: true, combine: true,
        site: 'https://www.energex.com.au/outages/outage-finder/outage-finder-map',
        sources: [
          { url: 'https://www.energex.com.au/static/Energex/energex_po_current_unplanned.geojson',
            format: 'json', parse: (j) => normaliseOutages(j, { kindHint: 'unplanned' }) },
          { url: 'https://www.energex.com.au/static/Energex/energex_po_current_planned.geojson',
            format: 'json', parse: (j) => normaliseOutages(j, { kindHint: 'planned' }) }
        ] },
      { name: 'Ergon Energy', area: 'Regional Queensland', confirmed: true, combine: true,
        site: 'https://www.ergon.com.au/network/outages/outage-finder/outage-finder-map',
        sources: [
          { url: 'https://www.ergon.com.au/static/Ergon/ergon_po_current_unplanned.geojson',
            format: 'json', parse: (j) => normaliseOutages(j, { kindHint: 'unplanned' }) },
          { url: 'https://www.ergon.com.au/static/Ergon/ergon_po_current_planned.geojson',
            format: 'json', parse: (j) => normaliseOutages(j, { kindHint: 'planned' }) },
          /* Ergon's own text view, as a backstop if the static files move. */
          { url: 'https://www.ergon.com.au/network/outages/outage-finder/outage-finder-text-view', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  vic: {
    name: 'Victoria',
    networks: [
      /* AusNet's tracker is a Salesforce Sites page, which is rendered on the
         server -- more promising for a scrape than the main site's map. */
      { name: 'AusNet Services', area: 'Eastern and north-eastern Victoria',
        site: 'https://www.ausnetservices.com.au/outages',
        sources: [
          { url: 'https://ausnetservices.my.salesforce-sites.com/OutageTracker/', format: 'text', parse: parseOutageTable },
          { url: 'https://www.ausnetservices.com.au/outages', format: 'text', parse: parseOutageTable }
        ] },
      /* CitiPower, Powercor and United Energy are one operator group on one
         platform, and each publishes the same "full outage list" page. */
      { name: 'Powercor', area: 'Western Victoria',
        site: 'https://www.powercor.com.au/power-outages-and-emergencies/full-outage-list/',
        sources: [
          { url: 'https://www.powercor.com.au/power-outages-and-emergencies/full-outage-list/', format: 'text', parse: parseOutageTable }
        ] },
      { name: 'CitiPower', area: 'Inner Melbourne',
        site: 'https://www.citipower.com.au/power-outages-and-emergencies/full-outage-list/',
        sources: [
          { url: 'https://www.citipower.com.au/power-outages-and-emergencies/full-outage-list/', format: 'text', parse: parseOutageTable }
        ] },
      { name: 'United Energy', area: 'South-eastern Melbourne and the Mornington Peninsula',
        site: 'https://www.unitedenergy.com.au/power-outages-and-emergencies/full-outage-list/',
        sources: [
          { url: 'https://www.unitedenergy.com.au/power-outages-and-emergencies/full-outage-list/', format: 'text', parse: parseOutageTable }
        ] },
      { name: 'Jemena', area: 'North-western Melbourne',
        site: 'https://jemena.com.au/electricity/outages',
        sources: [
          { url: 'https://jemena.com.au/electricity/outages', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  sa: {
    name: 'South Australia',
    networks: [
      /* SA Power Networks runs its outage report as a separate application
         rather than a page on the main site, and publishes no list view that
         could be found. These are the app's own paths -- the most likely
         place a readable list lives. */
      { name: 'SA Power Networks', area: 'All of South Australia',
        site: 'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageMap',
        sources: [
          { url: 'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageList', format: 'text', parse: parseOutageTable },
          { url: 'https://outage.apps.sapowernetworks.com.au/OutageReport/api/outages', format: 'json', parse: normaliseOutages },
          { url: 'https://www.sapowernetworks.com.au/outages/', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  wa: {
    name: 'Western Australia',
    networks: [
      /* Western Power's outage map is backed by a public, anonymous ArcGIS
         feature service. Its columns (AFFECTED_AREA, NOCUSTOMERSIMPACTED,
         OUTAGESTARTTIME, ESTIMATEDRESTORATIONTIME, PLANNEDOUTAGE, INCIDENTREF)
         are in OUTAGE_FIELDS. resultRecordCount is well under the service's
         2,000 page size and keeps one bad day from returning a payload this
         Worker has to parse inside a small CPU budget. */
      { name: 'Western Power', area: 'South-west interconnected system (Perth and the south-west)',
        confirmed: true,
        site: 'https://www.westernpower.com.au/faults-outages/power-outages/',
        sources: [
          { url: 'https://services2.arcgis.com/tBLxde4cxSlNUxsM/ArcGIS/rest/services/WP_Outage_Prod/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&resultRecordCount=400&f=geojson',
            format: 'json', parse: normaliseOutages },
          { url: 'https://services2.arcgis.com/tBLxde4cxSlNUxsM/ArcGIS/rest/services/WP_Outage_Prod/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=400&f=json',
            format: 'json', parse: normaliseOutages }
        ] },
      { name: 'Horizon Power', area: 'Regional and remote WA',
        site: 'https://www.horizonpower.com.au/faults-outages/',
        sources: [
          { url: 'https://www.horizonpower.com.au/faults-outages/power-outages/', format: 'text', parse: parseOutageTable },
          { url: 'https://www.horizonpower.com.au/faults-outages/', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  tas: {
    name: 'Tasmania',
    networks: [
      { name: 'TasNetworks', area: 'All of Tasmania',
        site: 'https://www.tasnetworks.com.au/current-power-outages',
        sources: [
          { url: 'https://www.tasnetworks.com.au/current-power-outages', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  nt: {
    name: 'Northern Territory',
    networks: [
      { name: 'Power and Water Corporation', area: 'All of the Northern Territory',
        site: 'https://www.powerwater.com.au/outages',
        sources: [
          { url: 'https://www.powerwater.com.au/outages/current-outages', format: 'text', parse: parseOutageTable },
          { url: 'https://www.powerwater.com.au/outages', format: 'text', parse: parseOutageTable }
        ] }
    ]
  },
  act: {
    name: 'Australian Capital Territory',
    networks: [
      { name: 'Evoenergy', area: 'All of the ACT',
        site: 'https://www.evoenergy.com.au/Outages',
        sources: [
          { url: 'https://www.evoenergy.com.au/Outages', format: 'text', parse: parseOutageTable },
          { url: 'https://www.actewagl.com.au/outages', format: 'text', parse: parseOutageTable }
        ] }
    ]
  }
};

/* A hard ceiling on upstream calls for one state's refresh. Victoria alone has
   five operators with candidates each; on a bad day where everything fails,
   an unbounded sweep would eat the invocation's 50-subrequest budget and
   starve the news and incident refreshes sharing that tick. Operators past
   the ceiling are reported as not-yet-checked, not as failed. */
const MAX_OUTAGE_ATTEMPTS_PER_STATE = 7;

/* Fetches every operator in a state, normalises, and caches the result.
   Parsing happens here on the cron rather than on a visitor's request, for
   the same CPU-budget reason as the incident feeds. A total failure leaves
   the previous cache entry in place. */
async function refreshStateOutages(state) {
  const group = OUTAGE_NETWORKS[state];
  if (!group) return { ok: false, state, error: 'Unknown state' };

  let budget = MAX_OUTAGE_ATTEMPTS_PER_STATE;
  const networks = [];

  for (const net of group.networks) {
    const entry = { name: net.name, area: net.area, site: net.site, ok: false, count: 0, outages: [] };
    const attempts = [];
    let drifted = null;

    for (const source of net.sources) {
      if (budget <= 0) break;
      budget--;
      /* tryIncidentSource is the generic "fetch, check, parse, never throw"
         step -- the same headers, timeout and HTML-instead-of-JSON detection
         apply here, so it is reused rather than duplicated. */
      const result = await tryIncidentSource(source);
      if (!result.ok) { attempts.push({ url: source.url, error: result.error }); continue; }
      if (result.parsed.diagnostics) {
        attempts.push({ url: source.url, error: 'Responded, but no recognisable outage fields' });
        if (!drifted) drifted = { source, parsed: result.parsed };
        continue;
      }
      entry.ok = true;
      entry.outages = entry.outages.concat(result.parsed.outages);
      entry.count = entry.outages.length;
      entry.sourceUrl = entry.sourceUrl || source.url;
      /* `combine` means the sources are complementary parts of one picture
         (planned and unplanned in separate files), not fallbacks for each
         other -- so keep going instead of stopping at the first success. */
      if (!net.combine) break;
    }

    if (!entry.ok && drifted) {
      /* Answered, shape unrecognised. That is a parser fix, not an outage, so
         it is reported as reachable-but-undreadable rather than as down. */
      entry.ok = true;
      entry.sourceUrl = drifted.source.url;
      entry.diagnostics = drifted.parsed.diagnostics;
    }
    if (!entry.ok) {
      entry.error = attempts.length
        ? (attempts.length === 1 ? attempts[0].error
          : 'All ' + attempts.length + ' sources failed — ' + attempts.map((a) => a.error).join(' | '))
        : 'Not checked on this pass';
      /* An operator whose endpoint was never confirmed failing is a different
         claim from a confirmed one going down: the first means we haven't
         found its feed yet, the second means its feed is broken. Reporting
         both as "unavailable" would be telling the reader we looked when we
         haven't. */
      if (!net.confirmed) entry.unconfirmed = true;
    }
    if (attempts.length) entry.attempts = attempts;
    networks.push(entry);
  }

  /* Merge for the state-level list, tagging each row with the operator that
     reported it -- without that tag a list spanning three networks gives no
     way to tell which one to ring. */
  const outages = [];
  networks.forEach((net) => {
    (net.outages || []).forEach((o) => { outages.push(Object.assign({ network: net.name }, o)); });
  });
  outages.sort((a, b) => {
    const ca = a.customers === null || a.customers === undefined ? -1 : a.customers;
    const cb = b.customers === null || b.customers === undefined ? -1 : b.customers;
    if (cb !== ca) return cb - ca;
    return (Date.parse(b.startIso || 0) || 0) - (Date.parse(a.startIso || 0) || 0);
  });

  const reporting = networks.filter((n) => n.ok);
  const customers = outages.reduce((sum, o) => sum + (o.customers || 0), 0);
  const payload = {
    state: state.toUpperCase(),
    name: group.name,
    /* ok means at least one operator answered. A state is never all-or-
       nothing here: the per-network list below says exactly who is in. */
    ok: reporting.length > 0,
    count: outages.length,
    customers,
    /* Only meaningful if every operator reported, so the client can say
       "partial" instead of quoting a total that silently excludes a network. */
    complete: reporting.length === networks.length,
    outages: outages.slice(0, 400),
    truncated: outages.length > 400 || undefined,
    networks: networks.map((n) => ({
      name: n.name, area: n.area, site: n.site, ok: n.ok, count: n.count,
      customers: (n.outages || []).reduce((s, o) => s + (o.customers || 0), 0),
      error: n.error, unconfirmed: n.unconfirmed, sourceUrl: n.sourceUrl,
      diagnostics: n.diagnostics, attempts: n.attempts
    })),
    fetchedAt: Date.now()
  };

  await writeSharedCache(outageCacheUrl(state), JSON.stringify(payload), 'application/json');
  return { ok: true, state, payload };
}

async function readStateOutages(state) {
  const cached = await readSharedCache(outageCacheUrl(state));
  if (!cached) return null;
  try {
    const payload = await cached.response.json();
    payload.cacheAgeSeconds = Math.round(cached.ageSeconds);
    return payload;
  } catch (e) {
    return null;
  }
}

/* The aggregate carries per-state totals and network status but NOT every
   outage row -- a storm across two states can run to hundreds of rows, and
   the page only ever displays one state at a time. The tabs render from this;
   selecting a state fetches that state's own route for the list. */
async function rebuildOutagesAggregate() {
  const states = await Promise.all(OUTAGE_STATES.map(async (state) => {
    const payload = await readStateOutages(state);
    const group = OUTAGE_NETWORKS[state];
    if (!payload) {
      return {
        state: state.toUpperCase(), name: group.name, ok: false, count: 0, customers: 0,
        complete: false, networks: group.networks.map((n) => ({
          name: n.name, area: n.area, site: n.site, ok: false, count: 0,
          error: 'No data cached yet for this network'
        })),
        error: 'No data cached yet for this state'
      };
    }
    const { outages, ...rest } = payload;
    return rest;
  }));

  const aggregate = {
    states,
    builtAt: Date.now(),
    liveStates: states.filter((s) => s.ok).map((s) => s.state)
  };
  await writeSharedCache(OUTAGES_ALL_CACHE_URL, JSON.stringify(aggregate), 'application/json');
  return aggregate;
}

/* Refreshes one shard of states. Outages are sharded across cron ticks where
   the incident feeds are not, because there are far more operators than
   agencies -- sweeping all eight states every tick would compete with the
   news and incident refreshes for the same invocation's subrequest budget.
   Two shards at a 5-minute cron means every state is re-read every 10
   minutes, which is well inside how fast an operator updates its own map. */
const OUTAGE_SHARDS = 2;
async function refreshOutageShard(shard) {
  const due = OUTAGE_STATES.filter((_, i) => i % OUTAGE_SHARDS === shard);
  await Promise.allSettled(due.map((s) => refreshStateOutages(s)));
  await rebuildOutagesAggregate();
}

/* GET /api/outages/<state> -- one state's full list. */
async function handleOutagesState(state) {
  const group = OUTAGE_NETWORKS[state];
  if (!group) {
    return new Response(JSON.stringify({ ok: false, error: 'Unknown state: ' + state }), {
      status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  const cached = await readSharedCache(outageCacheUrl(state));
  if (cached) return respondFromCache(cached);

  const result = await refreshStateOutages(state);
  return new Response(JSON.stringify(result.payload || {
    state: state.toUpperCase(), name: group.name, ok: false, count: 0, outages: [],
    error: result.error || 'Refresh failed'
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/* GET /api/outages -- every state's totals and per-network status, no rows. */
async function handleOutagesAll() {
  const cached = await readSharedCache(OUTAGES_ALL_CACHE_URL);
  if (cached) return respondFromCache(cached);
  const aggregate = await rebuildOutagesAggregate();
  return new Response(JSON.stringify(aggregate), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/* The /api routes, split out so every one of them can be stamped with the
   build in one place rather than each handler remembering to. */
async function handleApi(url, env, ctx) {
  if (url.pathname === '/api/news') return handleNews(env, ctx);
  if (url.pathname === '/api/gdelt') return handleGdelt();

  if (url.pathname === '/api/incidents' || url.pathname === '/api/incidents/') return handleIncidentsAll();
  if (url.pathname.startsWith('/api/incidents/')) {
    return handleIncidentsState(url.pathname.slice('/api/incidents/'.length).replace(/\/+$/, '').toLowerCase());
  }

  if (url.pathname === '/api/outages' || url.pathname === '/api/outages/') return handleOutagesAll();
  if (url.pathname.startsWith('/api/outages/')) {
    return handleOutagesState(url.pathname.slice('/api/outages/'.length).replace(/\/+$/, '').toLowerCase());
  }
  return null;   // not an API route we serve; fall through to the assets
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* Every /api response carries the build stamp, so the deployed version is
       one header away on any route rather than something to infer from
       whether the data looks new. */
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(url, env, ctx);
      if (res && !res.headers.get('X-Worker-Build')) {
        const stamped = new Response(res.body, res);
        stamped.headers.set('X-Worker-Build', WORKER_BUILD);
        return stamped;
      }
      if (res) return res;
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
    /* Rotate through the news shards so each tick parses only its share --
       see refreshNewsShard() for why. Derived from the scheduled time rather
       than kept in memory, since a Worker isn't guaranteed to be the same
       instance between ticks.

       Counted in absolute 5-minute periods since the epoch, NOT as
       minute-of-hour. A minute-of-hour tick only ever takes 12 values, so a
       given shard would only ever see 3 of them -- and since the discovery
       slot rotates with the tick, feeds at the other positions in that shard
       would never get a discovery attempt at all. An absolute counter keeps
       advancing, so every position comes round. */
    const nowMs = event && event.scheduledTime ? event.scheduledTime : Date.now();
    const tick = Math.floor(nowMs / 300000);
    ctx.waitUntil(refreshNewsShard(tick % NEWS_SHARDS, tick, env));
    ctx.waitUntil(refreshAllIncidents());
    /* Half the states per tick -- see refreshOutageShard for why outages are
       sharded when the incident feeds are not. */
    ctx.waitUntil(refreshOutageShard(tick % OUTAGE_SHARDS));
    /* GDELT stays on the cron only as a fallback for /api/gdelt; the page
       reads /api/news first. Its refresh failing is expected and harmless. */
    /* GDELT is only a fallback for /api/gdelt and rejects most attempts
       anyway; running it every tick alongside the news shard and all eight
       incident feeds pushes one invocation toward the subrequest and CPU
       ceilings. Once an hour is plenty for a backstop. */
    if (tick % 12 === 0) ctx.waitUntil(refreshGdeltCache().catch(() => {}));
  }
};
