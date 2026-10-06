/* Dumps the real structure of the four feeds the warnings probe found, so
   parsers are written against what arrives rather than against a guess.

   The warnings probe established that these carry public alert levels:

     qld  qfes.qld.gov.au/data/alerts/bushfireAlert.json   59 items, "Advice"
     wa   api.emergency.wa.gov.au/v1/warnings              levels as slugs,
                                                           "ew-bushfire--advice"
     vic  emergency.vic.gov.au/public/events-geojson.json   "Advice",
                                                           "Watch & Act"
     nt   pfes.nt.gov.au/incidentmap/json/incidents.json    "bushfire-advice"

   Two of those are already configured in the Worker and neither yields a
   level today: VIC's because the field being read is category1, which in
   VicEmergency is the event type, and the NT's because its envelope is not
   one the record-walker recognises -- the live service returns zero NT
   incidents while this feed clearly holds some.

   So the useful output is not "does it work" but "what are the keys called".
   Every previous attempt here guessed a field name, matched nothing, and
   read as an empty feed rather than a wrong one.

   Run: node scripts/probe-shapes.mjs    (writes data/shape-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';

const TARGETS = {
  qld: 'https://www.qfes.qld.gov.au/data/alerts/bushfireAlert.json',
  wa: 'https://api.emergency.wa.gov.au/v1/warnings',
  vic: 'https://emergency.vic.gov.au/public/events-geojson.json',
  nt: 'https://www.pfes.nt.gov.au/incidentmap/json/incidents.json'
};

/* Describes a value by its shape, not its content, so the skeleton stays
   readable however big the payload is. */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'array(0)';
    return 'array(' + v.length + ') of ' + (depth > 3 ? '…' : shape(v[0], depth + 1));
  }
  if (typeof v === 'object') {
    if (depth > 3) return 'object{…}';
    const keys = Object.keys(v);
    return 'object{' + keys.slice(0, 40).join(', ') + (keys.length > 40 ? ', …' : '') + '}';
  }
  if (typeof v === 'string') return 'string(' + v.length + ')';
  return typeof v;
}

/* Finds the array that holds the records, wherever it is. Written as a search
   rather than an assumption because the envelope has been guessed wrong on
   this project three times -- array-only, then largest-top-level-array, then
   a hard-coded `items`. */
function findRecordArrays(node, path = '$', out = [], depth = 0) {
  if (depth > 5 || node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && !Array.isArray(node[0])) {
      /* The record itself is kept, not just its path. Reconstructing the path
         with a string reducer was how the first run of this probe printed no
         sample at all -- the keys are the entire point of the exercise, so
         they do not get to depend on parsing my own path notation. */
      out.push({ path, length: node.length, keys: Object.keys(node[0]), _first: node[0] });
    }
    if (node.length) findRecordArrays(node[0], path + '[0]', out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) findRecordArrays(v, path + '.' + k, out, depth + 1);
  return out;
}

/* A record trimmed for printing: long strings cut, nested objects reduced to
   their shape. Seeing that a field holds a paragraph of markup is itself
   information, so values are cut rather than dropped. */
function trim(sample) {
  const t = {};
  if (!sample || typeof sample !== 'object') return t;
  for (const [k, v] of Object.entries(sample)) {
    t[k] = typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…[' + v.length + ']'
      : (v && typeof v === 'object' ? shape(v, 2) : v);
  }
  return t;
}

const out = { at: new Date().toISOString(), feeds: {} };

for (const [state, url] of Object.entries(TARGETS)) {
  console.log('\n======== ' + state.toUpperCase() + '  ' + url);
  let body, json;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    body = await res.text();
    try { json = JSON.parse(body); }
    catch (e) {
      out.feeds[state] = { url, status: res.status, parseError: e.message, head: body.slice(0, 300) };
      console.log('  not JSON: ' + e.message);
      continue;
    }
    console.log('  HTTP ' + res.status + '   ' + body.length + ' bytes');
  } catch (e) {
    out.feeds[state] = { url, error: e.message };
    console.log('  ERROR ' + e.message);
    continue;
  }

  const topShape = shape(json);
  const arrays = findRecordArrays(json);
  console.log('  top level: ' + topShape);
  console.log('  record arrays found: ' + (arrays.length || 'none'));

  /* GeoJSON keeps everything interesting one level down in `properties`, so
     the keys that matter are not the record's own -- they are its
     properties'. That is precisely where VIC's real alert level is hiding
     while category1 gets read instead. */
  const dumped = arrays.map((a) => {
    const rec = trim(a._first);
    const props = a._first && a._first.properties && typeof a._first.properties === 'object'
      ? trim(a._first.properties) : null;
    console.log('    ' + a.path + '  (' + a.length + ' records)');
    console.log('      record keys: ' + a.keys.join(', '));
    if (props) {
      console.log('      properties:');
      Object.entries(props).forEach(([k, v]) =>
        console.log('        ' + k.padEnd(26) + JSON.stringify(v)));
    } else {
      Object.entries(rec).forEach(([k, v]) =>
        console.log('        ' + k.padEnd(26) + JSON.stringify(v)));
    }
    return { path: a.path, length: a.length, keys: a.keys, firstRecord: rec, firstProperties: props };
  });

  out.feeds[state] = { url, bytes: body.length, topShape, recordArrays: dumped };
}

/* Victoria puts two different kinds of record in one feed and distinguishes
   them with `feedType`. That matters because the same key means different
   things in each: in a warning, category1 is the alert level ("Advice"); in
   an incident it is the event type ("Fire", "Tree Down"). Reading one field
   for both is why the live service reports Earthquake and Building Damage as
   alert levels.

   So dump one of each kind rather than one of the first kind, and the field
   that is safe to use for a title at the same time -- for a warning, `name`
   is the string "Advice" and the place is in `location`, which the title
   hints currently discard in favour of name. */
try {
  const res = await fetch(TARGETS.vic, { headers: { 'User-Agent': UA } });
  const vic = JSON.parse(await res.text());
  const byType = {};
  (vic.features || []).forEach((f) => {
    const p = (f && f.properties) || {};
    const k = String(p.feedType || 'unknown');
    byType[k] = byType[k] || { count: 0, sample: null, category1: new Set(), names: new Set() };
    byType[k].count++;
    if (!byType[k].sample) byType[k].sample = trim(p);
    if (byType[k].category1.size < 10 && p.category1) byType[k].category1.add(String(p.category1));
    if (byType[k].names.size < 6 && p.name) byType[k].names.add(String(p.name).slice(0, 48));
  });
  out.vicByFeedType = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, {
    count: v.count, category1Values: [...v.category1], nameValues: [...v.names], sample: v.sample
  }]));
  console.log('\n======== VIC, split by feedType');
  Object.entries(out.vicByFeedType).forEach(([k, v]) => {
    console.log('  feedType=' + k + '  (' + v.count + ' records)');
    console.log('    category1 values: ' + v.category1Values.join(' | '));
    console.log('    name values:      ' + v.nameValues.join(' | '));
    Object.entries(v.sample).forEach(([kk, vv]) =>
      console.log('      ' + kk.padEnd(22) + JSON.stringify(vv)));
  });
} catch (e) { out.vicByFeedType = { error: e.message }; console.log('VIC split failed: ' + e.message); }

mkdirSync('data', { recursive: true });
writeFileSync('data/shape-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/shape-probe.json');
