/* Flooded-road reports from each state's road authority, in one shape.

   Asked for: a road flooding tab, organised by severity, with the time
   since each report. Road closures and hazards are published state by
   state; scripts/probe-road-flooding.mjs asked each authority's feed what
   it publishes (15 Nov 2026):

     NSW  Live Traffic NSW flood hazards        open, CC BY   (Transport for NSW)
     SA   Traffic SA road closures and detours  open, CC BY   (Dept for Infrastructure and Transport)
     WA   Main Roads WA road incidents          open, CC BY 4.0
     NT   Road Report NT obstructions           open
     QLD  QLDTraffic events                     CC BY 4.0, needs an API key
     VIC  Unplanned road disruptions            CC BY 4.0, needs an API key -- not read yet
     TAS, ACT                                   no flooded-road feed found

   A report is only taken where the AUTHORITY says it is flooding -- its own
   flood category, or the word in its own description. Roadworks on a
   "Flood Rd", or repairs after a flood, are not flooding.

   Severity is the authority's stated effect on the road, in three levels
   the page orders by:
     closed      the road is closed or impassable
     restricted  open to some traffic only: 4WD, high clearance, lanes closed
     caution     flooding or water over the road reported; open with caution,
                 or no closure stated
   Nothing is inferred beyond the authority's words: a flood report that
   states no closure is "caution", not "closed".

   Pure functions; fetching is scripts/capture-roads.mjs. */

export const SEVERITIES = ['closed', 'restricted', 'caution'];
/* "Flood", "flooded", "flooding", "floodwater" -- but not a floodway, a
   floodplain or Flood Road, which are places. Main Roads WA's feed has
   debris "at Coongan River Floodway"; Traffic SA has roadworks beside
   "Flood Rd". */
const FLOOD = /\bflood(ed|ing|s|waters?)?\b(?!\s+(rd|road|st|street|ave|avenue|lane|dr|drive|hwy|highway)\b)|water over|water on (the )?road|water across|inundat|washed? ?out|washout|washaway/i;

const text = (s) => String(s == null ? '' : s).replace(/<\/(p|div|li|br)>|<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
/* Traffic SA writes names in capitals. */
const title = (s) => text(s).toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/* The authority's words as a severity. Closed wins over restricted wins
   over caution, because a report covering several sections is as bad as
   its worst one. "Open" before "closed" does not undo it. */
export function severityFrom(...parts) {
  const t = parts.map(text).join(' | ').toLowerCase();
  /* A closed lane is a restriction, not a closed road. */
  const road = t.replace(/\blanes? (is |are )?closed\b|\blane closures?\b/g, ' ');
  if (/\bclosed\b|\bclosure\b|impassable|no access/.test(road)) return 'closed';
  if (/4wd|four wheel drive|high clearance|heavy vehicles? only|lanes? (closed|blocked|affected)|restrict|specified conditions|detour|single lane|contraflow/.test(t)) return 'restricted';
  return 'caution';
}

const round = (x) => Math.round(x * 1e4) / 1e4;
const point = (lat, lon) => (isFinite(lat) && isFinite(lon) && lat < -9 && lat > -45 && lon > 110 && lon < 160 ? [round(lat), round(lon)] : undefined);

/* "15/11/2026 09:45:16" (WA) or "2018-06-20 08:30:00" (NT), written in the
   authority's local time with no zone: read at the state's standard
   offset. Neither state has daylight saving. */
export function localTime(s, offsetH) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
  let y, mo, d, h, mi, se;
  if (m) [, d, mo, y, h, mi, se] = m;
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
    if (!m) return undefined;
    [, y, mo, d, h, mi, se] = m;
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)) - offsetH * 3600e3;
  return isFinite(ms) ? ms : undefined;
}

/* ---- NSW: Live Traffic NSW flood hazards (GeoJSON FeatureCollection) ---- */
export function parseNsw(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    const p = f.properties || {};
    if (p.ended) continue;
    const cat = String(p.mainCategory || p.displayName || '');
    if (!/flood/i.test(cat)) continue;
    const r = (p.roads || [])[0] || {};
    const where = [r.suburb, r.crossStreet && (r.locationQualifier || 'at') + ' ' + r.crossStreet,
      r.secondLocation && 'and ' + r.secondLocation].filter(Boolean).map(text).join(' ');
    const detail = [p.headline, p.otherAdvice, [p.adviceA, p.adviceB, p.adviceC].map(text).filter(Boolean).join('. ')].map(text).filter(Boolean);
    const c = (f.geometry && f.geometry.coordinates) || [];
    /* Each road carries what is affected ("extent": "Closed", "description":
       "Road closed"); read as words, whatever the field is called. */
    const lanes = (p.roads || []).flatMap((x) => (Array.isArray(x.impactedLanes) ? x.impactedLanes : []))
      .flatMap((l) => Object.entries(l || {}).filter(([k, v]) => typeof v === 'string' && !/direction|roadtype/i.test(k)).map(([, v]) => v)).join(' ');
    out.push({
      id: 'nsw-' + (f.id ?? p.id ?? out.length), state: 'NSW',
      road: text(r.mainStreet) || 'Road not named', where: where || undefined, region: text(r.region) || undefined,
      /* The advice lines ("Avoid the area") are standing safety advice, not
         a statement that the road is shut; only the report's own text is
         read for severity. */
      severity: severityFrom(p.headline, p.otherAdvice, p.subCategoryA === 'null' ? '' : p.subCategoryA, p.subCategoryB, lanes),
      kind: 'Flooding', detail: clip(detail.join(' — '), 420) || undefined,
      reportedAt: isFinite(p.created) ? p.created : undefined,
      updatedAt: isFinite(p.lastUpdated) ? p.lastUpdated : undefined,
      at: point(c[1], c[0])
    });
  }
  return out;
}

