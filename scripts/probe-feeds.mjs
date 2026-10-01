/* Finds a site's real feed addresses instead of guessing at them.

   insuranceNEWS has never once loaded, and its entry in the Worker says why
   in its own comment: "UNVERIFIED -- insuranceNEWS publishes RSS but lists
   the real addresses on a page unreachable from here". So a path was invented,
   shipped, and has been failing quietly ever since behind a feed list that
   says a source returned nothing. A guessed URL is not a source.

   Guessing again would be the same mistake, so this uses autodiscovery, which
   is how a site is supposed to be asked: the <link rel="alternate"
   type="application/rss+xml"> tags in its head are the addresses the
   publisher intends you to use. Anchors containing rss/feed/.xml are gathered
   too, since plenty of sites list their channels on a page without declaring
   them all in the head.

   Every candidate is then actually fetched and parsed, because a URL that
   exists is not the same as a feed that has items in it -- which is the
   distinction this project keeps having to make.

   Run: node scripts/probe-feeds.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

/* Pages to ask for their feeds.

   The news list has no source at all for the Northern Territory, for Far
   North Queensland, or for South Australia -- a whole capital and state. For
   a dashboard about disasters that is the wrong set to be blind in: the Top
   End and the far north are cyclone country.

   ABC leads the list because it is the most promising route. The feed list
   already reads two ABC feeds by numeric id, and the ABC publishes a feed per
   region on the same infrastructure -- same publisher, open RSS, no paywall.
   The News Corp mastheads that own Cairns, Townsville and Darwin are tried
   too, but they rarely offer an open feed, and the independents alongside
   them often do. */
const DISCOVER = [
  ['insuranceNEWS home', 'https://www.insurancenews.com.au/'],
  ['insuranceNEWS rss-channels', 'https://www.insurancenews.com.au/rss-channels'],
  ['SA CFS', 'https://www.cfs.sa.gov.au/'],
  ['SA CFS warnings', 'https://www.cfs.sa.gov.au/warnings-restrictions/'],
  ['Alert SA', 'https://www.alert.sa.gov.au/'],

  /* ABC's own index of its feeds, which is the thing worth finding. */
  ['ABC news feeds index', 'https://www.abc.net.au/news/feeds/rss/'],
  ['ABC Far North', 'https://www.abc.net.au/news/far-north/'],
  ['ABC Darwin', 'https://www.abc.net.au/news/darwin/'],
  ['ABC Adelaide', 'https://www.abc.net.au/news/adelaide/'],
  ['ABC North Qld', 'https://www.abc.net.au/news/north-qld/'],

  /* Far North Queensland. */
  ['Cairns Post', 'https://www.cairnspost.com.au/'],
  ['Townsville Bulletin', 'https://www.townsvillebulletin.com.au/'],
  ['Cairns Local News', 'https://cairnslocalnews.com.au/'],

  /* Northern Territory. */
  ['NT News', 'https://www.ntnews.com.au/'],
  ['NT Independent', 'https://ntindependent.com.au/'],

  /* South Australia. */
  ['The Advertiser', 'https://www.adelaidenow.com.au/'],
  ['InDaily', 'https://indaily.com.au/'],

  /* ACT beyond the Canberra Times. */
  ['Riot ACT', 'https://the-riotact.com/']
];

/* Feeds and endpoints to test directly: the one the Worker uses now, plus the
   shapes these two publishers are known to use elsewhere. */
const DIRECT = [
  ['SA CFS current (in use)', 'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.json'],
  ['SA CFS current (no prod)', 'https://data.eso.sa.gov.au/cfs/criimson/cfs_current_incidents.json'],
  ['SA CFS GeoRSS', 'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.xml'],
  ['insuranceNEWS guessed (in use)', 'https://www.insurancenews.com.au/rss/all-news']
];

const abs = (href, base) => { try { return new URL(href, base).href; } catch (e) { return null; } };

