/* Find the feed a published emergency page actually reads.

   Every feed address in this project that was guessed rather than observed
   has cost us something. The SA CFS endpoints are the standing example: both
   data.eso.sa.gov.au addresses answer HTTP 200 with a 197-byte "SA ESS -
   File Unavailable" page, so the state reported ok:true, complete:true,
   count:0 for weeks -- a soft-404 is indistinguishable from a quiet day
   unless something looks at the body.

   Guessing the replacement has the same failure mode. So this does not
   guess: it loads the page a human would open, pulls every data-looking URL
   out of the HTML and out of the Javascript bundles the HTML loads, fetches
   each one, and reports what came back. The page tells us its own feed.

   For each candidate it reports status, content type, shape, item count, the
   field names, and two verdicts drawn from the field names and values:
   whether the feed carries a public alert LEVEL, and whether it carries
   POWER OUTAGE data (customers affected, restoration time, outage cause).
   Both are what we want from a state: one feed answering both is why this
   is worth a probe rather than a patch.

   Soft-404s are called out explicitly -- a 200 is not evidence of anything
   here.

   Run: node scripts/discover-feeds.mjs [url ...]
        (no args: the built-in target list; writes data/feed-discovery.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

/* Pages to start from. Each is a page an operator or agency publishes for
   the public; the feeds behind them are what we are after. */
const TARGETS = [
  /* SA. The user's address for the CFS warnings page, and Alert SA, which
     is the whole-of-state emergency view and is understood to carry power
     outages alongside warnings. */
  'https://www.cfs.sa.gov.au/warnings-restrictions/warnings/incidents-warnings/',
  'https://alert.sa.gov.au/',
  /* TAS. TasALERT aggregates incidents and alerts, and the XML feed we
     already read returned 0 items on the last run while the page shows
     entries -- so either the feed moved or we are reading the wrong one. */
  'https://alert.tas.gov.au/',
  'https://alert.tas.gov.au/incidents-and-alerts'
];

/* A URL worth fetching: a data format, or a service that serves data.
   Deliberately broad on the way in and filtered by what comes back, because
   the naming conventions vary per agency and an over-tight filter here is
   how a working feed gets missed. */
/* Named once and used by both the fetch and the verdict. It was inline in
   two places, and softFail's copy read a flag that only get() sets -- so a
   challenge page handed to describe() by anything else read as real data. */
const CHALLENGE_RE = /Just a moment|cf-browser-verification|_Incapsula_Resource|Attention Required/i;

const DATA_RE = /\.(?:json|geojson|xml|rss|csv)(?:\?[^"']*)?$/i;
const SERVICE_RE = /(?:arcgis\/rest|\/FeatureServer|\/MapServer|\/api\/|\/feeds?\/|\/data\/|graphql)/i;

/* Field names and values that mean a public alert level, versus ones that
   mean an operational state. Kept consistent with probe-warnings.mjs. */
const LEVEL_NAME_RE = /level|status|warning|alert|severity|category|urgency/i;
const LEVEL_VAL_RE = /emergency warning|watch and act|watch & act|^advice$|all clear|prepare to (leave|evacuate)|evacuat|bushfire warning/i;

/* Field names and values that mean electricity outage data. "Customers
   affected" and a restoration estimate are the two that make an outage feed
   usable on the dashboard -- a bare point with no customer count tells a
   duty officer nothing about scale. */
const OUTAGE_NAME_RE = /outage|customer|affected|restor|etr|supply|power|electric|interrupt|de-?energis/i;
const OUTAGE_VAL_RE = /power outage|unplanned outage|planned outage|customers affected|restoration|electricity/i;

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || '*/*' }
    });
    const text = await res.text();
    return {
      status: res.status, finalUrl: res.url !== url ? res.url : undefined,
      type: res.headers.get('content-type') || '', bytes: text.length, text,
      challenged: CHALLENGE_RE.test(text),
      title: (/<title[^>]*>([^<]{0,140})</i.exec(text) || [])[1] || ''
    };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

/* A 200 that is really a failure. The SA host's is 197 bytes and says so in
   the title; the general shape is a short HTML body where we asked for data,
   or a title that admits it. */
