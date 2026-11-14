/* What river height and flood data does the Bureau publish for machines,
   and on what terms?

   Asked for: a dashboard section that collates BOM river heights and
   organises them by where flooding is occurring. Before anything is built
   this finds out:

     1. What the anonymous FTP flood directory (/anon/gen/fwo/) holds: the
        full file list, and the products that look like river height
        tables or flood warnings, by state.
     2. A copy of each candidate, so a parser is written against what the
        files really contain.

   The FTP directory is BOM's published route for automated access.

   Run: node scripts/probe-bom-rivers.mjs
     writes data/bom-fwo-list.txt, data/bom-product-titles.tsv,
     data/bom-river-probe.json, data/bom-samples/<file>.txt */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
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

/* BOM's website is not read. Asked once (14 Nov 2026), it answered every
   page with a block notice saying automated users should stop and use the
   anonymous FTP channel, subject to its copyright notice; that notice is
   kept in data/bom-terms.txt. The dashboard's owner confirmed Suncorp holds
   a BOM data agreement covering this use. */
mkdirSync('data', { recursive: true });

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

}

/* The title of every hydrology/warning product (series 2, 3 and 6), read
   from the whole file -- they are 10-50 KB, and a ranged FTP read stalled
   BOM's server for twelve minutes. Fifty files to a connection, each batch
   time-limited. Every "Latest River Heights" table is kept in full, with
   a few flood warnings per state, so the parser is written against them. */
if (typeof listing === 'string') {
  const { readFileSync } = await import('node:fs');
  const files = listing.split(/\r?\n/).map((s) => s.trim())
    .filter((f) => /^ID[NVQSWTDZ][236]\d{4}(\.amoc)?\.(html|txt|xml)$/.test(f));
  const tmp = 'data/.bom-files';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (let i = 0; i < files.length; i += 50) {
    const args = ['--connect-timeout', '20'];
    for (const f of files.slice(i, i + 50)) args.push(FTP + f, '-o', tmp + '/' + f);
    const r = curl(args, 150);
    console.log('  batch ' + (i / 50 + 1) + '/' + Math.ceil(files.length / 50) + (typeof r === 'string' ? '' : '  ' + r.error));
  }
  rmSync('data/bom-samples', { recursive: true, force: true });
  mkdirSync('data/bom-samples', { recursive: true });
  const rows = [];
  const keptWarnings = {};
  for (const f of files) {
    let body = '';
    try { body = readFileSync(tmp + '/' + f, 'utf8'); } catch (e) { rows.push(f + '\t(not read)'); continue; }
    let title;
    if (/\.xml$/.test(f)) {
      title = 'xml: ' + ((/<title>([^<]+)/i.exec(body) || /<text type="(?:warning_)?title">([^<]+)/i.exec(body) ||
        /<product-type>([^<]+)/i.exec(body) || /<service>([^<]+)/i.exec(body) || [])[1] || '').trim();
    } else {
      title = text(body.slice(0, 4000)).replace(/^ID[A-Z]\d{5}\s*/, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2).join(' / ');
    }
    rows.push(f + '\t' + String(body.length) + '\t' + title.slice(0, 160));
    const state = f[2];
    const isHeights = /river height/i.test(title);
    const isWarning = /flood (warning|watch)|flood/i.test(title) && !isHeights;
    if (isHeights || (isWarning && (keptWarnings[state] = (keptWarnings[state] || 0) + 1) <= 3)) {
      writeFileSync('data/bom-samples/' + f + '.txt', body.slice(0, 200000));
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync('data/bom-product-titles.tsv', rows.join('\n') + '\n');
  report.titles = rows.length;
  console.log('titles for ' + rows.length + ' products; river heights:');
  for (const r of rows.filter((x) => /river height/i.test(x))) console.log('  ' + r);
}

writeFileSync('data/bom-river-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/bom-fwo-list.txt, data/bom-product-titles.tsv, data/bom-river-probe.json, data/bom-samples/');
