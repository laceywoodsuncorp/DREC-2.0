/* Can each operator's own outage page be shown in an iframe on the
   dashboard?

   For the operators we cannot read -- blocked, unreadable, or moved -- the
   dashboard offers their own map in a tab instead. Whether that works is
   the operator's decision, stated in two response headers:

     X-Frame-Options: DENY | SAMEORIGIN        -> may not be framed
     Content-Security-Policy: frame-ancestors  -> who may frame it

   A page that forbids framing shows as a blank box, and that is a policy
   to respect, not something to work around -- the tab then offers a link
   instead of an iframe. Proxying the page through the Worker to strip the
   header would be overriding the operator's choice, and would hit the same
   bot protection that blocks the capture.

   One limit, stated rather than hidden: several of these sites put a bot
   challenge in front of automated requests, and a challenge page carries
   its OWN headers. For those this cannot see the real page's policy, and
   says so -- `challenged: true` -- rather than reporting the challenge's
   headers as the operator's.

   Run: node scripts/probe-embeddable.mjs    (writes data/embed-probe.json) */
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const CHALLENGE = /just a moment|attention required|checking your browser|_Incapsula_Resource|Request unsuccessful\. Incapsula|cf-browser-verification|ddos protection/i;

const CANDIDATES = {
  'Power and Water Corporation': ['https://www.powerwater.com.au/outages/current-outages', 'https://www.powerwater.com.au/outages'],
  'SA Power Networks': ['https://www.sapowernetworks.com.au/outages/', 'https://outage.apps.sapowernetworks.com.au/OutageReport/OutageList'],
  'Essential Energy': ['https://www.essentialenergy.com.au/outages-and-faults/power-outages'],
  'Horizon Power': ['https://www.horizonpower.com.au/faults-outages/', 'https://www.horizonpower.com.au/faults-outages/power-outages/'],
  'AusNet Services': ['https://www.ausnetservices.com.au/outages', 'https://ausnetservices.my.salesforce-sites.com/OutageTracker/'],
  'Jemena': ['https://www.jemena.com.au/outages/electricity-outages/'],
  /* The old list page now answers 404, so its replacement is searched for
     among the shapes its sister companies CitiPower and Powercor use. */
  'United Energy': ['https://www.unitedenergy.com.au/outages/live-outage-map',
    'https://www.unitedenergy.com.au/outages/', 'https://www.unitedenergy.com.au/outages',
    'https://www.unitedenergy.com.au/power-outages/', 'https://www.unitedenergy.com.au/power-outages-and-emergencies/']
};

/* frame-ancestors from a CSP, if present. */
const frameAncestors = (csp) => {
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp || '');
  return m ? m[1].trim() : null;
};
/* The operator's stated policy, read conservatively: anything but an
   explicit allowance for any origin counts as "may not be framed by us". */
function verdict(xfo, fa) {
  if (fa !== null) {
    if (/(^|\s)\*(\s|$)/.test(fa) || /https:(\s|$)/.test(fa)) return 'allowed';
    return 'forbidden';   // 'none', 'self', or a list that is not us
  }
  if (xfo && /deny|sameorigin/i.test(xfo)) return 'forbidden';
  return 'allowed';       // no policy stated: browsers allow framing
}

const report = { at: new Date().toISOString(), operators: {} };
for (const [op, urls] of Object.entries(CANDIDATES)) {
  report.operators[op] = [];
  for (const url of urls) {
    const row = { url };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
      clearTimeout(t);
      const body = await res.text();
      row.status = res.status;
      if (res.url && res.url !== url) row.finalUrl = res.url;
      row.title = ((/<title[^>]*>([^<]{0,120})</i.exec(body) || [])[1] || '').trim();
      row.xFrameOptions = res.headers.get('x-frame-options');
      row.frameAncestors = frameAncestors(res.headers.get('content-security-policy'));
      row.challenged = CHALLENGE.test(body) || CHALLENGE.test(row.title);
      row.embedding = row.challenged ? 'unknown (challenge page headers, not the real page)'
        : res.status >= 400 ? 'n/a (page not found)'
          : verdict(row.xFrameOptions, row.frameAncestors);
    } catch (e) { row.error = e.name === 'AbortError' ? 'timeout' : e.message; }
    report.operators[op].push(row);
    console.log(op.padEnd(28) + String(row.status || row.error).padEnd(6) + String(row.embedding || '').padEnd(48)
      + 'XFO=' + row.xFrameOptions + '  FA=' + row.frameAncestors + '\n' + ' '.repeat(28) + url
      + (row.finalUrl ? '  -> ' + row.finalUrl : '') + (row.title ? '  "' + row.title.slice(0, 60) + '"' : ''));
  }
}
/* An operator none of whose candidate pages exist has moved its outage
   page. Its home page is read for links mentioning outages, so the tab can
   point at where the page went rather than at another guess. */
report.discovered = {};
const HOMES = { 'United Energy': 'https://www.unitedenergy.com.au/' };
for (const [op, home] of Object.entries(HOMES)) {
  const rows = report.operators[op] || [];
  if (rows.some((r) => r.status && r.status < 400)) continue;
  try {
    const res = await fetch(home, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const html = await res.text();
    const links = [...new Set([...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1])
      .filter((h) => /outage|fault|power-?cut|interruption/i.test(h))
      .map((h) => { try { return new URL(h, home).href; } catch (e) { return null; } }).filter(Boolean))];
    report.discovered[op] = [];
    for (const href of links.slice(0, 12)) {
      try {
        const r2 = await fetch(href, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html' } });
        const b2 = await r2.text();
        const row = { url: href, status: r2.status, finalUrl: r2.url !== href ? r2.url : undefined,
          title: ((/<title[^>]*>([^<]{0,120})</i.exec(b2) || [])[1] || '').trim(),
          xFrameOptions: r2.headers.get('x-frame-options'),
          frameAncestors: frameAncestors(r2.headers.get('content-security-policy')) };
        report.discovered[op].push(row);
        console.log('  found ' + op + ': ' + row.status + '  ' + href + '  "' + row.title.slice(0, 60) + '"  XFO=' + row.xFrameOptions);
      } catch (e) { report.discovered[op].push({ url: href, error: e.message }); }
    }
    if (!links.length) console.log('  ' + op + ': home page has no outage links (' + res.status + ')');
  } catch (e) { report.discovered[op] = { error: e.message }; }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/embed-probe.json', JSON.stringify(report, null, 1) + '\n');
console.log('\nwrote data/embed-probe.json');
