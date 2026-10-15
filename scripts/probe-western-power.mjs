/* Why is Western Power showing an outage that started in May?

   Reported from the live dashboard: a Western Power record at NAIRIBIN,
   started 31/05/2026, estimated back 01/06/2026 -- four and a half months
   stale, presented next to today's incidents on a disaster-response board.
   That is worse than showing nothing: a duty officer reading it has no way
   to tell it is not current.

   The query we send is

     .../WP_Outage_Prod/FeatureServer/0/query?where=1%3D1&...&resultRecordCount=400

   Two things in that are suspects and this tells them apart.

   where=1=1 takes every record the layer holds. If the layer retains
   RESOLVED outages rather than only live ones, we are publishing history as
   if it were current.

   resultRecordCount=400 with no orderByFields takes the FIRST 400 in the
   service's default order, which for a feature service is ascending object
   id -- that is, the OLDEST 400. On a layer with more than 400 records that
   would show yesterday's and last May's outages while hiding today's
   entirely. The record count decides whether that is happening.

   So this reports: how many records the layer holds in total, the full
   field list, the oldest and newest start times, how many have a
   restoration time in the past, and whether any field distinguishes an
   active outage from a closed one.

   Run: node scripts/probe-western-power.mjs   (writes data/wp-probe.json)
*/
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)';
const BASE = 'https://services2.arcgis.com/tBLxde4cxSlNUxsM/ArcGIS/rest/services/WP_Outage_Prod/FeatureServer/0';

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported as unparseable */ }
    return { status: res.status, bytes: text.length, json, snippet: text.slice(0, 200) };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

const report = { at: new Date().toISOString(), nowMs: Date.now() };
const fmt = (ms) => (ms === null || ms === undefined || !isFinite(ms)) ? null : new Date(ms).toISOString();

console.log('== the layer itself ==');
const meta = await get(BASE + '?f=json');
if (meta.json) {
  report.layer = {
    name: meta.json.name, maxRecordCount: meta.json.maxRecordCount,
    fields: (meta.json.fields || []).map((f) => f.name + ':' + f.type)
  };
  console.log('  name: ' + meta.json.name + '   maxRecordCount: ' + meta.json.maxRecordCount);
  console.log('  fields: ' + report.layer.fields.join(', '));
} else { report.layer = { error: meta.error || meta.snippet }; console.log('  ERROR'); }

console.log('\n== how many records does it hold ==');
/* The number that decides whether a 400-record page is hiding anything. */
const count = await get(BASE + '/query?where=1%3D1&returnCountOnly=true&f=json');
const total = count.json && (count.json.count !== undefined ? count.json.count : null);
report.totalRecords = total;
console.log('  total records: ' + total);
console.log('  our page size: 400  ->  '
  + (total !== null && total > 400
    ? 'TRUNCATED, and without orderByFields it is the OLDEST 400 that are kept'
    : 'the whole layer fits in one page'));