async function discover(url) {
  const out = { url };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    out.status = res.status;
    const html = await res.text();
    out.bytes = html.length;
    if (!res.ok) { out.head = html.replace(/\s+/g, ' ').slice(0, 200); return out; }

    /* The declared feeds: what the publisher says to use. */
    const declared = [];
    const linkRe = /<link\b[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
      if (!/(rss|atom)\+xml/i.test(tag)) continue;
      const href = (/href\s*=\s*["']([^"']+)/i.exec(tag) || [])[1];
      const title = (/title\s*=\s*["']([^"']*)/i.exec(tag) || [])[1] || '';
      const u = abs(href, url);
      if (u) declared.push({ title: title.trim(), url: u });
    }
    out.declared = declared;

    /* And anything that looks like a feed in the body, for the channel-list
       pages that never declare them all. */
    const linked = new Set();
    const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
    while ((m = aRe.exec(html)) !== null) {
      const href = m[1];
      if (!/rss|feed|\.xml/i.test(href)) continue;
      if (/^(mailto|javascript):/i.test(href)) continue;
      const u = abs(href, url);
      if (u) linked.add(u);
    }
    out.linked = [...linked].slice(0, 30);
  } catch (err) { out.error = String(err.message).slice(0, 140); }
  return out;
}

/* A feed is only a feed if it parses and has entries. Counting them is the
   whole point: an empty 200 reads exactly like a working source that happens
   to be quiet, and telling those apart is what this probe is for. */
async function readFeed(url) {
  const out = { url };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,application/json,*/*' } });
    out.status = res.status;
    out.type = (res.headers.get('content-type') || '').split(';')[0];
    const body = await res.text();
    out.bytes = body.length;
    if (!res.ok) { out.head = body.replace(/\s+/g, ' ').slice(0, 180); return out; }

    if (/^\s*[[{]/.test(body)) {
      const j = JSON.parse(body);
      const arr = Array.isArray(j) ? j
        : (Array.isArray(j.features) ? j.features : (Array.isArray(j.items) ? j.items : null));
      out.kind = 'json';
      out.items = arr ? arr.length : (j && typeof j === 'object' ? Object.keys(j).length : 0);
      out.shape = arr ? 'array' : 'object:' + Object.keys(j || {}).slice(0, 10).join(',');
      const first = arr ? arr[0] : Object.values(j || {})[0];
      if (first && typeof first === 'object') {
        out.keys = Object.keys(first.properties || first).slice(0, 25);
        const sample = {};
        Object.entries(first.properties || first).slice(0, 14).forEach(([k, v]) => {
          sample[k] = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 70) : String(v).slice(0, 70);
        });
        out.sample = sample;
      }
      return out;
    }

    const items = body.match(/<item\b/gi) || body.match(/<entry\b/gi) || [];
    out.kind = /<rss|<feed|<rdf/i.test(body) ? 'xml-feed' : (/^\s*</.test(body) ? 'xml-other' : 'text');
    out.items = items.length;
    out.feedTitle = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) || [])[1];
    const firstItem = (/<item\b[\s\S]*?<\/item>/i.exec(body) || /<entry\b[\s\S]*?<\/entry>/i.exec(body) || [])[0];
    if (firstItem) {
      out.firstItem = {
        title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(firstItem) || [])[1],
        link: (/<link[^>]*>([\s\S]*?)<\/link>/i.exec(firstItem) || [])[1]
          || (/<link[^>]*href\s*=\s*["']([^"']+)/i.exec(firstItem) || [])[1],
        date: (/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\//i.exec(firstItem) || [])[1]
      };
    }
  } catch (err) { out.error = String(err.message).slice(0, 140); }
  return out;
}

(async () => {
  const discovered = {};
  for (const [label, url] of DISCOVER) {
    discovered[label] = await discover(url);
    const d = discovered[label];
    console.log('==== ' + label + '  ' + (d.error ? 'ERR ' + d.error : 'HTTP ' + d.status + ', ' + d.bytes + ' bytes'));
    (d.declared || []).forEach((x) => console.log('   declared: ' + (x.title || '(untitled)') + '  ' + x.url));
    (d.linked || []).forEach((x) => console.log('   linked:   ' + x));
    if (d.head) console.log('   body: ' + d.head);
  }

  /* Everything found, plus the ones worth testing regardless. */
  const candidates = new Map();
  DIRECT.forEach(([label, url]) => candidates.set(url, label));
  Object.entries(discovered).forEach(([label, d]) => {
    (d.declared || []).forEach((x) => candidates.set(x.url, label + ' :: ' + (x.title || 'declared')));
    (d.linked || []).forEach((u) => { if (!candidates.has(u)) candidates.set(u, label + ' :: linked'); });
  });

  console.log('\nreading ' + candidates.size + ' candidate feed(s)...');
  const feeds = {};
  for (const [url, label] of candidates) {
    const r = await readFeed(url);
    feeds[label + ' | ' + url] = r;
    console.log('  ' + (r.error ? 'ERR  ' : String(r.status).padEnd(5))
      + String(r.items === undefined ? '-' : r.items).padStart(4) + ' item(s)  '
      + (r.kind || '').padEnd(10) + url.slice(0, 100));
    if (r.feedTitle) console.log('        title: ' + r.feedTitle.replace(/\s+/g, ' ').slice(0, 90));
    if (r.firstItem && r.firstItem.title) console.log('        first: ' + String(r.firstItem.title).replace(/\s+/g, ' ').slice(0, 90));
    if (r.keys) console.log('        keys: ' + r.keys.join(', ').slice(0, 200));
    if (r.sample) Object.entries(r.sample).forEach(([k, v]) => console.log('          ' + k.padEnd(22) + v));
  }

  mkdirSync('data', { recursive: true });
  writeFileSync('data/feed-probe.json', JSON.stringify({ capturedAt: Date.now(), discovered, feeds }, null, 2) + '\n');
  console.log('\nwrote data/feed-probe.json');
})();
