/* What does an outage-map iframe actually show?

   probe-embeddable.mjs reads the framing headers, which say what a page
   permits. Reported from the live dashboard: every operator tab rendered
   blank or broken, including the ones those headers called "unknown" --
   so headers alone were not enough to answer the question that matters,
   which is what a reader sees.

   This loads each candidate inside an iframe on a local page in a real
   Chromium, the way the dashboard does, waits for it to settle, and
   records what the frame ended up holding: the operator's page, a bot
   challenge, a browser error page (framing refused), or nothing. A small
   screenshot of each frame is kept, because "it rendered" and "it rendered
   a 'verify you are human' box" are the same to a status code.

   Candidates are each operator's own page and the same operator's page on
   Power Outages Australia, a third-party aggregator the Worker already
   reads -- the same arrangement as the Telstra and Optus tiles, which are
   Outage.Report's pages rather than the carriers'. Every frame is loaded
   twice where the first fails: with the dashboard's sandbox and without,
   so a failure the sandbox causes is not blamed on the operator.

   Run from a datacentre, a bot check is likelier than for a reader at
   home, so a challenge here means "may be challenged", not "always is".
   Nothing here tries to get past a challenge: it is recorded and that is
   all.

   Needs playwright (npm install --no-save playwright; npx playwright
   install chromium).
   Run: node scripts/probe-embed-render.mjs
     writes data/embed-render.json and data/embed-shots/<id>.jpg */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const POA_MAP = 'https://poweroutagesaustralia.com.au/map/?distributor=';
/* id -> [label, url]: each operator's own page, and the POA map zoomed to
   it -- which is what the dashboard's tabs frame. POA covers neither the
   NT nor Jemena, so those two have only the operator's page. */
const CANDIDATES = {
  nt: [['own', 'https://www.powerwater.com.au/outages/current-outages']],
  sa: [['own', 'https://www.sapowernetworks.com.au/outages/'], ['poa', POA_MAP + 'sa-power-networks']],
  'nsw-regional': [['own', 'https://www.essentialenergy.com.au/outages-and-faults/power-outages'],
    ['poa', POA_MAP + 'essential-energy']],
  'wa-regional': [['own', 'https://www.horizonpower.com.au/faults-outages/'], ['poa', POA_MAP + 'horizon-power']],
  'vic-east': [['own', 'https://www.ausnetservices.com.au/outages'], ['poa', POA_MAP + 'ausnet-services']],
  'melb-nw': [['own', 'https://www.jemena.com.au/outages/electricity-outages/']],
  'melb-se': [['own', 'https://www.unitedenergy.com.au/outage-map'], ['poa', POA_MAP + 'united-energy']],
  /* Controls: two pages the dashboard already frames successfully. If
     these fail too, the probe is broken, not the operators. */
  control: [['ctl', 'https://outage.report/au/telstra'], ['ctl', 'https://censusatlas.au/']]
};
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
const CHALLENGE = /just a moment|attention required|verify you are human|checking your browser|incapsula|request unsuccessful|access denied|enable javascript and cookies/i;

const { chromium } = await import('playwright').catch(() => {
  console.log('playwright is not installed -- nothing to render'); process.exit(0);
});

/* The parent page is served over http, not file://, so the frame sees an
   ordinary cross-origin parent as it would on the dashboard. */
let current = { url: '', sandbox: true };
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><body style="margin:0">' +
    '<iframe id="f" src="' + current.url.replace(/"/g, '&quot;') + '" style="width:1000px;height:700px;border:0"' +
    ' referrerpolicy="strict-origin-when-cross-origin"' + (current.sandbox ? ' sandbox="' + SANDBOX + '"' : '') +
    '></iframe></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const parentUrl = 'http://127.0.0.1:' + server.address().port + '/';

rmSync('data/embed-shots', { recursive: true, force: true });
mkdirSync('data/embed-shots', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });

async function render(url, sandbox) {
  current = { url, sandbox };
  const page = await ctx.newPage();
  const row = { sandbox };
  const docStatus = new Map();
  page.on('response', (r) => { if (r.request().resourceType() === 'document') docStatus.set(r.url(), r.status()); });
  try {
    await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(Number(process.env.EMBED_WAIT_MS) || 12000);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    row.frameUrl = frame ? frame.url() : null;
    row.status = docStatus.get(url) ?? docStatus.get(row.frameUrl) ?? null;
    if (frame && !/^chrome-error:|^about:blank$/.test(row.frameUrl || '')) {
      row.title = (await frame.title().catch(() => '')).slice(0, 120);
      const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      row.textLength = text.length;
      row.textSample = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    row.outcome = !frame ? 'no frame'
      : /^chrome-error:/.test(row.frameUrl || '') ? 'refused (browser error page: framing forbidden or load failed)'
        : CHALLENGE.test((row.title || '') + ' ' + (row.textSample || '')) ? 'bot challenge'
          : row.status >= 400 ? 'HTTP ' + row.status
            : (row.textLength || 0) < 40 ? 'blank'
              : 'rendered';
  } catch (e) { row.outcome = 'error'; row.error = e.message.slice(0, 200); }
  return { row, page };
}

const report = { at: new Date().toISOString(), note: 'Rendered from a GitHub Actions runner; a datacentre address is likelier to be challenged than a reader.', results: {} };
for (const [id, list] of Object.entries(CANDIDATES)) {
  report.results[id] = [];
  for (let i = 0; i < list.length; i++) {
    const [kind, url] = list[i];
    let { row, page } = await render(url, true);
    if (row.outcome !== 'rendered') {
      /* Same frame without the sandbox, so a failure the sandbox causes
         shows as one. */
      const second = await render(url, false);
      row.withoutSandbox = second.row.outcome;
      if (second.row.outcome === 'rendered') { await page.close(); page = second.page; }
      else await second.page.close();
    }
    const shot = 'data/embed-shots/' + id + '-' + i + '.jpg';
    await page.screenshot({ path: shot, type: 'jpeg', quality: 45, clip: { x: 0, y: 0, width: 1000, height: 700 } })
      .then(() => { row.shot = shot; }).catch(() => {});
    await page.close();
    report.results[id].push(Object.assign({ kind, url }, row));
    console.log(id.padEnd(14) + kind.padEnd(5) + String(row.outcome).padEnd(40) +
      (row.withoutSandbox ? '(no sandbox: ' + row.withoutSandbox + ') ' : '') + url +
      (row.title ? '  "' + row.title.slice(0, 50) + '"' : ''));
  }
}
await browser.close();
server.close();
writeFileSync('data/embed-render.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/embed-render.json and data/embed-shots/');
