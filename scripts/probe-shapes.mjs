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
      out.push({ path, length: node.length, keys: Object.keys(node[0]) });
    }
    if (node.length) findRecordArrays(node[0], path + '[0]', out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) findRecordArrays(v, path + '.' + k, out, depth + 1);
  return out;
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
  arrays.forEach((a) => {
    console.log('    ' + a.path + '  (' + a.length + ' records)');
    console.log('      keys: ' + a.keys.join(', '));
  });

  /* One whole record, verbatim but trimmed. The field names are the point;
     long HTML bodies are not, so they are cut rather than removed -- seeing
     that a field holds a paragraph of markup is itself information. */
  const first = arrays.length
    ? arrays[0].path.split(/[.\[]/).filter(Boolean).reduce((acc, k) => {
        if (k === '0]' || k === '0') return Array.isArray(acc) ? acc[0] : acc;
        return acc && acc[k.replace(']', '')];
      }, json)
    : json;
  const sample = Array.isArray(first) ? first[0] : first;
  const trimmed = {};
  if (sample && typeof sample === 'object') {
    for (const [k, v] of Object.entries(sample)) {
      trimmed[k] = typeof v === 'string' && v.length > 180 ? v.slice(0, 180) + '…[' + v.length + ']'
        : (v && typeof v === 'object' ? shape(v) : v);
    }
  }
  console.log('  first record:');
  console.log(Object.entries(trimmed).map(([k, v]) =>
    '      ' + k.padEnd(26) + JSON.stringify(v)).join('\n'));

  out.feeds[state] = { url, bytes: body.length, topShape, recordArrays: arrays, firstRecord: trimmed };
}

mkdirSync('data', { recursive: true });
writeFileSync('data/shape-probe.json', JSON.stringify(out, null, 2));
console.log('\nwrote data/shape-probe.json');
