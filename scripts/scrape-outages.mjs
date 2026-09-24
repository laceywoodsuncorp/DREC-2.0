/* Visits each distributor's own outage page in a real browser and writes what
   it finds to data/outages.json, which the Worker then serves.

   Why a browser at all: most of these lists only exist after JavaScript runs.
   A Worker fetch sees an empty shell, so no amount of parsing gets at them.
   A rendered page has the list in the DOM and can be read like any other.

   Two rules this deliberately follows:

   - It reads pages. It does not attempt to get past a bot challenge. An
     operator that blocks automated access has made a decision about it, and
     driving a browser through that would be circumventing an access control
     rather than reading something published. Those are recorded as blocked
     and skipped.
   - Where it cannot parse a page it saves the rendered HTML and a screenshot
     to artifacts/, rather than reporting an empty list. A page it failed on
     is a page nobody has looked at yet, and the artifacts are what turn that
     into a five-minute fix.

   Usage: node scripts/scrape-outages.mjs [--only nsw,vic] [--out data/outages.json]
*/
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { OUTAGE_NETWORKS } from '../src/worker.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = arg('out', 'data/outages.json');
const ARTIFACTS = arg('artifacts', 'artifacts');
const DIAG = arg('diagnostics', 'data/scrape-diagnostics.json');
const ONLY = (arg('only', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const NAV_TIMEOUT = Number(arg('timeout', 45000));

/* The same vocabulary the Worker uses, kept here rather than imported because
   the Worker's copy is scoped to its own parsing. Order is priority: the
   first word that appears in a heading or label wins, so the specific ones
   come first and "affected" alone is never a customer count. */
const HINTS = [
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

const CHALLENGE = /just a moment|attention required|checking your browser|enable javascript and cookies|ddos protection/i;

/* Runs inside the page. Two shapes are covered because these sites use two:
   an HTML table, and a list of repeated cards (Endeavour's outage list is
   cards -- suburb, "Reference: INC ...", a type, an estimated restoration).
   Cards are found by looking for the repeated parent whose children each
   carry one of the labels we recognise, which is more robust than guessing
   at class names that change with every redesign. */
/* <extract> -- test/card_extraction.test.js lifts everything between these
   markers and runs it in a real page, so the test drives this function rather
   than a copy of it. Keep the markers if you move it. */
function extractInPage(hints) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const key = (t) => norm(t).toLowerCase().replace(/[^a-z]/g, '');
  const toField = (text) => {
    const k = key(text);
    if (!k) return null;
    for (const h of hints) for (const w of h.words) if (k.includes(w)) return h.field;
    return null;
  };

  /* ---- tables ---- */
  const fromTables = () => {
    const out = [];
    const headingsSeen = [];
    for (const table of document.querySelectorAll('table')) {
      const rows = [...table.querySelectorAll('tr')];
      if (!rows.length) continue;
      const headRow = rows.find((r) => r.querySelector('th')) || rows[0];
      const headings = [...headRow.querySelectorAll('th,td')].map((c) => norm(c.innerText));
      if (!headings.length) continue;
      headings.forEach((h) => { if (h && !headingsSeen.includes(h)) headingsSeen.push(h); });
      const map = headings.map(toField);
      if (!map.includes('location')) continue;
      for (const r of rows) {
        if (r === headRow) continue;
        const cells = [...r.querySelectorAll('td,th')].map((c) => norm(c.innerText));
        if (!cells.length) continue;
        const rec = {};
        map.forEach((f, i) => { if (f && cells[i] && !rec[f]) rec[f] = cells[i].slice(0, 200); });
        if (rec.location) out.push(rec);
      }
    }
    return { records: out, headings: headingsSeen, shape: 'table' };
  };

  /* ---- repeated cards ---- */
  const fromCards = () => {
    const LABEL = /(reference|est\.?\s*restoration|estimated restoration|customers|unplanned|planned outage)/i;
    /* The list is the element with the most CHILDREN that each carry a label
       -- not, as this first tried, the most common parent of elements whose
       text matches. innerText includes descendants, so by that measure every
       ancestor up to <body> matched and the winner was whichever branch
       happened to accumulate the most hits, which was rarely the list. The
       count here is over direct children, so a wrapper holding one list
       scores 1 and the list itself scores once per card. */
    let container = null, best = 0, bestDepth = -1;
    const depthOf = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
    document.querySelectorAll('div,ul,ol,section,main,tbody').forEach((el) => {
      const kids = [...el.children];
      if (kids.length < 2) return;
      const matching = kids.filter((k) => LABEL.test(k.innerText || '')).length;
      if (matching < 2) return;
      const depth = depthOf(el);
      /* Most labelled children wins; on a tie the deeper element, which is
         the list rather than something wrapping it. */
      if (matching > best || (matching === best && depth > bestDepth)) {
        best = matching; bestDepth = depth; container = el;
      }
    });
    if (!container) return { records: [], headings: [], shape: 'cards' };

    const records = [];
    const labelsSeen = [];
    for (const card of container.children) {
      const text = norm(card.innerText);
      if (!text || !LABEL.test(text)) continue;
      const rec = {};
      /* The first line of a card is its heading -- the suburb, on every one
         of these that has been seen. */
      const lines = String(card.innerText || '').split('\n').map(norm).filter(Boolean);
      if (lines.length) rec.location = lines[0].slice(0, 200);
      /* Then "Label: value" pairs anywhere in the card. */
      for (const line of lines) {
        const m = /^([^:]{2,40}):\s*(.+)$/.exec(line);
        if (!m) continue;
        if (!labelsSeen.includes(norm(m[1]))) labelsSeen.push(norm(m[1]));
        const f = toField(m[1]);
        if (f && !rec[f]) rec[f] = norm(m[2]).slice(0, 200);
      }
      /* A bare "Unplanned outage" line carries the type with no label. */
      const kindLine = lines.find((l) => /^(un)?planned\b/i.test(l));
      if (kindLine && !rec.kind) rec.kind = kindLine.slice(0, 60);
      if (rec.location && Object.keys(rec).length > 1) records.push(rec);
    }
    return { records, headings: labelsSeen, shape: 'cards' };
  };

  const table = fromTables();
  if (table.records.length) return table;
  const cards = fromCards();
  if (cards.records.length) return cards;
  return { records: [], headings: table.headings.concat(cards.headings), shape: 'none' };
}

/* </extract> */

/* What the page actually looks like, for the cases the extractor could not
   read or read suspiciously thinly. Artifacts capture this too, but they are
   a zip nobody can read without downloading it -- a small summary committed
   beside the data is what actually gets these fixed, because it can be read
   straight out of the repo. Text only: no markup, no styling, nothing that
   would make it large. */
function summariseInPage() {
  const norm = (t) => String(t || '').replace(/[ \t]+/g, ' ').trim();
  const LABEL = /(reference|est\.?\s*restoration|estimated restoration|customers|unplanned|planned outage|outage)/i;

  /* The repeated structures on the page, biggest first: what a list looks
     like from the outside, whether or not our vocabulary matched it. */
  const candidates = [];
  document.querySelectorAll('div,ul,ol,section,main,tbody').forEach((el) => {
    const kids = [...el.children];
    if (kids.length < 3) return;
    const labelled = kids.filter((k) => LABEL.test(k.innerText || '')).length;
    if (!labelled) return;
    candidates.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 60),
      children: kids.length,
      labelledChildren: labelled,
      firstChild: norm(kids[0].innerText).slice(0, 180)
    });
  });
  candidates.sort((a, b) => b.labelledChildren - a.labelledChildren);

  return {
    title: document.title,
    tables: document.querySelectorAll('table').length,
    text: norm(document.body ? document.body.innerText : '').slice(0, 3500),
    candidates: candidates.slice(0, 5)
  };
}

