/* What is actually inside the Alert SA combined feed.

   Found by scripts/discover-feeds.mjs, from Alert SA's own Javascript
   bundle:

     https://combined-feed.alert.sa.gov.au/majorIncidentsCAP.xml

   200, application/xml, 48 entries, a proper CAP Atom feed. This matters
   because SA is the one state the dashboard reports nothing for, and the
   reason is not our configuration: the CFS page's OWN feeds --
   CFS_Current_Incidents.xml and CFS_Fire_Warnings.xml on
   data.eso.sa.gov.au -- answer HTTP 200 with a 197-byte "SA ESS - File
   Unavailable" page. The data host is serving a soft-404 to the agency's
   own site. No URL correction fixes that; a different publisher does.

   discover-feeds.mjs reported this feed as carrying neither an alert level
   nor outage data, which needs checking rather than believing. CAP grades
   severity as Extreme/Severe/Moderate/Minor, not as the Australian public
   wording the dashboard colours by, so a strict name-and-value test says no
   on a feed that does carry a level under a different vocabulary. And a feed
   holding no outage TODAY is not a feed that cannot hold one.

   So this reports the distinct values -- every event type, severity,
   urgency, category, and the senderName of each contributing agency -- plus
   how many entries carry usable geometry, because an entry that cannot be
   placed never reaches the map and looks exactly like no incident.

   Run: node scripts/probe-alert-sa.mjs    (writes data/alert-sa-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

/* The production feed. The discovery probe also turned up
   uat.combined-feed.alert.sa.gov.au, with 318 entries -- that is the
   agency's test environment and its contents are not real. It is probed
   here ONLY so the report says plainly that it must not be used; the
   difference between 48 real entries and 318 fabricated ones is the kind of
   thing that looks like a richer feed and is in fact a staging server. */
const FEEDS = [
  { url: 'https://combined-feed.alert.sa.gov.au/majorIncidentsCAP.xml', use: 'production' },
  { url: 'https://uat.combined-feed.alert.sa.gov.au/majorIncidentsCAP.xml', use: 'UAT -- NOT FOR USE, contents are test data' }
];

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' } });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', bytes: text.length, text };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

/* Deliberately a regex reader, not an XML parser. The Worker has no parser
   available and reads its other CAP feeds exactly this way, so a probe that
   used one would be measuring something the Worker cannot do. */
const tagAll = (xml, tag) => {
  const out = [];
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};
const tagOne = (xml, tag) => (tagAll(xml, tag)[0] || '').trim();
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const tally = (arr) => {
  const m = new Map();
  arr.filter(Boolean).forEach((v) => m.set(v, (m.get(v) || 0) + 1));
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
};

/* Does this entry describe an electricity outage? Tested against the event
   type, the headline and the description, because a combined feed labels an
   outage in the event field while an incident feed mentions power only in
   passing ("powerlines down"). Both are reported, separately, so the
   difference is visible rather than assumed. */
const OUTAGE_EVENT_RE = /power|outage|electric|supply interrupt|de-?energis/i;
const OUTAGE_STRONG_RE = /power outage|electricity outage|loss of (?:power|supply)|customers (?:affected|without)|unplanned outage|planned outage/i;

const report = { at: new Date().toISOString(), feeds: [] };

