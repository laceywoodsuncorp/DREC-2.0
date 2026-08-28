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
const WORKER_BUILD = '2026-08-28-topup';

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
const TOPUP_FEEDS_PER_RUN = 3;
const TOPUP_MIN_INTERVAL_MS = 60 * 1000;
const TOPUP_STALE_MS = 15 * 60 * 1000;

function feedsNeedingTopUp(state) {
  const now = Date.now();
  const due = [];
  NEWS_FEEDS.forEach((feed) => {
    const entry = state.feeds[feed.url];
    if (!entry) { due.push({ feed, at: 0 }); return; }
    const at = entry.fetchedAt || entry.checkedAt || 0;
    if (now - at >= TOPUP_STALE_MS) due.push({ feed, at });
  });
  due.sort((a, b) => a.at - b.at);
  return due.slice(0, TOPUP_FEEDS_PER_RUN).map((d) => d.feed);
}

async function topUpNews(env) {
  const state = await readNewsState(env);
  if (!state) return;
  state.feeds = state.feeds || {};
  const now = Date.now();
  if (state.topUpAt && now - state.topUpAt < TOPUP_MIN_INTERVAL_MS) return;
  const due = feedsNeedingTopUp(state);
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      return handleNews(env, ctx);
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
    /* GDELT stays on the cron only as a fallback for /api/gdelt; the page
       reads /api/news first. Its refresh failing is expected and harmless. */
    /* GDELT is only a fallback for /api/gdelt and rejects most attempts
       anyway; running it every tick alongside the news shard and all eight
       incident feeds pushes one invocation toward the subrequest and CPU
       ceilings. Once an hour is plenty for a backstop. */
    if (tick % 12 === 0) ctx.waitUntil(refreshGdeltCache().catch(() => {}));
  }
};
