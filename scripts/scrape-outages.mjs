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
  /* Ahead of everything, including the street: an operator that names the
     towns separately has answered the question this list exists for. */
  { field: 'towns', words: ['areasaffected', 'areaaffected', 'affectedarea', 'suburbsaffected',
    'townsaffected', 'areas'] },
  /* Ahead of 'cause', which claims anything containing "fault": the
     Victorian sites label the street as "Fault location", and mapping that
     to the cause both loses the street and overwrites the real cause, which
     appears later in the same card. */
  { field: 'location', words: ['faultlocation'] },
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
    let container = null, best = 0, bestDepth = Infinity;
    const depthOf = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
    document.querySelectorAll('div,ul,ol,section,main,tbody').forEach((el) => {
      const kids = [...el.children];
      if (kids.length < 2) return;
      const matching = kids.filter((k) => LABEL.test(k.innerText || '')).length;
      if (matching < 2) return;
      /* A list is mostly outages; a card is mostly fields. Without this a
         single card wins whenever the number of its fields that mention a
         label happens to match the number of cards in the list -- which is
         how three cards were read as none. */
      if (matching < kids.length / 2) return;
      const depth = depthOf(el);
      /* Most labelled children wins. On a tie take the shallower element:
         a list wraps cards, so the outer of two tied candidates is the list. */
      if (matching > best || (matching === best && depth < bestDepth)) {
        best = matching; bestDepth = depth; container = el;
      }
    });
    if (!container) return { records: [], headings: [], shape: 'cards' };

    /* Read the card's leaf elements rather than splitting its innerText on
       newlines. The Victorian sites lay a card out as inline spans, so
       innerText comes back as one run-on string --
       "South MelbournePlannedPartially restoredEstimated restoration:15:00..."
       -- with no line to split on and no label to match, which is why 28
       outages a page were being read as none. The leaves are the fields. */
    const fragments = (el) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (!c.children.length) { const t = norm(c.innerText); if (t) out.push(t); }
          else walk(c);
        }
      };
      walk(el);
      if (!out.length) String(el.innerText || '').split('\n').map(norm).filter(Boolean).forEach((t) => out.push(t));
      return out;
    };

    const records = [];
    const labelsSeen = [];
    for (const card of container.children) {
      const text = norm(card.innerText);
      if (!text || !LABEL.test(text)) continue;
      const rec = {};
      const frags = fragments(card);

      const isLabel = (t) => !!toField(String(t).replace(/:$/, ''));
      for (let i = 0; i < frags.length; i++) {
        const f = frags[i];
        /* "Customers affected: 1" in one element. */
        const inline = /^([^:]{2,40}):\s*(.+)$/.exec(f);
        if (inline) {
          if (!labelsSeen.includes(norm(inline[1]))) labelsSeen.push(norm(inline[1]));
          const fl = toField(inline[1]);
          if (fl && !rec[fl]) rec[fl] = norm(inline[2]).slice(0, 200);
          continue;
        }
        /* Checked before the bare-label rule below, or "Planned" is read as
           a label for whatever follows it and swallows the next field. */
        if (!rec.kind && /^(un)?planned\b/i.test(f)) { rec.kind = f.slice(0, 60); continue; }
        /* A label and its value as separate elements, with the colon on
           either or neither -- all three occur. Only fragments that map to a
           known field are treated as labels, and a label is never taken as
           another label's value. */
        const bare = /^([^:]{2,40}):?$/.exec(f);
        if (bare && frags[i + 1] && !isLabel(frags[i + 1])) {
          const fl = toField(bare[1]);
          if (fl && !rec[fl]) {
            if (!labelsSeen.includes(norm(bare[1]))) labelsSeen.push(norm(bare[1]));
            rec[fl] = frags[i + 1].slice(0, 200); i++; continue;
          }
        }
        /* The first fragment that is neither a label nor a type is the
           suburb -- it leads every one of these cards. */
        if (!rec.location && !/:$/.test(f)) rec.location = f.slice(0, 200);
      }

      /* A place and nothing else is not an outage. Without this the reader
         happily returns a page's navigation -- "Manage your notifications",
         "Learn about planned outages" -- as five outages, which is worse than
         returning none: a wrong number still looks like an answer. Anything
         genuinely in an outage list carries at least a time, a count or a
         status alongside the place. */
      const substantive = rec.customers || rec.restore || rec.status || rec.id || rec.start;
      if (rec.location && substantive) records.push(rec);
    }
    return { records, headings: labelsSeen, shape: 'cards' };
  };

  /* Most of these pages state their own totals in a sentence, whether or not
     the list itself can be read: "Active outages: 9 / Affected customers:
     1,269", "1,573 Total customers off supply", "currently 3 outages
     affecting 155 customers". For a dashboard whose headline is exactly
     those two numbers, the operator's own figure is worth more than a list
     we failed to parse -- and it is the one number we can be sure of. */
  const readReported = () => {
    const t = String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
    const num = (m) => (m ? Number(String(m[1]).replace(/,/g, '')) : null);
    /* Both orders occur: "Active outages: 9" on the operator's own page,
       "47 active outages" on the aggregator's. */
    const outages = num(/active outages:?\s*([\d,]+)/i.exec(t))
      ?? num(/([\d,]+)\s+active outages?\b/i.exec(t))
      ?? num(/has\s+([\d,]+)\s+outages?\s+right now/i.exec(t))
      ?? num(/currently\s+([\d,]+)\s+outages?/i.exec(t))
      ?? num(/([\d,]+)\s+outages?\s+(?:are\s+)?(?:currently\s+)?affecting/i.exec(t));
    const customers = num(/affected customers:?\s*([\d,]+)/i.exec(t))
      ?? num(/affecting\s+([\d,]+)\s+customers/i.exec(t))
      ?? num(/([\d,]+)\s+customers off supply/i.exec(t))
      ?? num(/([\d,]+)\s+total customers off supply/i.exec(t))
      ?? num(/customers affected:?\s*([\d,]+)\s*$/i.exec(t));
    if (outages === null && customers === null) return undefined;
    return { outages, customers };
  };

  const reported = readReported();
  const table = fromTables();
  if (table.records.length) return Object.assign(table, { reported });
  const cards = fromCards();
  if (cards.records.length) return Object.assign(cards, { reported });
  return { records: [], headings: table.headings.concat(cards.headings), shape: 'none', reported };
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

