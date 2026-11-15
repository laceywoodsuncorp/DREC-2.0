/* Flooded-road reports from the state road authorities.

   Fixtures in test/fixtures/roads/ are real records kept by
   scripts/probe-road-flooding.mjs on 15 Nov 2026 (each file's _note says
   what, if anything, is not verbatim).

   What must hold: a report is taken only where the authority says it is
   flooding -- not a floodway, a floodplain or Flood Road; severity is the
   authority's stated effect and nothing more; times are read in the
   authority's own zone; a feed that failed or needs a key is reported as
   that, never as "no flooded roads".

   Run: node test/road_floods.test.mjs */
import { readFileSync } from 'node:fs';
import { parseNsw, parseSa, parseWa, parseNt, parseQld, severityFrom, localTime, buildRoadSnapshot,
  ROAD_SOURCES, SEVERITIES } from '../scripts/lib/road-floods.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL('./fixtures/roads/' + f, import.meta.url), 'utf8'));
let pass = 0, fail = 0;
const ck = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); }
};

console.log('== severity is the authority\'s words ==');
{
  ck('"Road closed" is closed', severityFrom('Road closed') === 'closed');
  ck('"Impassable" is closed', severityFrom('Impassable') === 'closed');
  ck('"Road open with caution" is caution', severityFrom('Road open with caution') === 'caution');
  ck('"Road open with specified conditions" is restricted', severityFrom('Road open with specified conditions') === 'restricted');
  ck('4WD only is restricted', severityFrom('this road is open to 4WD vehicles only') === 'restricted');
  ck('a closed lane is a restriction, not a closed road', severityFrom('Left lane closed') === 'restricted');
  ck('the worst section decides', severityFrom('<p>Cobham to Calindary is open with caution.</p><p>Calindary to Shire Boundary is closed.</p>') === 'closed');
  ck('no stated effect is caution, not closed', severityFrom('', null, undefined) === 'caution');
  ck('the order is closed, restricted, caution', SEVERITIES.join() === 'closed,restricted,caution');
}

console.log('\n== times in the authority\'s zone ==');
{
  ck('WA day-first, at UTC+8', new Date(localTime('15/11/2026 09:45:16', 8)).toISOString() === '2026-11-15T01:45:16.000Z');
  ck('NT year-first, at UTC+9:30', new Date(localTime('2026-11-14 16:20:00', 9.5)).toISOString() === '2026-11-14T06:50:00.000Z');
  ck('nonsense is no time', localTime('soon', 8) === undefined);
}

console.log('\n== NSW: Live Traffic NSW flood hazards ==');
{
  const r = parseNsw(fx('nsw.json'));
  ck('each flood hazard is a report', r.length === 3, r.length);
  ck('with its road and where', r[0].road === 'Corona Rd/Joulnie Rd' && /Teilta to Westwood Downs/.test(r[0].where), r[0]);
  ck('"between" two cross streets is kept', /between Borona Downs Road and Joulnie Road/.test(r[1].where), r[1].where);
  ck('when it was reported and last updated', r[0].reportedAt === 1786279567000 && r[0].updatedAt === 1793544502643, [r[0].reportedAt, r[0].updatedAt]);
  ck('a hazard stating a closed section is closed', r[2].severity === 'closed', r[2]);
  /* "Avoid the area" is standing advice on every flood hazard. On its own
     it does not say the road is shut. */
  ck('one stating no closure is caution, whatever the standing advice', r[0].severity === 'caution', r[0].severity);
  ck('the detail is text, not markup', r[2].detail && !/<|&nbsp;/.test(r[2].detail), r[2].detail);
  /* The affected-lanes detail, where the feed carries it. */
  const closed = parseNsw({ features: [{ id: 1, geometry: { type: 'Point', coordinates: [150, -33] }, properties: { mainCategory: 'FLOODING', ended: false,
    created: 1, roads: [{ mainStreet: 'Test Rd', suburb: 'Somewhere', impactedLanes: [{ affectedDirection: 'Both directions', extent: 'Closed', description: 'Road closed' }] }] } }] });
  ck('the lanes detail saying the road is closed makes it closed', closed[0].severity === 'closed', closed[0]);
  const fourWd = parseNsw({ features: [{ id: 2, properties: { mainCategory: 'FLOODING', ended: false,
    otherAdvice: '<p>Due to recent rainfall, this road is open to 4WD vehicles only.</p>',
    roads: [{ mainStreet: 'Hewart Downs Road', impactedLanes: [{ extent: 'Closed', description: 'Road closed' }] }] } }] });
  ck('but the report\'s own words win: "open to 4WD only" is restricted', fourWd[0].severity === 'restricted', fourWd[0].severity);
  ck('and its point is kept, lat first', closed[0].at[0] === -33 && closed[0].at[1] === 150, closed[0].at);
  ck('an ended hazard is not current', parseNsw({ features: [{ properties: { mainCategory: 'FLOODING', ended: true, roads: [] } }] }).length === 0);
  ck('a non-flood hazard is not flooding', parseNsw({ features: [{ properties: { mainCategory: 'CRASH', otherAdvice: 'Oxley Highway flood recovery', roads: [] } }] }).length === 0);
}

