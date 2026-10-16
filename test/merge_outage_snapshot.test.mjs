/* How the two outage captures are merged into the snapshot the Worker serves.

   Measured on 16 October, operator by operator: the five operators with a
   verified data feed (Endeavour, Energex, Ergon, Western Power, Evoenergy)
   were read by the Worker's code and not at all by the browser -- which is
   why the snapshot had nothing for QLD, WA or ACT. Where the browser did
   succeed, the feed got the identical count. The browser's unique
   contribution is a published total for operators that block their list.

   The rules that follow from that, and the ways each could go wrong:
     - the feed is the authority when it answers, including when it says 0
     - browser rows fill a gap only from the SAME run; earlier ones are hours
       old and would show restored suburbs as still dark
     - a previous capture may stand in for a failed feed only briefly
     - published totals age out, and are never re-stamped as new

   Run: node test/merge_outage_snapshot.test.mjs */
import { mergeOutageSnapshot, PREVIOUS_ROWS_MAX_AGE_MS, REPORTED_MAX_AGE_MS }
  from '../scripts/lib/merge-outage-snapshot.mjs';

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const NOW = Date.UTC(2026, 9, 16, 4, 0);
const H = 3600000;
const net = (name, ok, count, extra) => Object.assign({ name, ok, count }, extra || {});
const row = (network, location, customers, kind) => ({ network, location, customers, kind: kind || 'unplanned' });
const findNet = (snap, st, name) => snap.states[st].networks.find((n) => n.name === name);

console.log('== the case that was broken: feed reads it, browser cannot ==');
{
  const feed = { wa: { name: 'Western Australia',
    networks: [net('Western Power', true, 2), net('Horizon Power', false, 0, { error: 'blocked', blocked: true })],
    outages: [row('Western Power', 'Harvey', 6), row('Western Power', 'Bunbury', 9)] } };
  const browser = { wa: { networks: [net('Western Power', false, 0, { error: 'no list in page' }),
    net('Horizon Power', false, 0, { blocked: true })], outages: [] } };
  const { snapshot } = mergeOutageSnapshot(feed, browser, null, { now: NOW, browserCapturedAt: NOW - 60000 });
  const wp = findNet(snapshot, 'wa', 'Western Power');
  ck('Western Power is read', wp.ok && wp.count === 2, wp);
  ck('from the feed', wp.source === 'feed', wp.source);
  ck('its rows are in the snapshot', snapshot.states.wa.outages.length === 2, snapshot.states.wa.outages);
  ck('each row names its network', snapshot.states.wa.outages.every((o) => o.network === 'Western Power'));
  ck('the state totals add up', snapshot.states.wa.customers === 15 && snapshot.states.wa.unplannedCount === 2,
    snapshot.states.wa);
  const hz = findNet(snapshot, 'wa', 'Horizon Power');
  ck('an operator nobody can read is reported, not dropped', hz && !hz.ok && hz.blocked, hz);
}

console.log('\n== the feed is the authority, including when it says zero ==');
{
  /* The browser read 24 Ausgrid outages this morning; the feed, now, reads
     7. Taking "whichever read more" would keep seventeen restored outages
     on the map. */
  const feed = { nsw: { networks: [net('Ausgrid', true, 7)],
    outages: Array.from({ length: 7 }, (_, i) => row('Ausgrid', 'F' + i, 1)) } };
  const browser = { nsw: { networks: [net('Ausgrid', true, 24)],
    outages: Array.from({ length: 24 }, (_, i) => row('Ausgrid', 'B' + i, 1)) } };
  const { snapshot } = mergeOutageSnapshot(feed, browser, null, { now: NOW, browserCapturedAt: NOW - 60000 });
  const a = findNet(snapshot, 'nsw', 'Ausgrid');
  ck('the feed\'s 7 win over the browser\'s 24', a.count === 7 && a.source === 'feed', a);
  ck('and only the feed\'s rows appear', snapshot.states.nsw.outages.every((o) => /^F/.test(o.location)));
  const zero = mergeOutageSnapshot({ vic: { networks: [net('CitiPower', true, 0)], outages: [] } },
    { vic: { networks: [net('CitiPower', true, 3)], outages: [row('CitiPower', 'X', 1)] } },
    null, { now: NOW, browserCapturedAt: NOW - 60000 }).snapshot;
  ck('a feed that answers zero means zero', findNet(zero, 'vic', 'CitiPower').count === 0
    && zero.states.vic.outages.length === 0, zero.states.vic);
}

console.log('\n== browser rows fill a gap only from the same run ==');
{
  const feed = { vic: { networks: [net('United Energy', false, 0, { error: 'empty shell' })], outages: [] } };
  const browser = { vic: { networks: [net('United Energy', true, 2, { shape: 'cards' })],
    outages: [row('United Energy', 'Frankston', 40), row('United Energy', 'Mornington', 12)] } };
  const same = mergeOutageSnapshot(feed, browser, null, { now: NOW, browserCapturedAt: NOW - 120000 }).snapshot;
  const ue = findNet(same, 'vic', 'United Energy');
  ck('a browser read from this run fills the gap', ue.ok && ue.count === 2 && ue.source === 'browser', ue);
  ck('stamped with when the browser read it', ue.capturedAt === NOW - 120000, ue.capturedAt);
  ck('the feed\'s failure is kept beside it', ue.feedError === 'empty shell', ue);
  /* Without a browser capture from this run, the same data arrives only as
     "previous" -- and is held to a much shorter leash. */
  const noBrowser = mergeOutageSnapshot(feed, null, null, { now: NOW }).snapshot;
  ck('with no browser this run and no previous, the operator reads as failed',
    !findNet(noBrowser, 'vic', 'United Energy').ok, findNet(noBrowser, 'vic', 'United Energy'));
}

