/* Which agency publishes an alert level, and at what address?

   NSW works on the dashboard because the RFS puts the alert level in its
   own field, so the page can rank and colour by what the agency is telling
   the public to do. Measured against the live service, the others divide
   into three groups and each needs something different:

     nsw  21/21 carry a level
     vic  22/22 carry a "level" that is really the event type -- Earthquake,
          Tree Down, Building Damage -- mixed in with the two real ones
     tas  carries a level with an HTML tag still attached
     qld, wa, act  carry none; their feeds are incident and dispatch feeds
          (Going, Contained, Units On Route), which is operational state,
          not public instruction
     sa   host is serving its soft-404 again
     nt   no incidents at all right now

   So the question for the third group is whether the agency publishes
   warnings somewhere else. They generally do, separately from incidents.
   This finds out rather than guessing, which on this project has a poor
   record: a URL that 404s contributes nothing and looks identical to a quiet
   day.

   For every candidate it reports the status, the shape, how many items, and
   the distinct values of any field whose name OR content looks like an alert
   level -- because the field name varies and the values are the actual test.
   A feed whose values are Advice / Watch and Act / Emergency Warning is
   usable; one whose values are Going / Contained is another incident feed
   wearing a different name.

   Run: node scripts/probe-warnings.mjs    (writes data/warnings-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

/* The three published alert levels, and the words that mean "this is an
   operational state, not a warning". The second list is what tells a warning
   feed apart from an incident feed. */
const LEVEL_RE = /emergency warning|watch and act|watch & act|^advice$|advice|all clear|prepare to (leave|evacuate)|evacuat/i;
const OPERATIONAL_RE = /^(going|contained|controlled|patrolled|safe|out|under control|on scene|units? on route|resource allocation pending|responding|notified)$/i;

async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || '*/*' }
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', bytes: text.length, text,
      challenged: /Just a moment|cf-browser-verification|_Incapsula_Resource|Attention Required/i.test(text),
      title: (/<title[^>]*>([^<]{0,140})</i.exec(text) || [])[1] || '' };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

/* Walks anything -- GeoJSON properties, CAP elements, a bare array -- and
   collects every scalar whose key or value looks level-ish. Written as a
   walker rather than a field list because guessing the field name is the
   mistake this file exists to avoid. */
function harvest(node, out = { levelish: {}, keys: new Set() }, depth = 0) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) { node.slice(0, 400).forEach((n) => harvest(n, out, depth + 1)); return out; }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { out.keys.add(k); harvest(v, out, depth + 1); continue; }
    const key = String(k).toLowerCase();
    const val = String(v == null ? '' : v).trim();
    if (!val) continue;
    const keyLooks = /alert|warning|severity|urgency|level|category|status/.test(key);
    if (keyLooks || LEVEL_RE.test(val)) {
      out.levelish[k] = out.levelish[k] || new Set();
      if (out.levelish[k].size < 14) out.levelish[k].add(val.slice(0, 60));
    }
  }
  return out;
}

function describe(r) {
  if (r.error) return { error: r.error };
  if (r.challenged) return { status: r.status, challenged: true, title: r.title };
  if (r.status !== 200) return { status: r.status, title: r.title, bytes: r.bytes };
  const d = { status: r.status, type: r.type.split(';')[0], bytes: r.bytes };
  const body = r.text.trim();
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const j = JSON.parse(body);
      d.shape = Array.isArray(j) ? 'array' : 'object';
      d.items = Array.isArray(j) ? j.length
        : (j.features ? j.features.length : (j.items ? j.items.length : undefined));
      const h = harvest(j);
      d.fields = Object.fromEntries(Object.entries(h.levelish).map(([k, s]) => [k, [...s]]));
    } catch (e) { d.jsonError = e.message; }
  } else if (/<(rss|feed|alert|kml|\?xml)/i.test(body.slice(0, 400))) {
    d.shape = 'xml';
    d.items = (body.match(/<(item|entry|info|Placemark)\b/gi) || []).length;
    /* CAP and GeoRSS keep the level in an element, so read element contents
       whose tag name looks level-ish. Tags are stripped from the value --
       Tasmania's level arrives as "Informational<br>" in the live feed, which
       is exactly the sort of thing that must be visible here. */
    const fields = {};
    const re = /<([a-z0-9_:.-]*(?:alert|warning|severity|urgency|level|category|status)[a-z0-9_:.-]*)[^>]*>([\s\S]{0,200}?)<\/\1>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const tag = m[1].replace(/^.*:/, '');
      const val = m[2].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ').trim();
      if (!val) continue;
      fields[tag] = fields[tag] || new Set();
      if (fields[tag].size < 14) fields[tag].add(val.slice(0, 60));
    }
    d.fields = Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, [...s]]));
  } else { d.shape = 'html'; d.title = r.title; }

  /* The verdict, stated rather than left to be eyeballed. */
  const vals = Object.values(d.fields || {}).flat();
  const real = vals.filter((v) => LEVEL_RE.test(v) && !OPERATIONAL_RE.test(v));
  const ops = vals.filter((v) => OPERATIONAL_RE.test(v));
  d.verdict = real.length ? 'CARRIES ALERT LEVELS: ' + [...new Set(real)].slice(0, 6).join(' | ')
    : ops.length ? 'operational status only: ' + [...new Set(ops)].slice(0, 6).join(' | ')
    : 'no level-like field found';
  return d;
}

