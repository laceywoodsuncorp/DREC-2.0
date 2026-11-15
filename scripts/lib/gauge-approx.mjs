/* Approximate positions for river gauges that no published file locates.

   BOM's site files place about half the gauges in its river tables, by
   station number. No published source keyed by station number has the
   rest -- BOM's current station lists, its other spatial tables and
   Queensland's flood-gauge layers were all measured
   (scripts/probe-gauge-sources.mjs) -- and they include most gauges that
   flood: council and agency ALERT gauges. Reported from the dashboard:
   gauges in flood missing from the map.

   So those gauges are placed approximately, in two ways, and always
   marked as approximate so the page can draw and describe them
   differently from the exact ones:

     't'  from the town in the gauge's name ("Blackfellow Creek at
          Junction View" -> the locality Junction View). An earlier audit
          showed that matching names to towns alone goes wrong -- "Coffs
          Creek at Gundagai Street" is not in Gundagai -- so a match
          counts only if it lands near an exactly-placed gauge in the same
          catchment, and street addresses are never matched at all.
     'n'  from its neighbours in BOM's table, which lists a catchment's
          gauges roughly in order along the river: between the placed
          gauges either side of it, when both are close by.

   Accuracy, measured by hiding half the exactly-placed gauges and placing
   them these ways instead (15 Nov 2026): 't' is typically 3 km out, nine
   in ten within 11 km; 'n' typically 7-16 km, nine in ten within 46 km.
   A gauge neither way can place stays off the map and is said to be. */

const KM_PER_DEG = 111;
export const km = (a, b) => Math.hypot((a[0] - b[0]) * KM_PER_DEG,
  (a[1] - b[1]) * KM_PER_DEG * Math.cos(a[0] * Math.PI / 180));

/* A town match must land this close to an exactly-placed gauge of the
   same catchment (or, where the catchment has none, of the same table). */
export const TOWN_MAX_KM_CATCHMENT = 40;
export const TOWN_MAX_KM_TABLE = 60;
/* A gauge is placed between its neighbours only when there is a placed
   gauge on BOTH sides of it and they are this close together. Measured by
   hiding half the exactly-placed gauges and placing them this way: with
   neighbours within 60 km the typical error is 7-16 km (nine in ten within
   46 km); with only one neighbour, or neighbours further apart, it was
   typically 41 km and often over 100 -- so those are left unplaced. */
export const NEIGHBOUR_SPAN_MAX_KM = 60;

const STREET = /\b(street|st|road|rd|avenue|ave|drive|dr|highway|hwy|lane|ln|parade|pde|terrace|tce|court|ct|boulevard|bvd|esplanade|way)\b\.?$/i;
const QUALIFIER = /\b(alert|tm|hg|hw|tw|ds|us|d\/s|u\/s|drdmw|wwtp|stn|no\.?\s*\d+)\b/gi;
const FEATURE = /\s+(bridge|weir|dam|crossing|station|pump|lagoon|junction|gorge|falls|causeway|park|reserve|boat ramp|wharf|jetty|confluence|homestead|township|town|village|school|airport|basin|barrage|lock|gauge|offtake|regulator|storage|reservoir|lake|creek|river|rail bridge|railway bridge|road bridge|footbridge)\b.*$/i;

/* The place names a gauge's name might hold, most specific first. Empty
   for a street address. */
export function placeCandidates(name) {
  let n = String(name || '').replace(/\s*\([^)]*\)/g, ' ').replace(QUALIFIER, ' ').replace(/\s+/g, ' ').trim();
  const m = /\b(?:at|near|above|below|upstream of|downstream of|upstream|downstream)\s+(.+)$/i.exec(n);
  let tail = (m ? m[1] : n).trim();
  if (!tail || STREET.test(tail)) return [];
  const out = [];
  const add = (t) => {
    const k = t.replace(/\bMt\b\.?/gi, 'Mount').replace(/\s+/g, ' ').trim().toUpperCase();
    if (k.length > 2 && !out.includes(k)) out.push(k);
  };
  add(tail);
  const bare = tail.replace(FEATURE, '');
  if (bare !== tail) add(bare);
  for (const t of [tail, bare]) {
    const d = t.replace(/^(upper|lower|north|south|east|west|old|new)\s+/i, '');
    if (d !== t) add(d);
  }
  return out;
}

/* name (upper case) -> [[lat, lon], ...] from the gazetteer's items. */
export function gazetteerIndex(items) {
  const idx = new Map();
  for (const [name, , lat, lon] of items || []) {
    const k = String(name).toUpperCase();
    (idx.get(k) || idx.set(k, []).get(k)).push([lat, lon]);
  }
  return idx;
}

const nearest = (pt, pts) => pts.reduce((best, p) => { const d = km(pt, p); return d < best ? d : best; }, Infinity);

/* Where the town in a gauge's name is, if it is near the catchment's
   exactly-placed gauges. `catchRefs` and `tableRefs` are [lat, lon] lists. */
export function townPosition(name, gaz, catchRefs, tableRefs) {
  const refs = catchRefs.length ? catchRefs : tableRefs;
  const limit = catchRefs.length ? TOWN_MAX_KM_CATCHMENT : TOWN_MAX_KM_TABLE;
  if (!refs.length) return null;
  for (const cand of placeCandidates(name)) {
    let best = null, bestD = Infinity;
    for (const p of gaz.get(cand) || []) {
      const d = nearest(p, refs);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (best && bestD <= limit) return best;
  }
  return null;
}

/* Between the placed gauges either side of index i in a catchment's
   table order. `at(j)` gives a placed gauge's [lat, lon] or null. */
export function neighbourPosition(i, count, at) {
  let a = -1, b = -1;
  for (let j = i - 1; j >= 0; j--) if (at(j)) { a = j; break; }
  for (let j = i + 1; j < count; j++) if (at(j)) { b = j; break; }
  if (a < 0 || b < 0) return null;
  const pa = at(a), pb = at(b);
  if (km(pa, pb) > NEIGHBOUR_SPAN_MAX_KM) return null;
  const f = (i - a) / (b - a);
  return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
}

const round = (x) => Math.round(x * 1e4) / 1e4;

/* Fills in `at` and `approx` on every gauge in `groups` that has neither.
   Exact positions are never touched. Returns how many of each kind. */
export function placeApproximately(groups, gazItems) {
  const gaz = gazetteerIndex(gazItems);
  const exactByProduct = new Map();
  for (const g of groups) {
    const list = exactByProduct.get(g.product) || exactByProduct.set(g.product, []).get(g.product);
    for (const s of g.stations) if (s.at && !s.approx) list.push(s.at);
  }
  let town = 0, neighbour = 0, none = 0;
  for (const g of groups) {
    const exact = g.stations.filter((s) => s.at && !s.approx).map((s) => s.at);
    for (const s of g.stations) {
      if (s.at) continue;
      const p = townPosition(s.name, gaz, exact, exactByProduct.get(g.product) || []);
      if (p) { s.at = [round(p[0]), round(p[1])]; s.approx = 't'; town++; }
    }
    /* Neighbours second, so a gauge placed from its town can anchor the
       gauges beside it. */
    const anchor = g.stations.map((s) => (s.at ? s.at : null));
    g.stations.forEach((s, i) => {
      if (s.at) return;
      const p = neighbourPosition(i, g.stations.length, (j) => anchor[j]);
      if (p) { s.at = [round(p[0]), round(p[1])]; s.approx = 'n'; neighbour++; } else none++;
    });
  }
  return { town, neighbour, none };
}
