/* What does Power Outages Australia's operator page load its outages from?

   The Worker already falls back to POA for Essential Energy, Jemena and SA
   Power Networks, and POA answers -- but "no recognisable outage fields":
   the page is not a table. Framed on the dashboard, the same pages show
   live counts (Essential Energy: 16 outages, 475 customers), so the data is
   there and is being fetched or embedded some other way.

   Asked for: read POA for every region we cannot read from the operator,
   so that only the NT is left to a separate tab. This finds out how:

     1. robots.txt first. Whatever it disallows for automated readers is not
        read, and the report says so rather than working round it.
     2. The raw HTML: hydration payloads (__NEXT_DATA__, __NUXT__, astro
        islands), JSON-LD, inline arrays, links to .json/.csv/api paths.
     3. A real browser load with every JSON/CSV response recorded -- URL,
        size, top-level shape, and a sample record's keys -- which is where
        a client-rendered list comes from.

   No challenge is touched; POA serves none.

   Needs playwright for step 3 (skipped without it).
   Run: node scripts/probe-poa-data.mjs   (writes data/poa-data-probe.json) */
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const BASE = 'https://poweroutagesaustralia.com.au';
const SLUGS = ['essential-energy', 'jemena', 'sa-power-networks', 'ausnet-services', 'united-energy',
  'horizon-power', 'power-and-water'];
const report = { at: new Date().toISOString(), robots: null, pages: {}, browser: {} };

/* robots.txt, read the way a crawler would: the group for our agent, else
   the * group. */