/* Candidates per state. Documented sources and conventional paths; each is
   tested, none assumed. */
const CANDIDATES = {
  qld: [
    'https://www.qfes.qld.gov.au/data/alerts/bushfireAlert.json',
    'https://www.fire.qld.gov.au/data/alerts/bushfireAlert.json',
    'https://www.qfes.qld.gov.au/data/alerts/bushfireAlert.xml',
    'https://www.disaster.qld.gov.au/warnings/rss',
    'https://services1.arcgis.com/vkTwD8kHw2woKBqV/arcgis/rest/services?f=json',
    'https://www.qld.gov.au/emergency/dealing-disasters/current-warnings'
  ],
  wa: [
    /* Already configured in the Worker as a partial fallback, which means it
       is only reached when the primary incident feed fails -- and it never
       fails, so this has never been read. */
    'https://api.emergency.wa.gov.au/v1/rss/warnings',
    'https://api.emergency.wa.gov.au/v1/warnings',
    'https://www.emergency.wa.gov.au/data/warnings_FCAD.json',
    'https://www.emergency.wa.gov.au/data/message_FCAD.json'
  ],
  act: [
    'https://data.esa.act.gov.au/feeds/esa-cap-incidents.xml',
    'https://data.esa.act.gov.au/feeds/esa-cap-warnings.xml',
    'https://data.esa.act.gov.au/feeds/esa-warnings.xml',
    'https://esa.act.gov.au/feeds/warnings.xml'
  ],
  vic: [
    'https://emergency.vic.gov.au/public/events-geojson.json',
    'https://emergency.vic.gov.au/public/warnings-geojson.json',
    'https://emergency.vic.gov.au/public/osom-geojson.json'
  ],
  tas: [
    'https://alert.tas.gov.au/data/incidents-and-alerts.xml',
    'https://alert.tas.gov.au/data/warnings.xml'
  ],
  /* Both data.eso.sa.gov.au addresses answer 200 with a 197-byte "SA ESS -
     File Unavailable" page, which is why SA reported ok:true, complete:true,
     count:0 -- a soft-404 reads exactly like a quiet day. The CFS page a
     human actually opens is included so the probe reports what IT says
     rather than what we assume about the data host. */
  sa: [
    'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_current_incidents.json',
    'https://www.cfs.sa.gov.au/warnings/feed/',
    'https://data.eso.sa.gov.au/prod/cfs/criimson/cfs_warnings.json',
    'https://www.cfs.sa.gov.au/warnings-restrictions/warnings/incidents-warnings/',
    'https://alert.sa.gov.au/'
  ],
  nt: [
    'https://securent.nt.gov.au/alerts-warnings',
    'https://securent.nt.gov.au/respond/bushfire-alerts',
    'https://www.pfes.nt.gov.au/incidentmap/json/incidents.json'
  ],
  /* The national aggregator. If it carries per-jurisdiction warnings with
     levels, one feed answers the states that publish none of their own. */
  national: [
    'https://warnings.australia.gov.au/feeds/warnings.json',
    'https://api.weather.bom.gov.au/v1/warnings',
    'http://www.bom.gov.au/fwo/IDZ00054.warnings_land_nsw.xml'
  ]
};

const out = { at: new Date().toISOString(), states: {} };
for (const [state, urls] of Object.entries(CANDIDATES)) {
  out.states[state] = [];
  console.log('\n=== ' + state.toUpperCase() + ' ===');
  for (const url of urls) {
    const d = describe(await get(url, 'application/json, application/xml, text/xml, */*'));
    out.states[state].push(Object.assign({ url }, d));
    console.log('  ' + url);
    console.log('      ' + (d.error ? 'ERROR ' + d.error
      : d.challenged ? 'HTTP ' + d.status + '  [BOT CHALLENGE]'
      : 'HTTP ' + d.status + '  ' + (d.shape || '') + '  items=' + (d.items === undefined ? '?' : d.items)));
    if (d.verdict) console.log('      ' + d.verdict);
    Object.entries(d.fields || {}).slice(0, 6).forEach(([k, v]) =>
      console.log('        ' + k + ': ' + v.slice(0, 6).join(' | ')));
  }
}

mkdirSync('data', { recursive: true });
writeFileSync('data/warnings-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/warnings-probe.json');
