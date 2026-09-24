/* A map of outages needs a coordinate for every town, and only four of the
   sixteen operators publish one. Energex, Ergon, Western Power and Endeavour
   send geometry; everyone else sends a town name and nothing else. Drawn from
   coordinates alone the map would show Queensland, Western Australia and part
   of western Sydney, and all of Victoria -- which usually has the most
   readable rows -- would be empty. An empty map reads as "no outages", which
   is the one thing this dashboard must never say when it simply does not
   know.

   So the town names need resolving to positions, and the same gazetteer
   answers the other two parts: which state a searched place is in, and
   therefore which distributor serves it and whether that distributor is one
   that blocks us.

   This probes candidate open datasets rather than picking one blind. It
   reports each one's size, shape and a sample record; the smallest file that
   carries locality name, state and a centroid wins. Licensing matters as much
   as shape, so the source is recorded with the data.

   Run: node scripts/probe-gazetteer.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const CANDIDATES = [
  ['ABS SAL 2021 (data.gov.au search)',
   'https://data.gov.au/data/api/3/action/package_search?q=suburbs+and+localities+ASGS&rows=5'],
  ['data.gov.au postcodes',
   'https://data.gov.au/data/api/3/action/package_search?q=australian+postcodes+localities&rows=5'],
  ['GA Gazetteer (data.gov.au)',
   'https://data.gov.au/data/api/3/action/package_search?q=gazetteer+place+names&rows=5'],
  /* Geoscience Australia's place names as a feature service -- the same kind
     of source the Queensland outage layers came from. */
  ['GA place names ArcGIS',
   'https://services.ga.gov.au/gis/rest/services?f=json'],
  ['ArcGIS catalogue: AU localities',
   'https://www.arcgis.com/sharing/rest/search?q=' +
     encodeURIComponent('("suburb" OR "locality" OR "gazetteer") AND Australia AND (type:"Feature Service")') +
     '&f=json&num=10&sortField=numviews&sortOrder=desc']
];

const out = {};
for (const [label, url] of CANDIDATES) {
  const entry = { url };
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    entry.status = res.status;
    const text = await res.text();
    entry.bytes = text.length;
    if (!res.ok) { entry.head = text.slice(0, 200); out[label] = entry; continue; }
    const body = JSON.parse(text);
    if (body.result && body.result.results) {
      entry.hits = body.result.results.map((r) => ({
        title: r.title,
        org: r.organization && r.organization.title,
        license: r.license_title,
        resources: (r.resources || []).slice(0, 8)
          .map((x) => ({ format: x.format, name: String(x.name).slice(0, 60), url: x.url }))
      }));
    } else if (body.results) {
      entry.hits = body.results.map((r) => ({
        title: r.title, type: r.type, owner: r.owner, url: r.url, id: r.id
      }));
    } else if (body.services) {
      entry.services = body.services.map((s) => s.name + ' (' + s.type + ')').slice(0, 40);
      entry.folders = body.folders;
    } else {
      entry.keys = Object.keys(body).slice(0, 12);
    }
  } catch (err) { entry.error = String(err.message).slice(0, 140); }
  out[label] = entry;
}

Object.entries(out).forEach(([k, v]) => {
  console.log('==== ' + k);
  console.log('   ' + (v.error ? 'ERR ' + v.error : 'HTTP ' + v.status + ', ' + v.bytes + ' bytes'));
  (v.hits || []).forEach((h) => {
    console.log('   - ' + (h.title || h.url) + (h.license ? '   [' + h.license + ']' : '')
      + (h.org ? '   (' + h.org + ')' : '') + (h.type ? '   ' + h.type : ''));
    (h.resources || []).forEach((r) =>
      console.log('       ' + String(r.format).padEnd(8) + String(r.url).slice(0, 120)));
    if (h.url && !h.resources) console.log('       ' + String(h.url).slice(0, 120));
  });
  (v.services || []).filter((s) => /place|name|locality|suburb|gazett/i.test(s))
    .forEach((s) => console.log('   service: ' + s));
});

mkdirSync('data', { recursive: true });
writeFileSync('data/gazetteer-probe.json', JSON.stringify({ capturedAt: Date.now(), candidates: out }, null, 2) + '\n');
console.log('\nwrote data/gazetteer-probe.json');