/* Where else this operator's list is published, when its own site won't
   serve one. The browser can render these where a plain fetch cannot, which
   is the whole reason the aggregator is worth a second visit. */
function fallbackUrls(net) {
  return (net.sources || []).filter((src) => src.via).map((src) => ({ url: src.viaUrl || src.url, via: src.via }));
}

/* Every one of these outage maps is a client-side app that fetches its list
   from an endpoint. Reading the rendered DOM guesses at what the app did
   with that data; watching the requests the page makes of its own accord
   tells us where the data came from, which is the thing actually worth
   having -- an address the Worker can fetch directly, with no browser and no
   guessing at markup.

   This records only what the page requests on a normal load. It does not
   probe, enumerate or retry anything, and a page that never loads (a bot
   challenge) makes no such requests and so yields nothing here -- which is
   the correct outcome, not a gap to work around. */
function recordResponses(page) {
  const seen = new Map();
  /* One page object is reused for every operator, so the handler has to come
     off again at the end -- otherwise the sixteenth operator is being watched
     by sixteen listeners and inherits the previous fifteen's URLs. */
  const interesting = /\.json|\/api\/|\/rest\/services|graphql|outage|query\?|feature/i;
  const handler = (res) => {
    try {
      const url = res.url();
      if (seen.has(url) || seen.size > 60) return;
      const type = (res.headers()['content-type'] || '').toLowerCase();
      const looksData = type.includes('json') || type.includes('xml');
      if (!looksData && !interesting.test(url)) return;
      if (/\.(png|jpe?g|gif|svg|webp|woff2?|css|ico)(\?|$)/i.test(url)) return;
      seen.set(url, { url, status: res.status(), type, method: res.request().method() });
    } catch (e) { /* a response that has gone away is not worth failing over */ }
  };
  page.on('response', handler);
  return { seen, stop: () => page.removeListener('response', handler) };
}

