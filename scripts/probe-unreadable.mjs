/* The two operators whose pages answer but cannot be read.

   Jemena and SA Power Networks are not blocked -- their pages return 200.
   The parser finds no table, which is a different problem with a different
   fix, and the only one of the six missing operators that is ours to solve
   rather than theirs to permit.

   Both are almost certainly rendering their list in the browser. That is
   how Evoenergy was recovered: its page rendered into a DataTable the
   extractor could not read, and the same page offered the identical data
   as a CSV download, which it linked to in as many words. A file the
   operator publishes for anyone to download is a better source than the
   markup around it.

   So this looks for what the page fetches for itself -- an API path, a
   hydration payload, an inline array, a CSV or JSON link -- and then
   fetches each lead and reports what came back. No protection is touched;
   neither page serves a challenge.

   Run: node scripts/probe-unreadable.mjs   (writes data/unreadable-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, accept) {
  try {
    const res = await fetch(url, { redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || '*/*' } });
    const text = await res.text();
    return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length, text, finalUrl: res.url,
      challenged: /Just a moment|_Incapsula_Resource|Attention Required|Pardon Our Interruption/i.test(text) };
  } catch (e) { return { error: e.message }; }
}

const TARGETS = [
  ['Jemena', 'https://www.jemena.com.au/outages/electricity-outages/', 'https://www.jemena.com.au'],
  ['SA Power Networks', 'https://www.sapowernetworks.com.au/outages/', 'https://www.sapowernetworks.com.au'],
  /* SA incidents has exactly one source and it has been soft-404ing for
     weeks -- data.eso.sa.gov.au answers 200 with "SA ESS - File
     Unavailable", which is why South Australia shows no incidents at all.
     This is the CFS's own public warnings page, which is where a reader
     would go, so whatever it calls for its list is the feed we want. */
  ['SA CFS warnings', 'https://www.cfs.sa.gov.au/warnings-restrictions/warnings/incidents-warnings/',
    'https://www.cfs.sa.gov.au']
];

/* Endpoints worth asking for directly as well as following from the page,
   because a list rendered by a script may name its source in a bundle this
   probe does not read. The old one is included so its state is recorded
   alongside the rest rather than remembered. */
const EXTRA = [
  'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.json',
  'https://www.cfs.sa.gov.au/api/incidents',
  'https://www.cfs.sa.gov.au/api/warnings',
  'https://www.cfs.sa.gov.au/wp-json/wp/v2/incident',
  'https://www.cfs.sa.gov.au/feed/',
  'https://alerts.sa.gov.au/api/warnings',
  'https://www.alert.sa.gov.au/api/warnings'
];

const out = { at: new Date().toISOString(), targets: [] };