console.log('\n== a previous capture stands in only briefly ==');
{
  const feed = { tas: { networks: [net('TasNetworks', false, 0, { error: 'timeout' })], outages: [] } };
  const prevAt = (ago) => ({ capturedAt: NOW - ago, states: { tas: {
    networks: [net('TasNetworks', true, 3, { capturedAt: NOW - ago, source: 'feed' })],
    outages: [row('TasNetworks', 'Hobart', 5), row('TasNetworks', 'Burnie', 2), row('TasNetworks', 'Devonport', 1)] } } });
  const recent = mergeOutageSnapshot(feed, null, prevAt(30 * 60000), { now: NOW }).snapshot;
  const r = findNet(recent, 'tas', 'TasNetworks');
  ck('a 30-minute-old capture covers a one-run blip', r.ok && r.source === 'previous' && r.count === 3, r);
  ck('keeping its original timestamp, not now', r.capturedAt === NOW - 30 * 60000, r.capturedAt);
  const old = mergeOutageSnapshot(feed, null, prevAt(PREVIOUS_ROWS_MAX_AGE_MS + 60000), { now: NOW }).snapshot;
  const o = findNet(old, 'tas', 'TasNetworks');
  ck('an older one does not -- its outages may have been fixed', !o.ok && old.states.tas.outages.length === 0, o);
  ck('and the failure says why', /timeout/.test(o.error || ''), o.error);
}

console.log('\n== published totals, which age out ==');
{
  const feed = { sa: { networks: [net('SA Power Networks', false, 0, { error: 'blocked', blocked: true })], outages: [] } };
  const browser = { sa: { networks: [net('SA Power Networks', false, 0,
    { blocked: true, reported: { outages: 47, customers: 3067 }, reportedVia: 'operator home page' })], outages: [] } };
  const fresh = mergeOutageSnapshot(feed, browser, null, { now: NOW, browserCapturedAt: NOW - 60000 }).snapshot;
  const s = findNet(fresh, 'sa', 'SA Power Networks');
  ck('a total read this run is carried', s.reported && s.reported.customers === 3067, s);
  ck('with where it came from', s.reportedVia === 'operator home page', s.reportedVia);
  ck('and when', s.reportedAt === NOW - 60000, s.reportedAt);

  /* The next feed-only run, three hours later: carried, NOT re-stamped. */
  const later = mergeOutageSnapshot(feed, null, fresh, { now: NOW + 3 * H }).snapshot;
  const s2 = findNet(later, 'sa', 'SA Power Networks');
  ck('three hours on it is still shown', !!s2.reported, s2);
  ck('with its original timestamp', s2.reportedAt === NOW - 60000, s2.reportedAt);
  /* And once it is older than the limit, it goes. */
  const stale = mergeOutageSnapshot(feed, null, later, { now: NOW + REPORTED_MAX_AGE_MS + H }).snapshot;
  ck('past the limit it is dropped', !findNet(stale, 'sa', 'SA Power Networks').reported,
    findNet(stale, 'sa', 'SA Power Networks'));
}

console.log('\n== totals from a snapshot written before reportedAt existed ==');
{
  /* The browser-only snapshot committed before this change carries totals
     but no reportedAt. Its own capturedAt is when they were read; without
     that fallback the first feed-only run would drop SA's total until the
     next browser run. */
  const prev = { capturedAt: NOW - 2 * H, states: { sa: { networks: [net('SA Power Networks', false, 0,
    { blocked: true, reported: { customers: 3067 }, reportedVia: 'home page' })], outages: [] } } };
  const feed = { sa: { networks: [net('SA Power Networks', false, 0, { blocked: true })], outages: [] } };
  const s = findNet(mergeOutageSnapshot(feed, null, prev, { now: NOW }).snapshot, 'sa', 'SA Power Networks');
  ck('the total is carried', s.reported && s.reported.customers === 3067, s);
  ck('dated by the old snapshot', s.reportedAt === NOW - 2 * H, s.reportedAt);
  const old = Object.assign({}, prev, { capturedAt: NOW - REPORTED_MAX_AGE_MS - H });
  ck('and still ages out', !findNet(mergeOutageSnapshot(feed, null, old, { now: NOW }).snapshot, 'sa', 'SA Power Networks').reported);
}

console.log('\n== the feed\'s diagnostics survive the merge ==');
{
  const feed = { wa: { networks: [net('Western Power', true, 1, { staleDropped: 2, sourceUrl: 'https://x/query' })],
    outages: [row('Western Power', 'Harvey', 6)] } };
  const { snapshot, coverage } = mergeOutageSnapshot(feed, null, null, { now: NOW });
  const wp = findNet(snapshot, 'wa', 'Western Power');
  /* staleDropped is the field an explicit list has dropped twice already
     in this project; asserted here so it cannot happen a third time. */
  ck('staleDropped is carried', wp.staleDropped === 2, wp);
  ck('and the source URL', wp.sourceUrl === 'https://x/query', wp);
  ck('the coverage report has one line per operator', coverage.length === 1 && coverage[0].source === 'feed', coverage);
}

console.log('\n== a state that exists only in the previous snapshot is not lost ==');
{
  const prev = { capturedAt: NOW - 10 * 60000, states: { nt: { name: 'Northern Territory',
    networks: [net('Power and Water Corporation', false, 0, { blocked: true })], outages: [] } } };
  const { snapshot } = mergeOutageSnapshot({}, null, prev, { now: NOW });
  ck('NT is still listed', !!snapshot.states.nt && snapshot.states.nt.networks.length === 1, snapshot.states);
}

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