/* A recorded endpoint is only a lead until we know it carries rows. This
   reads the bodies the browser already has, and reports each one's shape and
   first record's keys -- enough to wire it up, deliberately not enough to be
   a copy of the data. */
async function describeResponses(page, recorder) {
  recorder.stop();
  const out = [];
  for (const entry of recorder.seen.values()) {
    if (entry.status !== 200 || !entry.type.includes('json')) { out.push(entry); continue; }
    try {
      const body = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'same-origin' });
        const t = await r.text();
        return t.slice(0, 200000);
      }, entry.url).catch(() => null);
      if (!body) { out.push(entry); continue; }
      const parsed = JSON.parse(body);
      let rows = null, envelope = 'object';
      if (Array.isArray(parsed)) { rows = parsed; envelope = 'array'; }
      else if (Array.isArray(parsed.features)) { rows = parsed.features.map((f) => f.properties || f.attributes || f); envelope = 'geojson'; }
      else if (Array.isArray(parsed.results)) { rows = parsed.results; envelope = 'results'; }
      else {
        const best = Object.entries(parsed).filter(([, v]) => Array.isArray(v) && v.length)
          .sort((a, b) => b[1].length - a[1].length)[0];
        if (best) { rows = best[1]; envelope = 'wrapped:' + best[0]; }
      }
      entry.envelope = envelope;
      entry.records = rows ? rows.length : 0;
      if (rows && rows.length && rows[0] && typeof rows[0] === 'object') {
        entry.keys = Object.keys(rows[0]).slice(0, 40);
      }
    } catch (e) { entry.bodyError = String(e.message).slice(0, 80); }
    out.push(entry);
  }
  /* The ones carrying rows first -- that is what a reader of this file is
     looking for, and there can be sixty entries. */
  return out.sort((a, b) => (b.records || 0) - (a.records || 0)).slice(0, 25);
}

async function scrapeOperator(page, state, net, target) {
  const url = (target && target.url) || net.site;
  const result = { name: net.name, ok: false, count: 0, outages: [] };
  if (target && target.via) result.via = target.via;
  const recorder = recordResponses(page);
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    /* Wait for the requests to stop rather than for a fixed six seconds.
       These are client-side apps that fetch their list after load, and six
       seconds was a guess -- one that sites which take longer would fail
       silently, looking identical to a site with no list at all. Network
       idle is the actual condition being waited for. The catch matters: a
       page with a poll or a live socket never goes idle, and giving up on
       the wait is fine because the list is usually there by then anyway. */
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '');

    if (CHALLENGE.test(body) || (res && res.status() === 403)) {
      /* Deliberately not worked around -- see the header. */
      result.blocked = true;
      result.error = 'Operator blocks automated access (bot challenge); not bypassed';
      /* Recorded even here: "blocked" is a conclusion, and the page it drew
         is the evidence for it. Without this a blocked operator left nothing
         behind to check the conclusion against. */
      result.diagnostic = await page.evaluate(summariseInPage).catch(() => null);
      return result;
    }

    /* Whatever the DOM pass makes of this page, where its data came from is
       worth knowing -- most of all when the DOM pass fails. */
    result.endpoints = await describeResponses(page, recorder).catch(() => null);

    const found = await page.evaluate(extractInPage, HINTS);
    result.shape = found.shape;
    result.labels = found.headings.slice(0, 30);

    if (found.reported) result.reported = found.reported;

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
  } finally {
    /* Also on the failure paths. A page that timed out or threw is exactly
       where knowing what it managed to fetch is most useful, and the happy
       path above is the only one that had been recording it. */
    if (!result.endpoints) {
      result.endpoints = await describeResponses(page, recorder).catch(() => null);
    }
    recorder.stop();
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

/* The JSON feeds, probed from the runner rather than the browser.
   The Worker reads these in production but this build environment cannot
   reach any of the hosts, so their real field names have never been seen --
   which is why Endeavour's suburb list is still guesswork. One record from
   each, with its keys and a trimmed sample, is enough to map them properly.
   Values are cut short: this is for learning the shape, not copying data. */
async function probeFeeds() {
  const out = {};
  for (const [state, group] of Object.entries(OUTAGE_NETWORKS)) {
    if (ONLY.length && !ONLY.includes(state)) continue;
    for (const net of group.networks) {
      const jsonSources = (net.sources || []).filter((src) => src.format === 'json').slice(0, 2);
      for (const src of jsonSources) {
        const key = state + '/' + net.name;
        if (out[key] && out[key].ok) continue;
        try {
          const res = await fetch(src.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsRadar/1.0)', 'Accept': 'application/json' }
          });
          if (!res.ok) { out[key] = { url: src.url, status: res.status }; continue; }
          const body = await res.json();
          /* Whichever envelope it uses -- a FeatureCollection, an
             Opendatasoft results page, or a bare array. */
          let rec = null, envelope = 'unknown', total = null;
          if (Array.isArray(body.features)) {
            envelope = 'geojson'; total = body.features.length;
            rec = body.features[0] && body.features[0].properties;
          } else if (Array.isArray(body.results)) {
            envelope = 'results'; total = body.total_count ?? body.results.length; rec = body.results[0];
          } else if (Array.isArray(body)) {
            envelope = 'array'; total = body.length; rec = body[0];
          } else {
            const best = Object.entries(body).filter(([, v]) => Array.isArray(v) && v.length)
              .sort((a, b) => b[1].length - a[1].length)[0];
            if (best) { envelope = 'wrapped:' + best[0]; total = best[1].length; rec = best[1][0]; }
          }
          const sample = {};
          Object.keys(rec || {}).slice(0, 40).forEach((k) => {
            const v = rec[k];
            sample[k] = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 80)
              : String(v === null || v === undefined ? v : v).slice(0, 80);
          });
          out[key] = { url: src.url, status: res.status, ok: true, envelope, records: total,
            keys: Object.keys(rec || {}), sample };
        } catch (err) {
          out[key] = { url: src.url, error: String(err.message).slice(0, 140) };
        }
      }
    }
  }
  return out;
}