/* ---- SA: Traffic SA road closures and detours (ArcGIS JSON) ---- */
export function parseSa(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    const a = f.attributes || {};
    const details = text(a.PLOT_DETAILS || a.DESCRIPTION);
    if (!FLOOD.test(details)) continue;
    if (a.END_DATE && a.END_DATE < Date.now()) continue;
    const g = f.geometry || {};
    const first = g.paths ? (g.paths[0] || [])[0] : (isFinite(g.x) ? [g.x, g.y] : null);
    const between = [a.START_SIDE_STREET_NAME1 || a.SIDE_STREET, a.END_SIDE_STREET_NAME1].filter(Boolean).map(title);
    const suburbs = [...new Set([a.START_SUBURB || a.SUBURB, a.END_SUBURB].filter(Boolean).map(title))];
    out.push({
      id: 'sa-' + (a.LOCATION_ID ?? a.ROADWORKS_AND_INCIDENTS_ID ?? out.length), state: 'SA',
      road: title(a.LOCAL_ROAD_NAME || a.LOCAL_ROAD) || 'Road not named',
      where: [suburbs.join(' to '), between.length ? 'between ' + between.join(' and ') : ''].filter(Boolean).join(', ') || undefined,
      severity: /RD_CLOSURE/i.test(a.PLOT_TYPE || '') ? 'closed' : severityFrom(details, a.PLOT_TYPE, a.NO_LANES_CLOSED),
      kind: 'Flooding', detail: clip(details.replace(/\s*Ref# ?\d+\s*$/i, ''), 420) || undefined,
      reportedAt: isFinite(a.START_DATE) ? a.START_DATE : undefined,
      at: first ? point(first[1], first[0]) : point(a.LATITUDE, a.LONGITUDE)
    });
  }
  return out;
}

/* ---- WA: Main Roads WA road incidents (ArcGIS JSON) ---- */
export function parseWa(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    const a = f.attributes || {};
    if (!/flood/i.test(a.IncidentTy || '') && !FLOOD.test(a.Location || '')) continue;
    const g = f.geometry || {};
    out.push({
      id: 'wa-' + (a.Id ?? a.FID ?? out.length), state: 'WA',
      road: text(a.Road || a.LocalRoadName) || 'Road not named',
      where: text(a.Suburb) || undefined, region: text(a.Region) || undefined,
      severity: severityFrom(a.ClosureTyp),
      kind: text(a.IncidentTy) || 'Flooding',
      detail: clip([a.Location, a.TrafficImp].map(text).filter(Boolean).join(' — '), 420) || undefined,
      reportedAt: localTime(a.EntryDate, 8), updatedAt: localTime(a.UpdateDate, 8),
      at: point(g.y, g.x), url: text(a.SeeMoreUrl) || undefined
    });
  }
  return out;
}

/* ---- NT: Road Report NT obstructions ({response: [...]}) ---- */
export function parseNt(json) {
  const out = [];
  for (const o of (json && json.response) || []) {
    if (o.status && !/current/i.test(o.status)) continue;
    const words = [o.obstructionType, o.comment].map(text).join(' ');
    if (!FLOOD.test(words)) continue;
    /* "At Adelaide River Floodplain" is a place, not a flood: the type or
       the comment has to say it, not the location. */
    out.push({
      id: 'nt-' + (o.obstructionId ?? o.recordId ?? out.length), state: 'NT',
      road: text(o.roadName) || 'Road not named', where: text(o.locationComment) || undefined,
      severity: severityFrom(o.restrictionType),
      kind: clip(text(o.obstructionType), 60) || 'Flooding',
      detail: clip([o.restrictionType, o.comment].map(text).filter(Boolean).join(' — '), 420) || undefined,
      reportedAt: localTime(o.dateFrom || o.dateActive, 9.5), updatedAt: localTime(o.dateLastUpdated, 9.5)
    });
  }
  return out;
}

/* ---- QLD: QLDTraffic v2 events (GeoJSON), event_type "Flooding" ----
   Written from TMR's published API specification; no key was available to
   read a live response when this was written, so the first capture with a
   key should be checked against it. */