console.log('\n== SA: Traffic SA closures ==');
{
  const r = parseSa(fx('sa.json'));
  ck('closures the authority says are for flooding are reports', r.length === 3, r.length);
  ck('a road closure is closed', r.every((x) => x.severity === 'closed'), r.map((x) => x.severity));
  ck('capitals are tidied', r[0].road === 'Morgan Vale Road' && /Pine Valley Station to Canegrass/.test(r[0].where), r[0]);
  ck('the reference number is not part of the detail', !/Ref#/.test(r[0].detail), r[0].detail);
  ck('reported when the closure started', r[0].reportedAt === 1772597700000);
  ck('roadworks beside "Flood Rd" are not flooding', parseSa({ features: [{ attributes: { PLOT_TYPE: 'RD_CLOSURE',
    PLOT_DETAILS: 'Asphalt works near Flood Rd', LOCAL_ROAD_NAME: 'RIDLEY ROAD' } }] }).length === 0);
}

console.log('\n== WA: Main Roads WA incidents ==');
{
  const r = parseWa(fx('wa.json'));
  ck('the Flooding incident is a report', r.length === 1 && r[0].road === 'Great Northern Hwy', r);
  ck('debris at a floodway is not flooding', !r.some((x) => /Marble Bar/.test(x.road)), r.map((x) => x.road));
  /* TrafficCon reads "Road Closure" on a road that is open with caution;
     only ClosureTyp states the effect. */
  ck('"Road open with caution" is caution, whatever the category field says', r[0].severity === 'caution', r[0].severity);
  ck('reported in Perth time', new Date(r[0].reportedAt).toISOString() === '2026-11-15T01:45:16.000Z', r[0].reportedAt);
  ck('with what the authority advises', /Water Over Road/.test(r[0].detail) && /Extreme Caution/.test(r[0].detail), r[0].detail);
}

console.log('\n== NT: Road Report NT obstructions ==');
{
  const r = parseNt(fx('nt.json'));
  ck('only the obstruction that says flooding is a report', r.length === 1 && r[0].road === 'Daly River Road', r.map((x) => x.road));
  ck('roadworks at a floodplain are not flooding', !r.some((x) => /Arnhem/.test(x.road)));
  ck('"Road Closed" is closed', r[0].severity === 'closed');
  ck('a "-" comment is not shown as detail', parseNt({ response: [{ status: 'CURRENT', obstructionType: 'Flooding', restrictionType: 'Impassable',
    comment: '-', roadName: 'Kintore Road' }] })[0].detail === 'Impassable');
  ck('reported in Darwin time', new Date(r[0].reportedAt).toISOString() === '2026-11-14T06:50:00.000Z', r[0].reportedAt);
}

console.log('\n== QLD: QLDTraffic events, from the published specification ==');
{
  const r = parseQld({ features: [
    { geometry: { type: 'Point', coordinates: [152.99, -27.72] }, properties: { id: 71, status: 'Published', event_type: 'Flooding', event_subtype: 'Water over road',
      impact: { impact_type: 'Closures', impact_subtype: 'Road closed', towards: 'Logan Village' }, duration: { start: '2026-11-15T03:10:00+10:00' },
      description: 'Road closed due to flooding', advice: 'Use an alternative route', last_updated: '2026-11-15T05:00:00+10:00',
      road_summary: { road_name: 'Miller Road', locality: 'Chambers Flat', local_government_area: 'Logan City' } } },
    { geometry: { type: 'Point', coordinates: [153, -27.5] }, properties: { id: 72, event_type: 'Roadworks', road_summary: { road_name: 'Floodway Rd' } } }
  ] });
  ck('a Flooding event is a report; roadworks are not', r.length === 1 && r[0].road === 'Miller Road', r);
  ck('closures are closed', r[0].severity === 'closed');
  ck('times with an offset are read as written', new Date(r[0].reportedAt).toISOString() === '2026-11-14T17:10:00.000Z', r[0].reportedAt);
}

console.log('\n== the snapshot ==');
{
  const results = { NSW: { json: fx('nsw.json') }, SA: { json: fx('sa.json') }, WA: { json: fx('wa.json') },
    NT: { error: 'HTTP 503' }, QLD: { needsKey: true } };
  const s = buildRoadSnapshot(results, 1794700000000);
  ck('reports from every source that answered', s.reports.length === 7 && s.counts.total === 7, s.counts);
  const order = s.reports.map((x) => SEVERITIES.indexOf(x.severity));
  ck('worst first', order.every((v, i) => i === 0 || v >= order[i - 1]), order);
  const closed = s.reports.filter((x) => x.severity === 'closed').map((x) => x.reportedAt);
  ck('and within a level, the newest report first', closed.every((v, i) => i === 0 || v <= closed[i - 1]), closed);
  ck('the counts add up', s.counts.closed + s.counts.restricted + s.counts.caution === 7, s.counts);
  ck('every report names its source and links to it', s.reports.every((x) => x.source && /^https:\/\//.test(x.url)), s.reports.find((x) => !x.url));
  const nt = s.sources.find((x) => x.state === 'NT'), qld = s.sources.find((x) => x.state === 'QLD');
  ck('a feed that failed is reported as failed', nt.ok === false && /503/.test(nt.error), nt);
  ck('a feed that needs a key is reported as needing one', qld.ok === false && qld.needsKey === true, qld);
  ck('states with no feed are listed with why', s.gaps.some((g) => g.state === 'VIC') && s.gaps.every((g) => g.why && g.site));
  ck('a feed whose shape cannot be read is a failure, not zero roads',
    buildRoadSnapshot({ NSW: { json: { features: 'nope' } } }, 1).sources.find((x) => x.state === 'NSW').ok === false);
  ck('no key ever appears in the source list', !JSON.stringify(ROAD_SOURCES).match(/[0-9a-f]{32}/i));
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