function softFail(r) {
  if (!r || r.error) return null;
  if (r.challenged || CHALLENGE_RE.test(r.text || '')) return 'bot challenge -- not pursued';
  if (/file unavailable|not found|error|unavailable|no longer/i.test(r.title || '')) return 'soft-404: ' + r.title;
  if (r.status === 200 && /html/i.test(r.type) && r.bytes < 1200) return 'soft-404: ' + r.bytes + ' bytes of HTML';
  return null;
}

/* Every absolute or root-relative URL in a body that looks like data. */
function extractUrls(text, baseUrl) {
  const out = new Set();
  /* Unescaped FIRST, not per match. A minified bundle holds its endpoints as
     JSON-encoded strings -- "https:\/\/services.arcgis.com\/..." -- and the
     pattern below anchors on a literal "https://", so against the raw text
     it matched nothing at all. Which is to say it found no endpoint in the
     one place a single-page app keeps them, and both pages in question are
     single-page apps. Also handles the \u002F form some bundlers emit. */
  const body = String(text).replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
  const re = /["'`(]((?:https?:\/\/|\/)[^"'`)\s<>\\]{4,300})["'`)]/g;
  let m;
  while ((m = re.exec(body))) {
    const raw = m[1];
    if (!DATA_RE.test(raw) && !SERVICE_RE.test(raw)) continue;
    if (/\.(?:js|css|png|jpe?g|svg|gif|woff2?|ico|map)(?:\?|$)/i.test(raw)) continue;
    try { out.add(new URL(raw, baseUrl).href); } catch { /* not a URL */ }
  }
  return [...out];
}

/* The script bundles a page loads, which is where a single-page app keeps
   its endpoints -- the HTML of such a page contains no feed URL at all. */
function extractScripts(text, baseUrl) {
  const out = new Set();
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(text))) {
    try {
      const u = new URL(m[1].replace(/\\\//g, '/'), baseUrl);
      if (u.origin === new URL(baseUrl).origin) out.add(u.href);
    } catch { /* not a URL */ }
  }
  return [...out];
}

/* Walk any decoded structure and collect field names plus sample values, so
   the verdicts are drawn from the real content rather than the URL. */
function walk(node, depth, names, vals) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { node.slice(0, 40).forEach((v) => walk(v, depth + 1, names, vals)); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (v === null || typeof v !== 'object') {
        names.add(k);
        if (typeof v === 'string' && v.length < 120) vals.add(v);
        if (typeof v === 'number') vals.add(String(v));
      } else walk(v, depth + 1, names, vals);
    }
  }
}

function describe(r) {
  const soft = softFail(r);
  const d = { status: r.status, type: (r.type || '').split(';')[0], bytes: r.bytes };
  if (r.finalUrl) d.redirectedTo = r.finalUrl;
  if (soft) { d.verdict = soft; if (r.title) d.title = r.title; return d; }

  const names = new Set(), vals = new Set();
  let items;
  const body = r.text.trim();
  if (/^[[{]/.test(body)) {
    try {
      const j = JSON.parse(body);
      d.shape = Array.isArray(j) ? 'array' : 'object';
      /* The item count a human would recognise: features, then the longest
         array anywhere, then the object itself. */
      if (j && Array.isArray(j.features)) items = j.features.length;
      else if (Array.isArray(j)) items = j.length;
      else {
        const longest = Object.values(j).filter(Array.isArray).sort((a, b) => b.length - a.length)[0];
        if (longest) items = longest.length;
      }
      walk(j, 0, names, vals);
    } catch (e) { d.shape = 'unparseable json'; d.parseError = e.message; }
  } else if (/^<\?xml|^<rss|^<feed|^<alert/i.test(body)) {
    d.shape = 'xml';
    items = (body.match(/<(?:item|entry|info|alert)\b/gi) || []).length;
    (body.match(/<([a-z][\w:.-]{1,40})>/gi) || []).forEach((t) => names.add(t.replace(/[<>]/g, '')));
    (body.match(/>([^<>{]{2,80})</g) || []).slice(0, 400).forEach((v) => vals.add(v.slice(1, -1).trim()));
  } else {
    d.shape = /html/i.test(r.type) ? 'html' : 'other';
    if (r.title) d.title = r.title;
  }
  if (items !== undefined) d.items = items;

  const nameList = [...names], valList = [...vals];
  if (nameList.length) d.fields = nameList.slice(0, 40);

  const lvl = nameList.filter((n) => LEVEL_NAME_RE.test(n));
  const lvlVals = valList.filter((v) => LEVEL_VAL_RE.test(v));
  const outName = nameList.filter((n) => OUTAGE_NAME_RE.test(n));
  const outVals = valList.filter((v) => OUTAGE_VAL_RE.test(v));

  d.carriesAlertLevel = lvlVals.length > 0;
  d.carriesOutageData = outName.length > 0 || outVals.length > 0;
  if (lvl.length) d.levelFields = lvl.slice(0, 10);
  if (lvlVals.length) d.levelValues = [...new Set(lvlVals)].slice(0, 10);
  if (outName.length) d.outageFields = outName.slice(0, 15);
  if (outVals.length) d.outageValues = [...new Set(outVals)].slice(0, 10);
  return d;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS;
const report = { at: new Date().toISOString(), pages: [] };

for (const page of targets) {
  console.log('\n=== ' + page);
  const r = await get(page, 'text/html,*/*');
  const entry = { url: page, page: r.error ? { error: r.error } : describe(r), candidates: [] };
  if (r.error) { console.log('  ERROR ' + r.error); report.pages.push(entry); continue; }
  console.log('  ' + r.status + '  ' + (r.type || '').split(';')[0] + '  ' + r.bytes + 'b  ' + (r.title || ''));
  if (r.challenged) {
    /* An operator putting a challenge in front of the page has made a
       decision. Recorded, not worked around. */
    entry.note = 'bot challenge on the page itself -- not pursued';
    console.log('  bot challenge -- stopping here for this page');
    report.pages.push(entry);
    continue;
  }

  /* The HTML first, then its own bundles -- a single-page app keeps every
     endpoint in the Javascript and none in the markup. */
  const found = new Set(extractUrls(r.text, page));
  const scripts = extractScripts(r.text, page).slice(0, 6);
  entry.scriptsScanned = scripts;
  for (const s of scripts) {
    const sr = await get(s, '*/*');
    if (sr.error || sr.status !== 200) continue;
    extractUrls(sr.text, page).forEach((u) => found.add(u));
  }

  const list = [...found].slice(0, 25);
  console.log('  candidates: ' + list.length + (scripts.length ? ' (incl. ' + scripts.length + ' bundles scanned)' : ''));
  for (const c of list) {
    const cr = await get(c, 'application/json,application/geo+json,application/xml,*/*');
    if (cr.error) { entry.candidates.push({ url: c, error: cr.error }); console.log('    ERR  ' + cr.error + '  ' + c); continue; }
    const d = describe(cr);
    entry.candidates.push({ url: c, ...d });
    console.log('    ' + d.status + '  ' + (d.shape || '-')
      + (d.items !== undefined ? '  items=' + d.items : '')
      + (d.carriesAlertLevel ? '  LEVEL' : '') + (d.carriesOutageData ? '  OUTAGE' : '')
      + '  ' + c + (d.verdict ? '  <- ' + d.verdict : ''));
  }
  report.pages.push(entry);
}

/* The summary is the point: which addresses, if any, answer with data that
   carries a level or an outage. */
console.log('\n================ usable feeds found ================');
let any = false;
for (const p of report.pages) {
  for (const c of p.candidates || []) {
    if (c.carriesAlertLevel || c.carriesOutageData) {
      any = true;
      console.log((c.carriesOutageData ? 'OUTAGE ' : '       ') + (c.carriesAlertLevel ? 'LEVEL ' : '      ')
        + 'items=' + (c.items === undefined ? '?' : c.items) + '  ' + c.url);
    }
  }
}
if (!any) console.log('none -- every candidate was a soft-404, a challenge, or carried neither');

mkdirSync(new URL('../data', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/feed-discovery.json', import.meta.url), JSON.stringify(report, null, 1));
console.log('\nwrote data/feed-discovery.json');
