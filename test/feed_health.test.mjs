/* A dead feed must never render as a quiet day.

   SA's emergency data host answers every path -- including the two addresses
   the CFS website itself declares -- with an HTML page titled
   "SA ESS - File Unavailable", under HTTP 200. A JSON source happens to catch
   that by failing to parse. An XML or scraped source would hand the page to a
   parser, find no incidents, and report that South Australia has none. During
   a fire season that is the worst thing this dashboard could say.

   Also covers the insuranceNEWS address, which was invented because the
   channel list could not be reached from the build environment, 404d, and so
   never loaded once.

   Run: node test/feed_health.test.mjs */

const store = new Map();
globalThis.caches = {
  default: {
    async match(url) {
      const e = store.get(url);
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
    async put(url, res) { store.set(url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); }
  }
};

let upstream = {};
let fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const keys = Object.keys(upstream).filter((k) => k !== 'http').sort((a, b) => b.length - a.length);
  for (const k of keys) if (String(url).includes(k)) return upstream[k]();
  if (upstream.http) return upstream.http();
  return new Response('not stubbed', { status: 404 });
};

const mod = await import('../src/worker.js');
const worker = mod.default;
const env = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
const call = (p) => worker.fetch(new Request('https://example.test' + p), env, { waitUntil: () => {} });
const reset = () => { store.clear(); upstream = {}; fetched = []; };

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

/* The page SA actually serves. */
const UNAVAILABLE = '<!DOCTYPE html><html><head><title>SA ESS - File Unavailable</title></head>' +
  '<body><h1>File Unavailable</h1><p>The requested file is not available.</p></body></html>';

console.log('== a 200 that means "gone" is not an empty feed ==');
{
  reset();
  upstream.http = () => new Response(UNAVAILABLE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/incidents/sa')).json();
  /* The distinction the whole guard exists for. */
  check('South Australia does not report zero incidents', b.ok !== true || (b.incidents || []).length === 0, b.count);
  check('it reports a failure instead', b.ok === false, { ok: b.ok, error: b.error });
  check('and the reason quotes what the host actually said',
    /file unavailable/i.test(b.error || ''), b.error);
  check('naming it as gone rather than empty',
    /gone, not empty/i.test(b.error || ''), b.error);
}

console.log('\n== a real feed on the same path still parses ==');
{
  reset();
  /* GeoRSS as the CFS publishes it, so the guard is shown to reject only the
     soft-404 and not XML in general. */
  upstream['CFS_Current_Incidents.xml'] = () => new Response(
    '<?xml version="1.0"?><rss version="2.0"><channel><title>CFS Current Incidents</title>' +
    '<item><title>Mount Barker</title>' +
    '<description>Status: GOING&lt;br/&gt;Type: Bushfire&lt;br/&gt;Updated: 2026-10-01T02:00:00Z</description>' +
    '<georss:point>-35.07 138.86</georss:point></item></channel></rss>',
    { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
  upstream.http = () => new Response('down', { status: 503 });
  const b = await (await call('/api/incidents/sa')).json();
  check('the incident is read', (b.incidents || []).length === 1, b.incidents);
  check('its location becomes the title',
    (b.incidents[0] || {}).title === 'Mount Barker', b.incidents[0]);
  /* GOING is how the fire is behaving. It is not a warning level, and the
     feed carries none, so none must be claimed. */
  check('GOING is kept as the status', /GOING/i.test((b.incidents[0] || {}).status || ''), b.incidents[0]);
  check('and no alert level is invented from it',
    !(b.incidents[0] || {}).alertLevel, b.incidents[0]);
}

console.log('\n== an HTML page meant to be scraped is not rejected ==');
{
  reset();
  /* The guard reads the title, so a real page whose title names its contents
     must still reach parseIncidentTable. */
  upstream['cfs.sa.gov.au/warnings-restrictions'] = () => new Response(
    '<html><head><title>Warnings - CFS</title></head><body><table>' +
    '<tr><th>Location</th><th>Alert Level</th><th>Incident Type</th></tr>' +
    '<tr><td>Kangaroo Island</td><td>Watch and Act</td><td>Bushfire</td></tr>' +
    '</table></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html' } });
  upstream.http = () => new Response(UNAVAILABLE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const b = await (await call('/api/incidents/sa')).json();
  check('the scraped page is read', (b.incidents || []).length === 1, b.incidents);
  check('and its alert level comes through',
    (b.incidents[0] || {}).alertLevel === 'Watch and Act', b.incidents[0]);
}

console.log('\n== SA is no longer one URL deep ==');
{
  reset();
  upstream.http = () => new Response(UNAVAILABLE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  await call('/api/incidents/sa');
  const tried = fetched.filter((u) => /eso\.sa\.gov\.au|cfs\.sa\.gov\.au/.test(u));
  check('every known address is tried', tried.length >= 4, tried);
  /* The addresses the CFS itself declares come first: when the host recovers,
     this works again with no change here. */
  check('the declared feeds lead', /CFS_Current_Incidents\.xml/.test(tried[0] || ''), tried[0]);
}

console.log('\n== the insuranceNEWS address is the declared one ==');
{
  const src = (await import('node:fs')).readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const entry = /\{[^{}]*insurancenews\.com\.au[^{}]*\}/.exec(src);
  check('the feed is configured', !!entry);
  /* /rss/all-news was invented and 404s; /rss/all is what the site declares
     and returns 20 items. */
  check('it uses /rss/all', /insurancenews\.com\.au\/rss\/all['"]/.test(entry[0]), entry[0]);
  /* Scoped to configured URLs: the dead address is still named in the
     comment above the entry, which is where it belongs -- the next person
     needs to know why that path is not used. */
  const urls = src.match(/url:\s*'[^']+'/g) || [];
  check('and no configured url uses the invented /rss/all-news',
    !urls.some((u) => /rss\/all-news/.test(u)),
    urls.filter((u) => /insurancenews/.test(u)));
}

console.log('\n== the regions that had no source at all ==');
{
  const src = (await import('node:fs')).readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const feeds = src.match(/\{ name: '[^']+', domain: '[^']+', group: '[^']+', url: '[^']+'/g) || [];
  const has = (re) => feeds.some((f) => re.test(f));
  /* The Northern Territory, northern Queensland and South Australia had
     nothing. Each of these was fetched and seen to return articles before
     being added -- the counts are in data/feed-probe.json. */
  check('the Northern Territory is covered',
    has(/katherinetimes/) && has(/ntindependent/), feeds.filter((f) => /nt|katherine/i.test(f)));
  check('northern Queensland is covered',
    has(/northweststar/) || has(/queenslandcountrylife/));
  check('South Australia is covered', has(/stockjournal/));
  check('the ACT has more than one source',
    has(/canberratimes/) && has(/the-riotact/));

  /* Nothing unverified gets in. These were all probed and all failed --
     Cairns and Townsville serve an empty feed, and the Adelaide Advertiser,
     InDaily and Port Lincoln Times answer 403. Adding any of them would put
     a source in the list that can never load, which is what insuranceNEWS
     did for however long. */
  ['cairnspost', 'townsvillebulletin', 'adelaidenow', 'indaily.com.au',
   'portlincolntimes', 'tropicnow', 'cairnslocalnews', 'nit.com.au']
    .forEach((dead) => {
      check('no feed configured for ' + dead + ' (probed, does not work)',
        !feeds.some((f) => f.includes(dead)));
    });
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