export function parseQld(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    const p = f.properties || {};
    if (!/flood/i.test(p.event_type || '') && !/flood/i.test(p.event_subtype || '')) continue;
    if (p.status && /closed|ended|archived/i.test(p.status)) continue;
    const rs = Array.isArray(p.road_summary) ? p.road_summary[0] || {} : p.road_summary || {};
    const im = p.impact || {};
    const d = p.duration || {};
    let c = f.geometry && f.geometry.coordinates;
    if (f.geometry && f.geometry.type === 'GeometryCollection') c = ((f.geometry.geometries || []).find((g) => g.type === 'Point') || {}).coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    out.push({
      id: 'qld-' + (p.id ?? out.length), state: 'QLD',
      road: text(rs.road_name) || 'Road not named',
      where: [rs.locality, im.towards && 'towards ' + im.towards].filter(Boolean).map(text).join(', ') || undefined,
      region: text(rs.local_government_area || rs.district) || undefined,
      severity: severityFrom(im.impact_type, im.impact_subtype),
      kind: text(p.event_subtype) || 'Flooding',
      detail: clip([p.description, p.advice, p.information].map(text).filter(Boolean).join(' — '), 420) || undefined,
      reportedAt: Date.parse(d.start || p.published || '') || undefined,
      updatedAt: Date.parse(p.last_updated || '') || undefined,
      at: Array.isArray(c) ? point(c[1], c[0]) : undefined, url: text(p.url) || undefined
    });
  }
  return out;
}

export const ROAD_SOURCES = [
  { state: 'NSW', name: 'Live Traffic NSW', owner: 'Transport for NSW', site: 'https://www.livetraffic.com/',
    url: 'https://www.livetraffic.com/traffic/hazards/flood-open.json', list: 'features', parse: parseNsw },
  { state: 'QLD', name: 'QLDTraffic', owner: 'Queensland Department of Transport and Main Roads', site: 'https://qldtraffic.qld.gov.au/',
    url: 'https://api.qldtraffic.qld.gov.au/v2/events', keyEnv: 'QLDTRAFFIC_API_KEY', keyParam: 'apikey', list: 'features', parse: parseQld },
  { state: 'SA', name: 'Traffic SA', owner: 'SA Department for Infrastructure and Transport', site: 'https://www.traffic.sa.gov.au/',
    url: 'https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=json', list: 'features', parse: parseSa },
  { state: 'WA', name: 'Main Roads WA', owner: 'Main Roads Western Australia', site: 'https://travelmap.mainroads.wa.gov.au/Home/Map',
    url: 'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadIncidents/FeatureServer/1/query?where=1%3D1&outFields=*&outSR=4326&f=json', list: 'features', parse: parseWa },
  { state: 'NT', name: 'Road Report NT', owner: 'Northern Territory Government', site: 'https://roadreport.nt.gov.au/',
    url: 'https://roadreport.nt.gov.au/api/Obstruction/GetAll', list: 'response', parse: parseNt }
];
/* States with no feed this reads, and why -- shown in the tab, so an
   empty list for them is never read as "no flooded roads". */
export const ROAD_GAPS = [
  { state: 'VIC', why: 'Victoria publishes road disruptions only through an API key; not connected yet', site: 'https://traffic.transport.vic.gov.au/' },
  { state: 'TAS', why: 'no flooded-road feed found', site: 'https://alert.tas.gov.au/' },
  { state: 'ACT', why: 'no flooded-road feed found', site: 'https://www.cityservices.act.gov.au/roads-and-paths/traffic/road_closures' }
];

/* One snapshot from each source's result: `results[state]` is
   {json} | {error} | {needsKey: true}. A source that failed is reported
   as failed, never as zero flooded roads. */
export function buildRoadSnapshot(results, now) {
  const sources = [];
  let reports = [];
  for (const s of ROAD_SOURCES) {
    const r = results[s.state] || { error: 'not fetched' };
    const row = { state: s.state, name: s.name, owner: s.owner, site: s.site };
    if (r.needsKey) { row.ok = false; row.needsKey = true; }
    else if (r.error) { row.ok = false; row.error = String(r.error).slice(0, 160); }
    else {
      try {
        /* The envelope first: an error page or a changed shape parses to
           nothing, and nothing would read as "no flooded roads". */
        const recs = r.json && r.json[s.list];
        if (!Array.isArray(recs)) throw new Error('unrecognised response' + (r.json && r.json.error ? ': ' + JSON.stringify(r.json.error).slice(0, 80) : ''));
        row.read = recs.length;
        const list = s.parse(r.json);
        list.forEach((x) => { if (!x.url) x.url = s.site; x.source = s.name; });
        row.ok = true; row.count = list.length;
        reports = reports.concat(list);
      } catch (e) { row.ok = false; row.error = 'could not be read: ' + String(e.message).slice(0, 120); }
    }
    sources.push(row);
  }
  const rank = (x) => SEVERITIES.indexOf(x.severity);
  /* Worst first; within a level, the newest report first. */
  reports.sort((a, b) => rank(a) - rank(b) || (b.reportedAt || 0) - (a.reportedAt || 0));
  const counts = { closed: 0, restricted: 0, caution: 0, total: reports.length };
  reports.forEach((x) => { counts[x.severity]++; });
  return { capturedAt: now, counts, sources, gaps: ROAD_GAPS, reports };
}
