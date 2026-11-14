/* What river height and flood data does the Bureau publish for machines,
   and on what terms?

   Asked for: a dashboard section that collates BOM river heights and
   organises them by where flooding is occurring. Before anything is built
   this finds out:

     1. BOM's own terms -- copyright/licence, disclaimer, the anonymous FTP
        and data feed catalogues, robots.txt -- kept as text, because the
        dashboard would republish the data and the terms decide how.
     2. What the anonymous FTP flood directory (/anon/gen/fwo/) holds: the
        full file list, and the products that look like river height
        tables or flood warnings, by state.
     3. A sample of each candidate, so a parser is written against what the
        files really contain.

   The FTP directory is BOM's published route for automated access; the
   web pages are read once each, for their terms, and nothing else is
   taken from them.

   Run: node scripts/probe-bom-rivers.mjs
     writes data/bom-terms.txt, data/bom-fwo-list.txt, data/bom-river-probe.json,
     data/bom-samples/<file>.txt */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const PAGES = [
  'https://www.bom.gov.au/other/copyright.shtml',
  'https://www.bom.gov.au/other/disclaimer.shtml',
  'https://www.bom.gov.au/catalogue/anon-ftp.shtml',
  'https://www.bom.gov.au/catalogue/data-feeds.shtml',
  'https://www.bom.gov.au/robots.txt'
];
const FTP = 'ftp://ftp.bom.gov.au/anon/gen/fwo/';
const report = { at: new Date().toISOString(), pages: {}, ftp: {}, samples: {} };

const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|h\d|li|div|tr|td|th|dt|dd)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/* curl for FTP, which fetch cannot do. Arguments are fixed strings built
   here, never input. */
const curl = (args, max = 30) => {
  try {
    return execFileSync('curl', ['-sS', '--max-time', String(max), '-A', UA, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { return { error: String(e.stderr || e.message).slice(0, 300) }; }
};

let terms = '';
for (const url of PAGES) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain' }, redirect: 'follow' });
    const body = await res.text();
    const t = /robots\.txt$/.test(url) ? body : text((/<main[\s\S]*?<\/main>/i.exec(body) || /<body[\s\S]*<\/body>/i.exec(body) || [body])[0]);
    report.pages[url] = { status: res.status, finalUrl: res.url, chars: t.length };
    terms += '\n\n==================== ' + url + ' (HTTP ' + res.status + ')\n' + t.slice(0, 30000);
    console.log(url + '  ' + res.status + '  ' + t.length + ' chars');
  } catch (e) { report.pages[url] = { error: e.message }; console.log(url + '  ' + e.message); }
  await new Promise((r) => setTimeout(r, 1500));
}
mkdirSync('data', { recursive: true });
writeFileSync('data/bom-terms.txt', terms.trim() + '\n');

const listing = curl(['--list-only', FTP], 60);
if (typeof listing !== 'string') {
  report.ftp = listing;
  console.log('ftp listing failed: ' + listing.error);
} else {
  const files = listing.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
  writeFileSync('data/bom-fwo-list.txt', files.join('\n') + '\n');
  /* State prefixes: N NSW/ACT, V Vic, Q Qld, S SA, W WA, T Tas, D NT. */
  const byPrefix = {};
  for (const f of files) {
    const m = /^(ID[A-Z])(\d)/.exec(f);
    const k = m ? m[1] + m[2] : 'other';
    byPrefix[k] = (byPrefix[k] || 0) + 1;
  }
  /* Series 6 is BOM's hydrology products (river heights, flood warnings);
     anything mentioning flood or river is kept as a lead too. */
  const leads = files.filter((f) => /^ID[NVQSWTD]6\d{4}/.test(f) || /flood|river|warn/i.test(f));
  report.ftp = { files: files.length, byPrefix, leads: leads.length, leadSample: leads.slice(0, 400) };
  console.log('ftp ' + files.length + ' files, ' + leads.length + ' hydrology leads');

  /* A sample of each product family: the distinct ID stems (IDQ60005,
     IDN36500 ...), first file of each, capped. */
  rmSync('data/bom-samples', { recursive: true, force: true });
  mkdirSync('data/bom-samples', { recursive: true });
  const stems = new Map();
  for (const f of leads) {
    const stem = (/^(ID[A-Z]\d{5})/.exec(f) || [f])[0];
    if (!stems.has(stem)) stems.set(stem, f);
  }
  /* River height tables are the priority: within each state, the 6xxxx
     family first. */
  const pick = [...stems.values()].sort((a, b) => (/6\d{4}/.test(b) - /6\d{4}/.test(a)) || a.localeCompare(b)).slice(0, 60);
  for (const f of pick) {
    const body = curl([FTP + f], 30);
    if (typeof body !== 'string') { report.samples[f] = body; continue; }
    const isHtml = /<html|<table/i.test(body);
    const sample = isHtml ? text(body) : body;
    report.samples[f] = { bytes: body.length, kind: /<\?xml/.test(body) ? 'xml' : isHtml ? 'html' : 'text',
      title: ((/<title[^>]*>([^<]{0,160})/i.exec(body) || /<(?:headline|title|productTitle)[^>]*>([^<]{0,160})/i.exec(body) || [])[1] || '').trim(),
      head: sample.slice(0, 400) };
    writeFileSync('data/bom-samples/' + f.replace(/[^\w.-]/g, '_') + '.txt', sample.slice(0, 12000));
    console.log('  ' + f.padEnd(24) + String(body.length).padStart(8) + 'B  ' + report.samples[f].kind + '  ' + report.samples[f].title);
  }
}
writeFileSync('data/bom-river-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/bom-terms.txt, data/bom-fwo-list.txt, data/bom-river-probe.json, data/bom-samples/');