/* ArcGIS Online is a public catalogue, and several of these operators publish
   their outage layers to it even where their own site refuses a robot --
   Western Power is already read that way. Crucially it is a different host
   from the operator's website, so an operator behind a bot challenge can
   still have a perfectly open, documented feature service sitting in the
   catalogue under its own name.

   This searches for those, and resolves any web map it finds down to the
   layer URLs behind it, so a service can be wired up by name rather than
   guessed at. Nothing here reads anything that is not published for anyone
   to query; it is a catalogue lookup, not a way around a block. */
const ARCGIS_SEARCH = 'https://www.arcgis.com/sharing/rest/search';
/* The first pass matched the operator's full name and found Energex only
   because a council had published a layer with "Energex" in its title. An
   operator whose layer is titled "SAPN Outages" or simply "Power Outages",
   under a state government's account, was invisible to that. So each
   operator also gets its short names, and each state a query scoped to the
   place rather than the company. */
const ARCGIS_ALIASES = {
  'Essential Energy': ['Essential Energy', 'EssentialEnergy'],
  'SA Power Networks': ['SA Power Networks', 'SAPN', 'SA Power'],
  'Horizon Power': ['Horizon Power', 'Horizon'],
  'Power and Water Corporation': ['Power and Water', 'PowerWater', 'PWC Northern Territory'],
  'Evoenergy': ['Evoenergy', 'ActewAGL', 'ACT electricity'],
  'Jemena': ['Jemena'],
  'Ausgrid': ['Ausgrid'],
  'AusNet Services': ['AusNet', 'AusNet Services'],
  'TasNetworks': ['TasNetworks', 'Tasmanian Networks']
};
const ARCGIS_PLACES = ['South Australia', 'Western Australia', 'Northern Territory',
  'Australian Capital Territory', 'New South Wales'];