for (const f of FEEDS) {
  console.log('\n=== ' + f.url + '   (' + f.use + ')');
  const r = await get(f.url);
  if (r.error) { report.feeds.push({ ...f, error: r.error }); console.log('  ERROR ' + r.error); continue; }
  console.log('  ' + r.status + '  ' + r.type.split(';')[0] + '  ' + r.bytes + ' bytes');
  const entries = tagAll(r.text, 'entry');
  const alerts = entries.length ? entries : tagAll(r.text, 'alert');
  console.log('  entries: ' + entries.length);

  const rows = alerts.map((e) => {
    /* CAP nests the detail in <info>. Take the first, which is the English
       one in every entry of this feed. */
    const info = tagAll(e, 'info')[0] || e;
    const circle = tagOne(info, 'circle');
    const polygon = tagOne(info, 'polygon');
    /* circle is "lat,lon radiusKm". The radius is dropped -- the dashboard
       plots a point, and a 30km circle drawn over a city reads as a far
       larger emergency than the agency is declaring. */
    const cm = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(circle || polygon || '');
    return {
      event: decode(tagOne(info, 'event')),
      category: decode(tagOne(info, 'category')),
      severity: decode(tagOne(info, 'severity')),
      urgency: decode(tagOne(info, 'urgency')),
      certainty: decode(tagOne(info, 'certainty')),
      responseType: decode(tagOne(info, 'responseType')),
      senderName: decode(tagOne(info, 'senderName')),
      headline: decode(tagOne(info, 'headline')).slice(0, 110),
      areaDesc: decode(tagOne(info, 'areaDesc')).slice(0, 80),
      /* The CAP <parameter> pairs are where a jurisdiction puts its own
         vocabulary -- including, in several Australian feeds, the public
         warning level that CAP's severity does not express. */
      parameters: tagAll(info, 'parameter').map((p) =>
        decode(tagOne(p, 'valueName')) + '=' + decode(tagOne(p, 'value')).slice(0, 60)),
      hasPoint: !!cm,
      point: cm ? [Number(cm[1]), Number(cm[2])] : null,
      web: decode(tagOne(info, 'web')).slice(0, 120)
    };
  });

  const placed = rows.filter((x) => x.hasPoint).length;
  /* Australia's bounding box. A CAP circle in the wrong hemisphere is worse
     than none, and has happened on this project with a US projection. */
  const inAus = rows.filter((x) => x.point && x.point[0] < -9 && x.point[0] > -44
    && x.point[1] > 112 && x.point[1] < 154).length;

  const outageEvents = rows.filter((x) => OUTAGE_EVENT_RE.test(x.event));
  const outageText = rows.filter((x) => !OUTAGE_EVENT_RE.test(x.event)
    && OUTAGE_STRONG_RE.test(x.headline + ' ' + x.areaDesc));

  const summary = {
    ...f,
    status: r.status, bytes: r.bytes, entries: alerts.length,
    withGeometry: placed, insideAustralia: inAus,
    events: tally(rows.map((x) => x.event)),
    severities: tally(rows.map((x) => x.severity)),
    urgencies: tally(rows.map((x) => x.urgency)),
    categories: tally(rows.map((x) => x.category)),
    senders: tally(rows.map((x) => x.senderName)),
    responseTypes: tally(rows.map((x) => x.responseType)),
    parameterNames: tally(rows.flatMap((x) => x.parameters.map((p) => p.split('=')[0]))),
    outageEntriesByEvent: outageEvents.length,
    outageEntriesByText: outageText.length,
    samples: rows.slice(0, 6),
    outageSamples: outageEvents.concat(outageText).slice(0, 6)
  };
  report.feeds.push(summary);

  console.log('  geometry: ' + placed + '/' + alerts.length + ' have a point, ' + inAus + ' inside Australia');
  console.log('  events:     ' + JSON.stringify(summary.events));
  console.log('  severities: ' + JSON.stringify(summary.severities));
  console.log('  senders:    ' + JSON.stringify(summary.senders));
  console.log('  parameters: ' + JSON.stringify(summary.parameterNames));
  console.log('  outage entries: ' + outageEvents.length + ' by event type, '
    + outageText.length + ' by headline text');
  if (summary.outageSamples.length) {
    console.log('  outage samples:');
    summary.outageSamples.forEach((s) => console.log('    [' + s.event + '] ' + s.headline + '  (' + s.areaDesc + ')'));
  }
  console.log('  first entries:');
  rows.slice(0, 5).forEach((s) => console.log('    [' + s.severity + '/' + s.event + '] ' + s.headline
    + (s.hasPoint ? '  @' + s.point.join(',') : '  NO POINT')));
}

/* The question this was run to answer, stated rather than left to be read
   out of the dump. */
console.log('\n================ verdict ================');
const prod = report.feeds.find((f) => f.use === 'production');
if (!prod || prod.error) console.log('production feed unreachable: ' + (prod && prod.error));
else {
  console.log('usable for SA incidents: ' + (prod.entries > 0 && prod.insideAustralia > 0 ? 'YES' : 'NO')
    + '  (' + prod.entries + ' entries, ' + prod.insideAustralia + ' placeable)');
  console.log('carries power outages:   '
    + (prod.outageEntriesByEvent > 0 ? 'YES, as its own event type'
      : prod.outageEntriesByText > 0 ? 'mentioned in text only, not as an event type'
      : 'NONE PRESENT RIGHT NOW -- which is not the same as never'));
  console.log('contributing agencies:   ' + Object.keys(prod.senders).join(', '));
}

mkdirSync(new URL('../data', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/alert-sa-probe.json', import.meta.url), JSON.stringify(report, null, 1));
console.log('\nwrote data/alert-sa-probe.json');
