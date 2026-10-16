/* Merges two captures of the outage lists into the snapshot the Worker
   serves: what the Worker's own feed code read, and what a real browser read
   from the operators' pages.

   Why two. Measured on 16 October, operator by operator:

     - The five operators with a verified data feed -- Endeavour, Energex,
       Ergon, Western Power, Evoenergy -- were read fine by the Worker's code
       (195, 116, 286, 126 and 2 rows) and NOT AT ALL by the browser, whose
       pages were blocked or were a map widget with no list in them. That is
       why the snapshot had nothing for QLD, WA or ACT.
     - Everywhere the browser did succeed -- Ausgrid, the four Victorian
       operators, TasNetworks -- the Worker's code got the identical count.
     - The one thing only the browser gets is a PUBLISHED TOTAL for an
       operator that blocks the list (Essential Energy, Jemena, SA Power
       Networks). "SA: 3,067 customers off, per the operator" is worth more
       than a blank.

   So the feed capture supplies the rows, the browser supplies totals where
   there are no rows, and the browser's rows are a fallback only for a
   network the feed could not read IN THE SAME RUN -- browser rows from an
   earlier run are hours old, and an outage list that old shows restored
   suburbs as still dark.

   Pure: no network, no clock except what is passed in. Tested by
   test/merge_outage_snapshot.test.mjs. */

/* How long a previous capture's rows may stand in for a feed that failed
   this time. Covers a transient blip on one run; anything older would be
   showing outages that have since been fixed. */
export const PREVIOUS_ROWS_MAX_AGE_MS = 2 * 3600000;

/* Rows only a browser can read -- AusNet's list is a page that renders in
   JavaScript, and no feed behind it has been found -- would otherwise be on
   the map for two hours after each browser run and gone the rest of the day.
   The browser runs a few times a day, so its rows are allowed to stand
   until the next one is due. That is what the live Worker did before this
   capture existed, so it is parity, not a loosening; and each such network
   carries the time its rows were actually read, so their age is visible. */
export const BROWSER_ROWS_MAX_AGE_MS = 6 * 3600000;

/* How long an operator's published total stays worth showing. The browser
   reads these twice a day; a total from the morning shown at night would be
   presenting a recovered network as still out. */
export const REPORTED_MAX_AGE_MS = 6 * 3600000;

const sum = (rows) => rows.reduce((t, o) => t + (o.customers || 0), 0);

/* feedStates:    { st: payload } from the Worker's own /api/outages/<st>
   browserStates: { st: snapshot-state } written by the browser this run, or null
   previous:      the snapshot committed last time, or null
   opts.now:      ms
   opts.browserCapturedAt: when browserStates was captured (ms), or null */