const parseCustomers = (raw) => {
  if (raw === undefined || raw === null) return null;
  const m = /^(\d+)/.exec(String(raw).replace(/,/g, '').trim());
  return m ? Number(m[1]) : null;
};
const classify = (rec) => {
  const hay = [rec.kind, rec.status, rec.cause].filter(Boolean).join(' ').toLowerCase();
  if (/\bunplanned|\bfault|emergency/.test(hay)) return 'unplanned';
  if (/\bplanned|\bscheduled|maintenance/.test(hay)) return 'planned';
  return undefined;
};

async function scrapeOperator(page, state, net) {
  const result = { name: net.name, ok: false, count: 0, outages: [] };
  try {
    const res = await page.goto(net.site, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    /* Give the list a moment to render; these are client-side apps and there
       is no single selector that is right for all of them. */
    await page.waitForTimeout(6000);
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '');

    if (CHALLENGE.test(body) || (res && res.status() === 403)) {
      /* Deliberately not worked around -- see the header. */
      result.blocked = true;
      result.error = 'Operator blocks automated access (bot challenge); not bypassed';
      return result;
    }

    const found = await page.evaluate(extractInPage, HINTS);
    result.shape = found.shape;
    result.labels = found.headings.slice(0, 30);

    if (!found.records.length) {
      result.error = 'Rendered, but no outage list could be recognised on the page';
      result.diagnostic = await page.evaluate(summariseInPage).catch(() => null);
      await saveArtifacts(page, state, net);
      return result;
    }

    /* A list that yields one or two rows is usually the extractor finding
       something that is not the list, not an operator with one outage. Worth
       the same look as an outright failure. */
    if (found.records.length < 3) {
      result.diagnostic = await page.evaluate(summariseInPage).catch(() => null);
    }

    result.ok = true;
    result.outages = found.records.map((r) => ({
      id: r.id, location: r.location, status: r.status, cause: r.cause,
      kind: classify(r), customers: parseCustomers(r.customers),
      start: r.start, restore: r.restore
    }));
    result.count = result.outages.length;
  } catch (err) {
    result.error = err.name === 'TimeoutError' ? 'Timed out loading the page' : err.message;
    await saveArtifacts(page, state, net).catch(() => {});
  }
  return result;
}

