/* Re-tests the operators the dashboard reports as blocked, and asks whether
   they publish a machine-readable route the config does not know about.

   Written because "is this URL still blocked?" is a question with a
   measurable answer and the honest one changes over time: a WAF rule gets
   relaxed, an operator ships an API, a path moves. Quoting a days-old
   verdict as current is how a blocked operator stays blocked in the config
   long after it stopped being.

   For each operator it reports every configured URL plus a set of
   conventional ones, with status, whether a bot challenge was served, and
   any data-ish path the page itself names. It does not touch a challenge
   where it meets one.

   Run: node scripts/recheck-blocked.mjs    (writes data/blocked-recheck.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || '*/*' } });
    const text = await res.text();
    return {
      status: res.status, type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length, text,
      challenged: /Just a moment|cf-browser-verification|_Incapsula_Resource|Attention Required|Request unsuccessful|Pardon Our Interruption/i.test(text),
      title: (/<title[^>]*>([^<]{0,120})</i.exec(text) || [])[1] || ''
    };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

/* A page with rows is usable; a page that answers 200 and has none is not,
   and the difference is invisible from the status code alone. */
const rows = (html) => (html.match(/<tr[\s>]/gi) || []).length;

const TARGETS = {
  'Horizon Power': [
    'https://www.horizonpower.com.au/faults-outages/',
    'https://www.horizonpower.com.au/faults-outages/power-outages/',
    'https://www.horizonpower.com.au/faults-outages/current-outages/',
    'https://www.horizonpower.com.au/api/outages',
    'https://www.horizonpower.com.au/sitemap.xml',
    'https://www.horizonpower.com.au/robots.txt',
    'https://outages.horizonpower.com.au/',
    'https://outagemap.horizonpower.com.au/'
  ],
  'Power and Water (NT)': [
    'https://www.powerwater.com.au/outages',
    'https://www.powerwater.com.au/robots.txt'
  ],
  'SA Power Networks': [
    'https://www.sapowernetworks.com.au/outages/',
    'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageList',
    'https://www.sapowernetworks.com.au/robots.txt'
  ],
  'Essential Energy (NSW)': [
    'https://www.essentialenergy.com.au/outages',
    'https://www.essentialenergy.com.au/our-network/outages'
  ]
};

const out = { at: new Date().toISOString(), operators: {} };
for (const [op, urls] of Object.entries(TARGETS)) {
  console.log('\n======== ' + op);
  out.operators[op] = [];
  for (const url of urls) {
    const r = await get(url);
    const n = r.text ? rows(r.text) : 0;
    /* Any endpoint the page names itself is a lead the config may not have.
       An address an operator publishes is not a workaround. */
    const hints = r.text ? [...new Set((r.text.match(/["'](\/(?:api|data|services|rest|arcgis)\/[^"'\s]{2,90})["']/g) || [])
      .map((x) => x.slice(1, -1)))].slice(0, 8) : [];
    const agol = r.text ? [...new Set((r.text.match(/https?:\/\/services\d*\.arcgis\.com\/[^"'\s]{5,120}/g) || []))].slice(0, 5) : [];
    out.operators[op].push({ url, status: r.status, error: r.error, type: r.type,
      bytes: r.bytes, challenged: r.challenged, title: r.title, tableRows: n, hints, arcgis: agol });
    console.log('  ' + url);
    console.log('      ' + (r.error ? 'ERROR ' + r.error
      : 'HTTP ' + r.status + (r.challenged ? '  [BOT CHALLENGE]' : '')
        + '  ' + r.type + '  ' + r.bytes + 'b  rows=' + n)
      + (r.title ? '  "' + r.title.slice(0, 54) + '"' : ''));
    if (hints.length) console.log('      names: ' + hints.join(' '));
    if (agol.length) console.log('      ARCGIS: ' + agol.join(' '));
  }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/blocked-recheck.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/blocked-recheck.json');