async function probeArcgis(names) {
  const out = {};
  const queries = [];
  names.forEach((name) => (ARCGIS_ALIASES[name] || [name])
    .forEach((alias) => queries.push([name + ' :: ' + alias, alias])));
  ARCGIS_PLACES.forEach((place) => queries.push(['place :: ' + place, place]));
  for (const [label, name] of queries) {
    const q = '(' + JSON.stringify(name) + ') AND (outage OR outages) AND ' +
      '(type:"Feature Service" OR type:"Web Map")';
    try {
      const res = await fetch(ARCGIS_SEARCH + '?q=' + encodeURIComponent(q) +
        '&f=json&num=8&sortField=numviews&sortOrder=desc');
      if (!res.ok) { out[label] = { error: 'HTTP ' + res.status }; continue; }
      const body = await res.json();
      const hits = [];
      for (const item of (body.results || [])) {
        const hit = { title: item.title, type: item.type, owner: item.owner, id: item.id, url: item.url };
        /* A web map is a container: the layers we want are inside it. */
        if (item.type === 'Web Map') {
          try {
            const dRes = await fetch('https://www.arcgis.com/sharing/rest/content/items/' +
              item.id + '/data?f=json');
            if (dRes.ok) {
              const data = await dRes.json();
              hit.layers = (data.operationalLayers || [])
                .map((l) => ({ title: l.title, url: l.url }))
                .filter((l) => l.url);
            }
          } catch (e) { hit.layersError = String(e.message).slice(0, 80); }
        }
        hits.push(hit);
      }
      out[label] = { total: body.total, hits };
    } catch (err) {
      out[label] = { error: String(err.message).slice(0, 120) };
    }
  }
  return out;
}

/* Where the catalogue has nothing, the other place live operator data is
   published openly is a data portal: the Opendatasoft platform several
   distributors run themselves (Endeavour's outage feeds are read that way
   already), and the CKAN portals the state governments run -- which matters
   here because Horizon Power, Power and Water and Evoenergy are all
   government-owned.

   Both are catalogues with a documented search API, so this asks each one
   what it publishes about outages rather than guessing at URLs. Again:
   only what is already open to anyone. */
/* Endeavour's portal is data.endeavourenergy.com.au, and the first pass
   assumed every other operator used that exact shape. All eleven guesses
   failed DNS, which says nothing about whether a portal exists -- only that
   it is not at the name I invented. These are the other shapes Opendatasoft
   customers actually use, including the platform's own subdomains, where a
   portal exists whatever the operator points its DNS at. */
const ODS_HOSTS = [
  'data.essentialenergy.com.au', 'opendata.essentialenergy.com.au',
  'essentialenergy.opendatasoft.com',
  'data.sapowernetworks.com.au', 'opendata.sapowernetworks.com.au',
  'sapowernetworks.opendatasoft.com',
  'data.horizonpower.com.au', 'horizonpower.opendatasoft.com',
  'data.powerwater.com.au', 'powerwater.opendatasoft.com',
  'data.evoenergy.com.au', 'evoenergy.opendatasoft.com',
  'data.jemena.com.au', 'jemena.opendatasoft.com',
  'data.ausgrid.com.au', 'ausgrid.opendatasoft.com',
  'data.ausnetservices.com.au', 'ausnetservices.opendatasoft.com',
  'data.westernpower.com.au', 'data.tasnetworks.com.au',
  /* The one that is known to work, as a control: if this fails too, the
     probe is broken rather than the portals being absent. */
  'data.endeavourenergy.com.au'
];
const CKAN_HOSTS = [
  'data.gov.au', 'data.qld.gov.au', 'data.wa.gov.au', 'data.nt.gov.au',
  'data.sa.gov.au', 'dataportal.act.gov.au', 'data.nsw.gov.au'
];

async function probeOpendatasoft() {
  const out = {};
  for (const host of ODS_HOSTS) {
    const url = 'https://' + host + '/api/explore/v2.1/catalog/datasets?limit=100&select=dataset_id';
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) { out[host] = { status: res.status }; continue; }
      const body = await res.json();
      const ids = (body.results || []).map((r) => r.dataset_id).filter(Boolean);
      out[host] = {
        status: res.status, total: body.total_count ?? ids.length,
        /* The whole list is worth keeping only in so far as it names the
           outage datasets; the rest is network topology and tariffs. */
        outageDatasets: ids.filter((id) => /outage|interrupt|fault|supply/i.test(id)),
        sampleIds: ids.slice(0, 25)
      };
    } catch (err) { out[host] = { error: String(err.message).slice(0, 120) }; }
  }
  return out;
}