export function mergeOutageSnapshot(feedStates, browserStates, previous, opts) {
  const now = opts.now;
  const browserAt = opts.browserCapturedAt || null;
  const prevStates = (previous && previous.states) || {};
  const states = {};
  const coverage = [];

  const stateKeys = [...new Set([
    ...Object.keys(feedStates || {}),
    ...Object.keys(browserStates || {}),
    ...Object.keys(prevStates)
  ])];

  for (const st of stateKeys) {
    const feed = (feedStates || {})[st] || null;
    const browser = (browserStates || {})[st] || null;
    const prev = prevStates[st] || null;

    const names = [...new Set([
      ...((feed && feed.networks) || []).map((n) => n.name),
      ...((browser && browser.networks) || []).map((n) => n.name),
      ...((prev && prev.networks) || []).map((n) => n.name)
    ])];

    const networks = [];
    const outages = [];
    for (const name of names) {
      const f = ((feed && feed.networks) || []).find((n) => n.name === name) || null;
      const b = ((browser && browser.networks) || []).find((n) => n.name === name) || null;
      const p = ((prev && prev.networks) || []).find((n) => n.name === name) || null;
      const rowsOf = (state, nm) => ((state && state.outages) || []).filter((o) => o.network === nm);

      let entry, rows;
      /* Where a previous entry's rows originally came from, carried across
         runs, because the age limit depends on it. */
      const prevOrigin = p ? (p.origin || p.source) : null;
      const prevMaxAge = prevOrigin === 'browser' ? BROWSER_ROWS_MAX_AGE_MS : PREVIOUS_ROWS_MAX_AGE_MS;
      if (f && f.ok) {
        /* The feed answered. It is current, and it is the same code the
           live Worker runs, so it is the authority -- including when it
           says zero. */
        entry = { name, ok: true, count: f.count || 0, source: 'feed', origin: 'feed', capturedAt: now };
        rows = rowsOf(feed, name);
      } else if (b && b.ok && browserAt) {
        /* The feed could not read this operator, and the browser could,
           just now in the same run. */
        entry = { name, ok: true, count: b.count || 0, source: 'browser', origin: 'browser',
          capturedAt: browserAt, shape: b.shape, via: b.via };
        rows = rowsOf(browser, name);
      } else if (p && p.ok && p.capturedAt && (now - p.capturedAt) <= prevMaxAge) {
        /* Neither read it this time, but an earlier capture did, recently
           enough to still be true. Marked, so it is never mistaken for a
           fresh read, and keeping its original timestamp and origin. */
        entry = { name, ok: true, count: p.count || 0, source: 'previous', origin: prevOrigin,
          capturedAt: p.capturedAt };
        if (p.shape) entry.shape = p.shape;
        if (p.via) entry.via = p.via;
        rows = rowsOf(prev, name);
      } else {
        entry = { name, ok: false, count: 0, source: 'none', capturedAt: now,
          error: (f && f.error) || (b && b.error) || 'No capture could read this operator' };
        if ((f && f.blocked) || (b && b.blocked)) entry.blocked = true;
        rows = [];
      }

      /* Diagnostic fields from the feed, whichever capture supplied the
         rows -- they describe why the feed did or did not work. */
      if (f) {
        for (const k of ['unreadable', 'staleDropped', 'sourceUrl', 'mergedInto', 'unconfirmed']) {
          if (f[k] !== undefined && entry[k] === undefined) entry[k] = f[k];
        }
        if (!f.ok && f.error && entry.ok) entry.feedError = f.error;
      }

      /* A published total, kept only while it is still recent. From this
         run's browser capture if it has one, else carried from the last
         snapshot with its original timestamp so it ages honestly rather
         than being re-stamped as new on every run. */
      let reported = null, reportedVia, reportedAt;
      if (b && b.reported && browserAt) { reported = b.reported; reportedVia = b.reportedVia; reportedAt = browserAt; }
      else if (p && p.reported) {
        /* A snapshot written by the browser scraper alone predates
           reportedAt; its totals were read when the file was. */
        const at = p.reportedAt || (previous && previous.capturedAt) || null;
        if (at) { reported = p.reported; reportedVia = p.reportedVia; reportedAt = at; }
      }
      if (reported && reportedAt && (now - reportedAt) <= REPORTED_MAX_AGE_MS) {
        entry.reported = reported;
        if (reportedVia) entry.reportedVia = reportedVia;
        entry.reportedAt = reportedAt;
      }

      networks.push(entry);
      rows.forEach((o) => outages.push(Object.assign({}, o, { network: name })));
      coverage.push({ state: st, network: name, source: entry.source, ok: entry.ok,
        count: entry.count, reported: !!entry.reported });
    }

    const unplanned = outages.filter((o) => o.kind !== 'planned');
    const planned = outages.filter((o) => o.kind === 'planned');
    const base = feed || browser || prev || {};
    states[st] = {
      state: st.toUpperCase(), name: base.name,
      count: outages.length, customers: sum(outages),
      unplannedCount: unplanned.length, unplannedCustomers: sum(unplanned),
      plannedCount: planned.length, plannedCustomers: sum(planned),
      networks, outages
    };
  }
  return { snapshot: { capturedAt: now, states }, coverage };
}