for (const [name, url, origin] of TARGETS) {
  console.log('\n======== ' + name);
  const r = await get(url);
  if (r.error || !r.text) {
    out.targets.push({ name, url, error: r.error });
    console.log('  ERROR ' + r.error);
    continue;
  }
  const html = r.text;
  console.log('  HTTP ' + r.status + '  ' + r.bytes + 'b  ' + r.type
    + (r.challenged ? '  [CHALLENGE]' : '') + '  -> ' + r.finalUrl);

  /* Everything the page names that could carry data. Kept apart by kind
     because each needs a different follow-up. */
  const rel = [...new Set((html.match(/["'](\/[^"'\s]*(?:api|json|csv|outage|feed|data|service)[^"'\s]{0,90})["']/gi) || [])
    .map((x) => x.slice(1, -1)).filter((p) => !/\.(?:css|js|png|jpe?g|svg|woff2?)(?:\?|$)/i.test(p)))].slice(0, 20);
  const abs = [...new Set((html.match(/https?:\/\/[^"'\s]*(?:api|arcgis|json|csv|outage)[^"'\s]{0,90}/gi) || [])
    .filter((u) => !/\.(?:css|js|png|jpe?g|svg|woff2?)(?:\?|$)/i.test(u)))].slice(0, 15);
  const hydration = /__NEXT_DATA__|window\.__NUXT__|window\.__INITIAL_STATE__/.test(html);
  const tables = (html.match(/<tr[\s>]/gi) || []).length;

  console.log('  table rows in html: ' + tables + '   hydration payload: ' + hydration);
  console.log('  relative leads: ' + (rel.join(' ') || '(none)'));
  console.log('  absolute leads: ' + (abs.join(' ') || '(none)'));

  const tried = [];
  for (const lead of [...abs, ...rel.map((p) => origin + p)].slice(0, 12)) {
    await sleep(300);
    const rr = await get(lead, 'application/json, text/csv, */*');
    let shape = '';
    if (rr.text && /^\s*[[{]/.test(rr.text)) {
      try {
        const j = JSON.parse(rr.text);
        const arr = Array.isArray(j) ? j : (j.data || j.outages || j.items || j.features || null);
        shape = Array.isArray(arr)
          ? 'array(' + arr.length + ')' + (arr.length && typeof arr[0] === 'object'
            ? ' keys: ' + Object.keys(arr[0]).slice(0, 12).join(',') : '')
          : 'object{' + Object.keys(j).slice(0, 12).join(',') + '}';
      } catch (e) { shape = 'not json'; }
    } else if (rr.text && /,/.test((rr.text || '').split('\n')[0] || '') && (rr.type || '').includes('csv')) {
      shape = 'csv, first line: ' + (rr.text.split('\n')[0] || '').slice(0, 90);
    }
    tried.push({ url: lead, status: rr.status, type: rr.type, bytes: rr.bytes, error: rr.error, shape });
    console.log('    ' + lead.slice(0, 92));
    console.log('      ' + (rr.error ? 'ERROR ' + rr.error
      : 'HTTP ' + rr.status + '  ' + rr.type + '  ' + rr.bytes + 'b' + (shape ? '  ' + shape : '')));
  }
  out.targets.push({ name, url, status: r.status, bytes: r.bytes, tableRows: tables,
    hydration, relative: rel, absolute: abs, tried });
}

/* ---- the direct asks ------------------------------------------------- */
out.extra = [];
console.log('\n======== endpoints asked for directly');
for (const u of EXTRA) {
  await sleep(300);
  const r = await get(u, 'application/json, application/xml, */*');
  let shape = '';
  if (r.text && /^\s*[[{]/.test(r.text)) {
    try {
      const j = JSON.parse(r.text);
      const arr = Array.isArray(j) ? j : (j.data || j.incidents || j.items || j.features || null);
      shape = Array.isArray(arr)
        ? 'array(' + arr.length + ')' + (arr.length && typeof arr[0] === 'object'
          ? ' keys: ' + Object.keys(arr[0]).slice(0, 14).join(',') : '')
        : 'object{' + Object.keys(j).slice(0, 14).join(',') + '}';
    } catch (e) { shape = 'not json'; }
  } else if (r.text && /<(rss|feed|\?xml)/i.test(r.text.slice(0, 200))) {
    shape = 'xml, items=' + (r.text.match(/<(item|entry)\b/gi) || []).length;
  }
  /* A 200 that says "File Unavailable" is the failure this whole entry is
     about, so it is named rather than counted as a success. */
  const soft = r.text ? /File Unavailable|currently unavailable/i.test(r.text.slice(0, 2000)) : false;
  out.extra.push({ url: u, status: r.status, type: r.type, bytes: r.bytes, error: r.error, shape, softFail: soft });
  console.log('  ' + u.slice(0, 92));
  console.log('    ' + (r.error ? 'ERROR ' + r.error
    : 'HTTP ' + r.status + '  ' + r.type + '  ' + r.bytes + 'b'
      + (soft ? '  [SOFT 404 - says unavailable]' : '') + (shape ? '  ' + shape : '')));
}

mkdirSync('data', { recursive: true });
writeFileSync('data/unreadable-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/unreadable-probe.json');