async function probeCkan() {
  const out = {};
  for (const host of CKAN_HOSTS) {
    const url = 'https://' + host + '/api/3/action/package_search?q=' +
      encodeURIComponent('power outage') + '&rows=10';
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) { out[host] = { status: res.status }; continue; }
      const body = await res.json();
      const results = (body.result && body.result.results) || [];
      out[host] = {
        status: res.status, count: body.result && body.result.count,
        hits: results.map((r) => ({
          title: r.title, name: r.name,
          org: r.organization && r.organization.title,
          /* A dataset is only useful here if one of its resources is a live
             API or feed rather than a yearly CSV, so the formats come too. */
          resources: (r.resources || []).slice(0, 6)
            .map((x) => ({ format: x.format, name: x.name, url: x.url }))
        }))
      };
    } catch (err) { out[host] = { error: String(err.message).slice(0, 120) }; }
  }
  return out;
}

/* A feature service found in the catalogue still has to be read, and its
   column names are the thing the Worker matches on. This asks each candidate
   layer for its own schema and one live record, so the field names go into
   OUTAGE_FIELDS from the service's own description rather than a guess. */
const ARCGIS_LAYERS = [
  ['Energex areas', 'https://services.arcgis.com/bfVzktoY0OhzQCDj/arcgis/rest/services/VwEnergexOutages/FeatureServer/0'],
  ['Energex points', 'https://services.arcgis.com/bfVzktoY0OhzQCDj/arcgis/rest/services/VwEnergexOutages/FeatureServer/1'],
  ['Ergon areas', 'https://services.arcgis.com/33eHbTVqo7gtiCE8/arcgis/rest/services/VwErgonOutages/FeatureServer/0'],
  ['Western Power', 'https://services2.arcgis.com/tBLxde4cxSlNUxsM/arcgis/rest/services/WP_Outage_Prod/FeatureServer/0'],
  ['Jemena NBC', 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/NBC_Outages_Jemena/FeatureServer/0'],
  ['Jemena HCC', 'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/HCC_Outages_Jemena/FeatureServer/0']
];

async function probeArcgisLayers() {
  const out = {};
  for (const [label, base] of ARCGIS_LAYERS) {
    const entry = { url: base };
    try {
      const mRes = await fetch(base + '?f=json', { headers: { Accept: 'application/json' } });
      entry.status = mRes.status;
      if (mRes.ok) {
        const meta = await mRes.json();
        if (meta.error) entry.metaError = meta.error.message;
        entry.name = meta.name;
        entry.description = (meta.description || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
        entry.copyright = meta.copyrightText;
        entry.fields = (meta.fields || []).map((f) => f.name + ':' + f.type);
      }
      const qRes = await fetch(base + '/query?where=1%3D1&outFields=*&resultRecordCount=2&f=json',
        { headers: { Accept: 'application/json' } });
      entry.queryStatus = qRes.status;
      if (qRes.ok) {
        const q = await qRes.json();
        if (q.error) entry.queryError = q.error.message;
        entry.records = (q.features || []).length;
        entry.sample = q.features && q.features[0] && q.features[0].attributes;
      }
      const cRes = await fetch(base + '/query?where=1%3D1&returnCountOnly=true&f=json',
        { headers: { Accept: 'application/json' } });
      if (cRes.ok) { const c = await cRes.json(); entry.count = c.count; }
    } catch (err) { entry.error = String(err.message).slice(0, 140); }
    out[label] = entry;
  }
  return out;
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
  /* Collected from the raw operator results inside the loop below, not from
     the page payload afterwards. The payload is an explicit list of fields,
     and twice now a diagnostic has been gathered, dropped by that list, and
     then read as "the scraper found nothing" -- viaDiagnostic, and then
     these endpoints. Taking them off the raw result means a new diagnostic
     cannot be lost by forgetting to add it in a second place. */
  const diagnostics = {};
  const endpoints = {};
  for (const [state, group] of Object.entries(OUTAGE_NETWORKS)) {
    if (ONLY.length && !ONLY.includes(state)) continue;
    const networks = [];
    for (const net of group.networks) {
      process.stdout.write('  ' + state.toUpperCase().padEnd(4) + net.name.padEnd(28));
      let r = await scrapeOperator(page, state, net);
      /* An operator that blocks us, or whose page carries no list, is exactly
         the case the aggregator exists for -- so try it rather than recording
         a gap and moving on. Its own site is always tried first, and whatever
         answers is attributed. */
      if (!r.ok) {
        for (const alt of fallbackUrls(net)) {
          const viaResult = await scrapeOperator(page, state, net, alt);
          if (viaResult.ok) { viaResult.firstError = r.error || (r.blocked ? 'blocked' : ''); r = viaResult; break; }
          /* A fallback that fails too is the thing worth seeing: discarding it
             left no trace that the aggregator had even been visited, which is
             how a whole run looked like the fallback was never wired up. Its
             diagnostic is kept under its own key so the next run says what
             that page actually is. */
          r.viaError = alt.via + ': ' + (viaResult.blocked ? 'blocked' : (viaResult.error || 'no list found'));
          r.viaUrl = alt.url;
          if (viaResult.diagnostic) r.viaDiagnostic = viaResult.diagnostic;
          /* The aggregator's per-distributor page is a coverage directory --
             every suburb the operator serves, not the ones currently out --
             so there is no list to read. It does state the operator's totals,
             and for a state that would otherwise show nothing at all, a true
             total attributed to its source beats a blank. */
          if (viaResult.reported && !r.reported) {
            r.reported = viaResult.reported;
            r.reportedVia = alt.via;
          }
        }
      }
      networks.push(r);
      console.log(r.ok ? String(r.count).padStart(4) + ' outages (' + r.shape + ')'
        + (r.via ? ' via ' + r.via : '')
        : '  -- ' + (r.blocked ? 'blocked' : r.error) + (r.viaError ? ' | ' + r.viaError : ''));
    }
    /* CitiPower and Powercor publish one combined list on both their sites,
       so scraping each returned the same 28 outages twice -- 56 rows for 28
       events, with the customer totals doubled to match. Two operators in
       one state reporting the identical place, count and times is the same
       event republished, not a coincidence, so the first one keeps it. */
    const outages = [];
    const seenRows = new Set();
    networks.forEach((n) => (n.outages || []).forEach((o) => {
      const key = [o.location || '', o.customers, o.start || '', o.restore || '']
        .join('|').toLowerCase().replace(/\s+/g, ' ');
      if (seenRows.has(key)) return;
      seenRows.add(key);
      outages.push(Object.assign({ network: n.name }, o));
    }));
    networks.forEach((n) => {
      const before = (n.outages || []).length;
      n.count = outages.filter((o) => o.network === n.name).length;
      /* An operator whose every row was already published by another reads
         as "0 outages", which on a dashboard means "inner Melbourne is
         fine". It is not: the outages are there, listed under whoever
         reported them first. Say that instead. */
      if (before && !n.count) {
        const owner = outages.find((o) => (n.outages || []).some((x) =>
          x.location === o.location && x.customers === o.customers));
        if (owner) n.mergedInto = owner.network;
      }
    });
    networks.forEach((n) => {
      if (n.diagnostic) diagnostics[state + '/' + n.name] = n.diagnostic;
      if (n.viaDiagnostic) diagnostics[state + '/' + n.name + ' (via)'] = n.viaDiagnostic;
      if (n.endpoints && n.endpoints.length) endpoints[state + '/' + n.name] = n.endpoints;
    });
    const sum = (rows) => rows.reduce((t, o) => t + (o.customers || 0), 0);
    const unplanned = outages.filter((o) => o.kind !== 'planned');
    const planned = outages.filter((o) => o.kind === 'planned');
    states[state] = {
      state: state.toUpperCase(), name: group.name,
      count: outages.length, customers: sum(outages),
      unplannedCount: unplanned.length, unplannedCustomers: sum(unplanned),
      plannedCount: planned.length, plannedCustomers: sum(planned),
      networks: networks.map((n) => ({ name: n.name, ok: n.ok, count: n.count, blocked: n.blocked,
        error: n.error, shape: n.shape, labels: n.labels, reported: n.reported,
        mergedInto: n.mergedInto, via: n.via, viaError: n.viaError,
        reportedVia: n.reportedVia,
        diagnostic: n.diagnostic, viaDiagnostic: n.viaDiagnostic })),
      outages
    };
    summary.push(state.toUpperCase() + ': ' + outages.length);
  }

  await browser.close();
  mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });

  /* The data the dashboard serves, with the diagnostics stripped out -- they
     are for fixing the scraper, not for the page. */
  const clean = {};
  Object.entries(states).forEach(([state, v]) => {
    clean[state] = Object.assign({}, v, {
      networks: v.networks.map(({ diagnostic, viaDiagnostic, endpoints: _e, ...rest }) => rest)
    });
  });

  writeFileSync(OUT, JSON.stringify({ capturedAt: Date.now(), states: clean }, null, 2) + '\n');
  /* Anything that could not be listed is worth looking for in the catalogue. */
  console.log('\nwhat each page fetched for itself:');
  Object.entries(endpoints).forEach(([k, list]) => {
    const withRows = list.filter((e) => e.records);
    console.log('  ' + k.padEnd(30) + list.length + ' data request(s)'
      + (withRows.length ? ', ' + withRows.length + ' carrying rows' : ''));
    withRows.slice(0, 4).forEach((e) => {
      console.log('      ' + String(e.records).padStart(5) + ' rows  ' + e.url.slice(0, 130));
      if (e.keys) console.log('             keys: ' + e.keys.join(', ').slice(0, 220));
    });
  });

  const stuck = [];
  Object.values(states).forEach((v) => v.networks.forEach((n) => {
    if (!n.ok && stuck.indexOf(n.name) === -1) stuck.push(n.name);
  }));
  let arcgis = {};
  if (stuck.length) {
    console.log('\nsearching ArcGIS Online for: ' + stuck.join(', '));
    arcgis = await probeArcgis(stuck);
    Object.entries(arcgis).forEach(([name, r]) => {
      const n = r.hits ? r.hits.length : 0;
      console.log('  ' + name.padEnd(30) + (r.error ? '-- ' + r.error : n + ' item(s)'));
      (r.hits || []).forEach((h) => {
        console.log('      ' + h.type.padEnd(16) + (h.url || '(web map)') + '  ' + h.title);
        (h.layers || []).forEach((l) => console.log('        layer: ' + l.url + '  ' + l.title));
      });
    });
  }

  console.log('\nprobing the JSON feeds...');
  const feeds = await probeFeeds();
  Object.entries(feeds).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(34) + (v.ok ? v.records + ' records (' + v.envelope + ')'
      : '-- ' + (v.status ? 'HTTP ' + v.status : v.error)));
  });

  console.log('\nreading the candidate ArcGIS layers...');
  const layers = await probeArcgisLayers();
  Object.entries(layers).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(18) + (v.error ? '-- ' + v.error
      : 'meta ' + v.status + ', query ' + v.queryStatus + ', rows ' + (v.count ?? '?')
        + (v.queryError ? ' -- ' + v.queryError : '')));
    if (v.fields) console.log('      fields: ' + v.fields.join(', ').slice(0, 400));
  });

  console.log('\nasking the open data portals what they publish...');
  const ods = await probeOpendatasoft();
  Object.entries(ods).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(34) + (v.error ? '-- ' + v.error
      : v.status + (v.total !== undefined ? ' -- ' + v.total + ' datasets, outage-ish: '
        + ((v.outageDatasets || []).join(', ') || 'none') : '')));
  });
  const ckan = await probeCkan();
  Object.entries(ckan).forEach(([k, v]) => {
    console.log('  ' + k.padEnd(34) + (v.error ? '-- ' + v.error
      : v.status + (v.count !== undefined ? ' -- ' + v.count + ' match(es)' : '')));
    (v.hits || []).forEach((h) => console.log('      ' + (h.org || '') + ' :: ' + h.title));
  });

  writeFileSync(DIAG, JSON.stringify({ capturedAt: Date.now(), pages: diagnostics, endpoints,
    feeds, arcgis, layers, ods, ckan }, null, 2) + '\n');
  console.log('\nwrote ' + OUT + '  (' + summary.join(', ') + ')');
  console.log('wrote ' + DIAG + '  (' + Object.keys(diagnostics).length + ' page(s) needing work)');
})();