async function saveArtifacts(page, state, net) {
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
  const slug = state + '-' + net.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try {
    writeFileSync(ARTIFACTS + '/' + slug + '.html', await page.content());
    await page.screenshot({ path: ARTIFACTS + '/' + slug + '.png', fullPage: false });
  } catch (e) { /* artifacts are a convenience, never the job */ }
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1200 },
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney'
  });
  const page = await context.newPage();

  const states = {};
  const summary = [];
  for (const [state, group] of Object.entries(OUTAGE_NETWORKS)) {
    if (ONLY.length && !ONLY.includes(state)) continue;
    const networks = [];
    for (const net of group.networks) {
      process.stdout.write('  ' + state.toUpperCase().padEnd(4) + net.name.padEnd(28));
      const r = await scrapeOperator(page, state, net);
      networks.push(r);
      console.log(r.ok ? String(r.count).padStart(4) + ' outages (' + r.shape + ')'
        : '  -- ' + (r.blocked ? 'blocked' : r.error));
    }
    const outages = [];
    networks.forEach((n) => (n.outages || []).forEach((o) => outages.push(Object.assign({ network: n.name }, o))));
    const sum = (rows) => rows.reduce((t, o) => t + (o.customers || 0), 0);
    const unplanned = outages.filter((o) => o.kind !== 'planned');
    const planned = outages.filter((o) => o.kind === 'planned');
    states[state] = {
      state: state.toUpperCase(), name: group.name,
      count: outages.length, customers: sum(outages),
      unplannedCount: unplanned.length, unplannedCustomers: sum(unplanned),
      plannedCount: planned.length, plannedCustomers: sum(planned),
      networks: networks.map((n) => ({ name: n.name, ok: n.ok, count: n.count, blocked: n.blocked,
        error: n.error, shape: n.shape, labels: n.labels, diagnostic: n.diagnostic })),
      outages
    };
    summary.push(state.toUpperCase() + ': ' + outages.length);
  }

  await browser.close();
  mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });

  /* The data the dashboard serves, with the diagnostics stripped out -- they
     are for fixing the scraper, not for the page. */
  const clean = {};
  const diagnostics = {};
  Object.entries(states).forEach(([state, v]) => {
    clean[state] = Object.assign({}, v, {
      networks: v.networks.map(({ diagnostic, ...rest }) => rest)
    });
    v.networks.forEach((n) => {
      if (n.diagnostic) diagnostics[state + '/' + n.name] = n.diagnostic;
    });
  });

  writeFileSync(OUT, JSON.stringify({ capturedAt: Date.now(), states: clean }, null, 2) + '\n');
  writeFileSync(DIAG, JSON.stringify({ capturedAt: Date.now(), pages: diagnostics }, null, 2) + '\n');
  console.log('\nwrote ' + OUT + '  (' + summary.join(', ') + ')');
  console.log('wrote ' + DIAG + '  (' + Object.keys(diagnostics).length + ' page(s) needing work)');
})();