async function robots() {
  try {
    const res = await fetch(BASE + '/robots.txt', { headers: { 'User-Agent': UA } });
    const text = await res.text();
    const rules = [];
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const m = /^(user-agent|disallow|allow|crawl-delay)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'user-agent') applies = v === '*' || /newsradar/i.test(v);
      else if (applies) rules.push({ rule: k, path: v });
    }
    return { status: res.status, rules, text: text.slice(0, 3000) };
  } catch (e) { return { error: e.message }; }
}
const disallowed = (path, rules) => {
  let best = null;
  for (const r of rules || []) {
    if (r.rule !== 'allow' && r.rule !== 'disallow') continue;
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !!best && best.rule === 'disallow';
};

function shape(v, depth = 0) {
  if (Array.isArray(v)) return { array: v.length, first: v.length && depth < 3 ? shape(v[0], depth + 1) : undefined };
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const out = { keys: keys.slice(0, 40) };
    if (depth < 2) for (const k of keys.slice(0, 12)) if (v[k] && typeof v[k] === 'object') out[k] = shape(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

report.robots = await robots();
console.log('robots.txt ' + (report.robots.status || report.robots.error));
for (const r of report.robots.rules || []) console.log('   ' + r.rule + ': ' + r.path);

for (const slug of SLUGS) {
  const path = '/distributors/' + slug + '/';
  const row = { url: BASE + path, disallowed: disallowed(path, report.robots.rules) };
  if (row.disallowed) { report.pages[slug] = row; console.log(slug + ': disallowed by robots.txt -- not read'); continue; }
  try {
    const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const html = await res.text();
    row.status = res.status; row.bytes = html.length;
    row.generator = (/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(html) || [])[1];
    row.hydration = ['__NEXT_DATA__', '__NUXT__', 'astro-island', 'data-props', 'wire:snapshot', 'x-data', '__INITIAL_STATE__', 'window.__']
      .filter((k) => html.includes(k));
    row.jsonLd = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
      try { return shape(JSON.parse(m[1])); } catch (e) { return 'unparseable'; }
    });
    const nd = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (nd) { try { row.nextData = shape(JSON.parse(nd[1])); } catch (e) { row.nextData = 'unparseable'; } }
    row.leads = [...new Set([...html.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+)?\/[^"'`\s]*(?:api|\.json|\.csv|outages?|feed|data)[^"'`\s]*)["'`]/gi)]
      .map((m) => m[1]).filter((u) => !/\.(css|js|png|svg|jpg|webp|woff2?)(\?|$)/i.test(u)))].slice(0, 40);
    /* The visible numbers, to tell a page that carries its data in the HTML
       from one that fills it in later. */
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    row.headline = (/[^.]{0,40}has \d+ outages? right now[^.]{0,80}/i.exec(text) || [])[0];
    row.textSample = text.slice(0, 600);
    row.tables = (html.match(/<table/gi) || []).length;
    row.listItems = (html.match(/<li/gi) || []).length;
  } catch (e) { row.error = e.message; }
  report.pages[slug] = row;
  console.log(slug.padEnd(20) + String(row.status).padEnd(5) + ' ' + row.bytes + 'B gen=' + row.generator +
    ' hyd=' + (row.hydration || []).join(',') + ' tables=' + row.tables + ' leads=' + (row.leads || []).length +
    '\n   ' + (row.headline || '(no headline in HTML)'));
  await new Promise((r) => setTimeout(r, 1500));
}

/* The terms, since robots.txt points to them before anything is
   republished -- and the dashboard would republish. Read before any use
   of the data is built. */
try {
  const res = await fetch(BASE + '/terms/', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const html = await res.text();
  const main = (/<main[\s\S]*?<\/main>/i.exec(html) || [html])[0];
  const text = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|h\d|li|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 20000);
  report.terms = { status: res.status, chars: text.length };
  writeFileSync('data/poa-terms.txt', text + '\n');
  console.log('terms ' + res.status + ' ' + text.length + ' chars');
} catch (e) { report.terms = { error: e.message }; }

/* The feed POA's own map reads, fetched plainly -- our User-Agent, no
   borrowed Origin or Referer. A few records per distributor are kept so
   the Worker's parser is written against real values rather than key
   names, and become its test fixture. */
const FEED = 'https://poa-outages-api.sk-9b3.workers.dev/outages';
try {
  const res = await fetch(FEED, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const body = await res.json();
  const sample = { fetchedAt: new Date().toISOString(), status: res.status,
    cacheControl: res.headers.get('cache-control'), generatedAt: body.generatedAt, totals: body.totals,
    coverage: body.coverage, sources: body.sources, byDistributor: body.byDistributor, filtered: body.filtered,
    outageCount: (body.outages || []).length, outages: [] };
  const per = {};
  for (const o of body.outages || []) {
    const k = o.distributor + '|' + o.type + '|' + o.scheduled;
    if ((per[k] = (per[k] || 0) + 1) > 2) continue;
    /* Geometry trimmed to its type and first point: enough to know the
       shape, without carrying someone's polygon file around. */
    const g = o.geometry;
    const first = (c) => (Array.isArray(c) && Array.isArray(c[0]) ? first(c[0]) : c);
    sample.outages.push(Object.assign({}, o, { geometry: g && { type: g.type, coordinates: first(g.coordinates) } }));
  }
  writeFileSync('data/poa-feed-sample.json', JSON.stringify(sample, null, 1) + '\n');
  console.log('feed ' + res.status + ' outages=' + sample.outageCount + ' sampled=' + sample.outages.length +
    ' generatedAt=' + body.generatedAt + ' cache-control=' + sample.cacheControl);
} catch (e) { console.log('feed: ' + e.message); }

const pw = await import('playwright').catch(() => null);
if (pw) {
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext();
  for (const slug of ['essential-energy', 'power-and-water']) {
    if (report.pages[slug] && report.pages[slug].disallowed) continue;
    const page = await ctx.newPage();
    const seen = [];
    page.on('response', async (r) => {
      const t = r.request().resourceType();
      if (t !== 'xhr' && t !== 'fetch' && !/json|csv/i.test(r.headers()['content-type'] || '')) return;
      const row = { url: r.url(), status: r.status(), type: (r.headers()['content-type'] || '').split(';')[0], method: r.request().method() };
      try {
        const body = await r.text();
        row.bytes = body.length;
        if (/json/.test(row.type) || /^\s*[[{]/.test(body)) { try { row.shape = shape(JSON.parse(body)); } catch (e) { row.sample = body.slice(0, 300); } }
        else row.sample = body.slice(0, 300);
      } catch (e) { row.error = e.message; }
      seen.push(row);
    });
    await page.goto(BASE + '/distributors/' + slug + '/', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);
    /* Scroll so anything loaded on view loads. */
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 300)); } });
    await page.waitForTimeout(3000);
    report.browser[slug] = { requests: seen,
      rendered: await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500)) };
    console.log('\n== browser ' + slug + ': ' + seen.length + ' data responses');
    for (const s of seen) console.log('   ' + s.method + ' ' + s.status + ' ' + s.type + ' ' + s.bytes + 'B ' + s.url.slice(0, 140) +
      (s.shape ? '\n      ' + JSON.stringify(s.shape).slice(0, 400) : ''));
    await page.close();
  }
  await browser.close();
}
mkdirSync('data', { recursive: true });
writeFileSync('data/poa-data-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/poa-data-probe.json');