console.log('\n== what is actually in it ==');
/* Everything, so the age distribution is measured rather than sampled. */
const all = await get(BASE + '/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=2000&f=json');
if (all.json && Array.isArray(all.json.features)) {
  const rows = all.json.features.map((f) => f.attributes || {});
  report.fetched = rows.length;
  const pick = (r, names) => {
    for (const n of names) if (r[n] !== undefined && r[n] !== null) return r[n];
    return null;
  };
  const START = ['OUTAGESTARTTIME', 'OUTAGE_START_TIME', 'STARTTIME', 'START_TIME'];
  const END = ['ESTIMATEDRESTORATIONTIME', 'ESTIMATED_RESTORATION_TIME', 'ETR', 'RESTORATIONTIME'];
  const starts = rows.map((r) => Number(pick(r, START))).filter((n) => isFinite(n) && n > 0);
  const ends = rows.map((r) => Number(pick(r, END))).filter((n) => isFinite(n) && n > 0);
  const now = Date.now();
  const DAY = 86400000;

  report.startRange = { oldest: fmt(Math.min(...starts)), newest: fmt(Math.max(...starts)) };
  console.log('  rows fetched: ' + rows.length);
  console.log('  start times:  oldest ' + report.startRange.oldest + '   newest ' + report.startRange.newest);

  /* The question the screenshot asks: how much of this is history? */
  const buckets = { today: 0, lastWeek: 0, lastMonth: 0, older: 0, noStart: 0 };
  rows.forEach((r) => {
    const s = Number(pick(r, START));
    if (!isFinite(s) || s <= 0) { buckets.noStart++; return; }
    const age = now - s;
    if (age < DAY) buckets.today++;
    else if (age < 7 * DAY) buckets.lastWeek++;
    else if (age < 31 * DAY) buckets.lastMonth++;
    else buckets.older++;
  });
  report.ageBuckets = buckets;
  console.log('  by age:       ' + JSON.stringify(buckets));
  const endedCount = ends.filter((e) => e < now).length;
  report.restorationInPast = endedCount;
  console.log('  restoration time already past: ' + endedCount + ' of ' + ends.length);

  /* Any field that marks a record closed. If one exists, the fix is a where
     clause rather than a date filter, which is both cheaper and the
     operator's own definition of current rather than ours. */
  const flagFields = {};
  Object.keys(rows[0] || {}).forEach((k) => {
    if (!/status|state|active|current|closed|restor|complete|resolved/i.test(k)) return;
    flagFields[k] = [...new Set(rows.map((r) => String(r[k])).slice(0, 400))].slice(0, 12);
  });
  report.statusLikeFields = flagFields;
  console.log('  status-like fields: ' + JSON.stringify(flagFields));

  /* The specific record the user photographed, if it is still being served. */
  const nai = rows.filter((r) => JSON.stringify(r).toUpperCase().includes('NAIRIBIN'));
  report.nairibin = nai.slice(0, 3);
  console.log('  NAIRIBIN records still in the layer: ' + nai.length);
  if (nai.length) {
    const r = nai[0];
    console.log('    start: ' + fmt(Number(pick(r, START))) + '   etr: ' + fmt(Number(pick(r, END))));
    console.log('    ' + JSON.stringify(r).slice(0, 320));
  }

  /* What the first 400 by default order actually are -- the page we take. */
  const firstPage = await get(BASE + '/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=400&f=json');
  if (firstPage.json && Array.isArray(firstPage.json.features)) {
    const fr = firstPage.json.features.map((f) => f.attributes || {});
    const fs2 = fr.map((r) => Number(pick(r, START))).filter((n) => isFinite(n) && n > 0);
    report.ourPage = { rows: fr.length, oldest: fmt(Math.min(...fs2)), newest: fmt(Math.max(...fs2)) };
    console.log('\n  the page WE take (400, default order):');
    console.log('    rows ' + fr.length + '   oldest ' + report.ourPage.oldest
      + '   newest ' + report.ourPage.newest);
  }

  /* Does the service accept an ordered query? If so the fix is one
     parameter. */
  const ordered = await get(BASE + '/query?where=1%3D1&outFields=*&returnGeometry=false'
    + '&orderByFields=' + encodeURIComponent('OUTAGESTARTTIME DESC') + '&resultRecordCount=5&f=json');
  report.orderBySupported = !!(ordered.json && Array.isArray(ordered.json.features) && ordered.json.features.length);
  console.log('\n  orderByFields supported: ' + report.orderBySupported);
  if (report.orderBySupported) {
    const or = ordered.json.features.map((f) => f.attributes || {});
    console.log('    newest five: ' + or.map((r) => fmt(Number(pick(r, START)))).join(', '));
  }
} else {
  report.fetchError = all.error || all.snippet;
  console.log('  ERROR: ' + report.fetchError);
}

console.log('\n================ verdict ================');
if (report.totalRecords !== null && report.totalRecords > 400) {
  console.log('TRUNCATION: the layer holds ' + report.totalRecords
    + ' records and we take 400 in default order -- the oldest.');
}
if (report.ageBuckets && (report.ageBuckets.older || report.ageBuckets.lastMonth)) {
  console.log('HISTORY: ' + (report.ageBuckets.older + report.ageBuckets.lastMonth)
    + ' of ' + report.fetched + ' records started more than a week ago.');
}
if (report.statusLikeFields && Object.keys(report.statusLikeFields).length) {
  console.log('A status-like field exists -- prefer the operator\'s own definition of current.');
}

mkdirSync(new URL('../data', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/wp-probe.json', import.meta.url), JSON.stringify(report, null, 1));
console.log('\nwrote data/wp-probe.json');
