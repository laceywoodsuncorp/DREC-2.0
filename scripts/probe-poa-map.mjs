/* Where is the map on Power Outages Australia, and can a frame open on it?

   The dashboard's operator tabs frame each operator's page on Power
   Outages Australia. Those pages open on a summary and an about section;
   asked for: tabs that open on the outage map itself. This finds the map
   -- its own page and address scheme, or its place on the operator page
   -- and checks each candidate renders in an iframe, with a screenshot.

   Needs playwright.  Run: node scripts/probe-poa-map.mjs
     writes data/poa-map-probe.json and data/embed-shots/poa-*.jpg */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://poweroutagesaustralia.com.au';
const OPERATOR_PAGE = BASE + '/distributors/essential-energy/';
const { chromium } = await import('playwright').catch(() => {
  console.log('playwright is not installed'); process.exit(0);
});
mkdirSync('data/embed-shots', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const report = { at: new Date().toISOString(), pages: {}, framed: [] };

/* What a page offers: links that mention a map, element ids, and where any
   map container sits. */
async function survey(url, key) {
  const page = await ctx.newPage();
  const row = { url };
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    row.status = res && res.status();
    await page.waitForTimeout(8000);
    row.finalUrl = page.url();
    row.title = await page.title();
    Object.assign(row, await page.evaluate(() => {
      const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return h; } };
      const links = [...document.querySelectorAll('a[href]')]
        .map((a) => ({ href: abs(a.getAttribute('href')), text: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 60) }))
        .filter((l) => /map|suburb|search|outage/i.test(l.href + ' ' + l.text));
      const seen = new Set();
      const uniq = links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 60);
      const maps = [...document.querySelectorAll('.leaflet-container,.maplibregl-map,.mapboxgl-map,.gm-style,[class*="map" i],[id*="map" i],iframe,canvas')]
        .map((e) => { const r = e.getBoundingClientRect();
          return { tag: e.tagName.toLowerCase(), id: e.id || undefined, cls: String(e.className || '').slice(0, 80),
            src: e.getAttribute('src') || undefined, top: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter((m) => m.w > 150 && m.h > 150).slice(0, 15);
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id).filter((i) => !/^__|^radix|^headlessui/.test(i)).slice(0, 80);
      const forms = [...document.querySelectorAll('form')].map((f) => ({ action: f.getAttribute('action'), method: f.method,
        inputs: [...f.querySelectorAll('input,select')].map((i) => i.name || i.id || i.type) }));
      return { links: uniq, maps, ids, forms, height: document.documentElement.scrollHeight };
    }));
    await page.screenshot({ path: 'data/embed-shots/poa-' + key + '.jpg', type: 'jpeg', quality: 40, fullPage: true })
      .then(() => { row.shot = 'data/embed-shots/poa-' + key + '.jpg'; }).catch(() => {});
  } catch (e) { row.error = e.message.slice(0, 200); }
  await page.close();
  report.pages[key] = row;
  console.log('== ' + key + ' ' + row.status + ' ' + (row.finalUrl || url) + '  "' + (row.title || '') + '"  h=' + row.height);
  for (const m of row.maps || []) console.log('   map? ' + JSON.stringify(m));
  for (const l of (row.links || []).slice(0, 30)) console.log('   link ' + l.href + '  [' + l.text + ']');
  return row;
}

const op = await survey(OPERATOR_PAGE, 'operator');
const home = await survey(BASE + '/', 'home');
/* The breadcrumb's "Outage map" link and anything else that looks like the
   map's own page. */
const mapLinks = [...new Set([...(op.links || []), ...(home.links || [])]
  .filter((l) => /map/i.test(l.href + ' ' + l.text) && l.href.startsWith(BASE)).map((l) => l.href))].slice(0, 6);
for (let i = 0; i < mapLinks.length; i++) await survey(mapLinks[i], 'map' + i);

/* Candidates for a frame that opens on the map for one operator. Guesses
   are labelled as guesses; a 404 or a page identical to the plain map
   says the parameter is ignored. */
const candidates = [
  ...mapLinks,
  OPERATOR_PAGE + '#map',
  BASE + '/outage-map/?distributor=essential-energy',
  BASE + '/outage-map/?network=essential-energy',
  BASE + '/map/?distributor=essential-energy'
];
for (const m of (op.maps || []).filter((m) => m.id)) candidates.push(OPERATOR_PAGE + '#' + m.id);

let current = '';
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><body style="margin:0"><iframe src="' + current.replace(/"/g, '&quot;') +
    '" style="width:1000px;height:700px;border:0" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
for (let i = 0; i < candidates.length; i++) {
  current = candidates[i];
  const page = await ctx.newPage();
  const row = { url: current };
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);
    const f = page.frames().find((x) => x !== page.mainFrame());
    row.frameUrl = f && f.url();
    row.title = f ? await f.title().catch(() => '') : '';
    row.mapInView = f ? await f.evaluate(() => [...document.querySelectorAll('.leaflet-container,.maplibregl-map,.mapboxgl-map,.gm-style,canvas')]
      .some((e) => { const r = e.getBoundingClientRect(); return r.width > 300 && r.height > 200 && r.top < innerHeight && r.bottom > 0; })).catch(() => null) : null;
    await page.screenshot({ path: 'data/embed-shots/poa-frame-' + i + '.jpg', type: 'jpeg', quality: 40 });
    row.shot = 'data/embed-shots/poa-frame-' + i + '.jpg';
  } catch (e) { row.error = e.message.slice(0, 200); }
  await page.close();
  report.framed.push(row);
  console.log('frame ' + i + ' mapInView=' + row.mapInView + '  ' + current + '  "' + (row.title || '') + '"');
}
server.close();
await browser.close();
writeFileSync('data/poa-map-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/poa-map-probe.json');
