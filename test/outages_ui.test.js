/* The electricity outage tile: tabs, the per-operator chips, the rows, and
   the states that used to be indistinguishable behind an iframe -- an
   operator that is down, one that answers in a shape we can't read, and a
   genuinely quiet network.

   Needs the harness running:
     npm install leaflet --prefix <scratch>
     test/harness/stage.sh <scratch>
     node test/harness/mockserver.js --root <scratch>/testsite &
   Run: node test/outages_ui.test.js
*/
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });

  const open = async (scenario) => {
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const qs = scenario.includes('=') ? scenario : 'outages=' + scenario;
    await p.goto('http://localhost:' + (process.env.MOCK_PORT || 8845) + '/index.html?' + qs, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    p._errs = errs;
    return p;
  };
  const rows = p => p.$$eval('#outageList .outage', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  /* The panel only exists once a town has been searched -- the map is the
     answer until then -- so a test that wants rows has to ask for them. A
     blank term is not a search, so '' would show nothing. */
  const searchRows = async (p, term) => {
    await p.fill('#outageFilter', term);
    await p.waitForTimeout(450);
    return rows(p);
  };
  const summary = p => p.$eval('#outageSummary', e => e.innerText.replace(/\s+/g, ' ').trim());
  const foot = p => p.$eval('#outageFoot', e => e.innerText.replace(/\s+/g, ' ').trim());

  console.log('\n== the iframe is gone and the tile renders from data ==');
  {
    const p = await open('live');
    check('no electricity iframe left in the tile',
      await p.$$eval('#section-outages iframe', els => els.filter(e => !/outage\.report/.test(e.src)).length) === 0);
    check('the state tabs are gone', await p.$$eval('#outageTabs .state-tab', e => e.length) === 0);
    check('the heading says it covers Australia',
      /Australia/.test(await p.$eval('.outage-heading', e => e.innerText)));
    /* No list underneath any more: the map carries every outage and the
       panel appears only for a searched town. */
    check('no outage list is shown before a search',
      await p.$eval('#outageList', e => e.hidden));
    check('the operator chips are gone',
      await p.$$eval('#outageNetworks .outage-net', e => e.length) === 0);
    const dots = await p.$$eval('#outageMap .outage-dot', e => e.length);
    check('the outages are on the map instead', dots > 0, dots);
    /* Searching is what opens the panel. */
    const r = await searchRows(p, 'Wyong');
    check('searching a town opens the panel', r.length > 0, r);
    check('the row names its operator', r.some(t => /Ausgrid|Endeavour|Essential/.test(t)), r);
    check('no page errors', p._errs.length === 0, p._errs);
    await p.close();
  }

  console.log('\n== biggest outage first, planned work marked as such ==');
  {
    const p = await open('live');
    /* 'o' matches most of the fixture's towns, which is what makes this a
       test of ordering rather than of one row. */
    const r = await searchRows(p, 'o');
    check('more than one row comes back', r.length > 2, r.length);
    /* Ordering is the Worker's job -- it has the whole list and sorts once.
       What matters here is that the page renders that order rather than
       quietly imposing its own, so the assertion is on the order itself
       rather than on which towns happen to contain the search letter. */
    const counts = r.map(t => { const m = /([\d,]+) customers/.exec(t); return m ? Number(m[1].replace(/,/g, '')) : null; });
    const withCounts = counts.filter(c => c !== null);
    check('server order is preserved',
      withCounts.every((c, i) => i === 0 || withCounts[i - 1] >= c), counts);
    /* An unreported count sorts last and must not be read as zero. */
    check('a row with no count comes last and shows none',
      counts[counts.length - 1] === null, counts);

    const pr = await searchRows(p, 'Penrith');
    check('planned work carries a tag', /PLANNED/i.test(pr[0] || ''), pr);
    const planned = await p.$$eval('#outageList .outage.planned', e => e.length);
    check('and is styled apart from faults', planned === 1, planned);
    await p.close();
  }

  console.log('\n== an operator that is down stays visible ==');
  {
    const p = await open('partial');
    /* The per-operator chips are gone, so the coverage warning in the
       summary bar is now the only thing standing between a short list and a
       reader who thinks it is complete. It has to carry that weight. */
    check('the summary says the list is incomplete', /incomplete/i.test(await summary(p)), await summary(p));
    check('and counts how many are missing', /\d+ of \d+/.test(await summary(p)), await summary(p));
    /* Four, not five: the partial scenario drops Essential Energy's row. */
    check('the working operators still have their outages',
      (await searchRows(p, 'o')).length === 4, (await searchRows(p, 'o')).length);
    await p.close();
  }

  console.log('\n== an unreadable operator is called out, not silently missing ==');
  {
    const p = await open('drift');
    check('the tile explains the gap', /didn.t recognise/i.test(await foot(p)), await foot(p));
    check('and names the operator', /Endeavour/.test(await foot(p)), await foot(p));
    /* It must not read as quiet either: silently dropping an operator's rows
       is the most misleading thing this tile could do, and with the chips
       gone the footnote above and the summary below are what prevent it. */
    check('and it counts against coverage in the summary',
      /incomplete/i.test(await summary(p)), await summary(p));
    await p.close();
  }

  console.log('\n== quiet and broken do not look the same ==');
  {
    const p = await open('quiet');
    /* With nothing searched the panel stays shut, so a quiet day is told by
       the summary and an empty map -- which is the honest way round: no dots
       and "all networks reporting" says more than a sentence would. */
    check('the panel stays shut when nothing is searched',
      await p.$eval('#outageList', e => e.hidden));
    check('the map has no dots', await p.$$eval('#outageMap .outage-dot', e => e.length) === 0);
    check('and does not warn about coverage', !/incomplete/i.test(await summary(p)), await summary(p));
    /* Searching a real town on a quiet day gets the all-clear, not silence. */
    const v = await (async () => { await p.fill('#outageFilter', 'Ballarat Central');
      await p.waitForTimeout(450); return p.$eval('#outageList', e => e.innerText); })();
    check('and a searched town gets an all-clear', /No current outage listed/i.test(v), v);
    await p.close();

    /* Everything unreachable. The distinction that matters is unchanged:
       a dashboard that cannot see must not render as one that sees nothing.
       With the list gone, the summary bar is where that gets said. */
    const d = await open('down');
    const ds = await d.$eval('#outageSummary', e => e.innerText.replace(/\s+/g, ' ').trim());
    check('an unreachable service names the states that failed',
      /did not load/i.test(ds), ds);
    check('and does not claim every network is reporting',
      !/networks are reporting/i.test(ds), ds);
    await d.close();
  }

  console.log('\n== "not connected yet" is not "unavailable" ==');
  {
    const p = await open('unconnected');
    /* An operator we have never managed to read is a different claim from
       one that has gone down, and the summary has to keep them apart now
       that the chips are gone -- "not connected yet" says we have not built
       the feed, "not reporting" says theirs is broken. */
    const t = await summary(p);
    check('unconnected operators say so, not "unavailable"', /not connected yet/i.test(t), t);
    check('and are counted', /\d+ of \d+/.test(t), t);
    await p.close();
  }

  console.log('\n== an aggregator figures are labelled as such ==');
  {
    const p = await open('via');
    /* Whose figures these are is the claim that must survive the chips being
       removed: an aggregator is a second-hand account and the footnote is
       now the only place that says so. */
    const f = await foot(p);
    check('the footer names the source', /Power Outages Australia/i.test(f), f);
    check('and explains why it is not the operator',
      /third-party aggregator/i.test(f) && /blocks/i.test(f), f);
    check('and names which operator it applies to', /Essential/.test(f), f);
    await p.close();
  }

  console.log('\n== faults are counted apart from planned work ==');
  {
    const p = await open('live');
    const s = await summary(p);
    /* One combined "customers affected" reads as a mass outage when most of
       the list is scheduled work that may not have started. */
    check('unplanned is the headline', /unplanned outage/i.test(s), s);
    check('planned is counted separately', /planned/i.test(s.replace(/unplanned/gi, '')), s);
    check('the two totals are not merged into one',
      !/^\s*\d+\s+current outages\b/i.test(s), s);
    await p.close();
  }

  console.log('\n== a saved capture does not masquerade as live ==');
  {
    const p = await open('snapshot');
    check('the age of the capture is on screen', /captured/i.test(await summary(p)), await summary(p));
    check('and the footer says how to refresh it',
      /scrape outages/i.test(await foot(p)), await foot(p));
    /* The footnote names only the captured operator; one fetched live must
       not be swept into the same sentence. */
    check('operators fetched live are not named as captured',
      !/Endeavour/.test(await foot(p)), await foot(p));
    await p.close();
  }

  console.log('\n== the capture button ==');
  {
    /* A button that cannot work is worse than no button, so it only appears
       where the Worker says the credential is configured. */
    const off = await open('outages=live&scrape=off');
    check('hidden when the deployment has no token',
      await off.$eval('#scrapeBtn', e => e.hasAttribute('hidden')));
    await off.close();

    const p = await open('outages=live&scrape=ready');
    check('shown when it is configured', !(await p.$eval('#scrapeBtn', e => e.hasAttribute('hidden'))));
    check('and enabled', !(await p.$eval('#scrapeBtn', e => e.disabled)));
    await p.click('#scrapeBtn');
    await p.waitForTimeout(500);
    const note = await p.$eval('#scrapeNote', e => e.innerText);
    /* The Action runs for minutes and then has to deploy. Saying "done" here
       would be a lie the reader finds out about later. */
    check('it says the capture started, not that it finished', /started/i.test(note), note);
    check('and sets the expectation that it takes minutes', /minutes/i.test(note), note);
    await p.close();

    const cd = await open('outages=live&scrape=cooldown');
    check('disabled while a capture is still cooling down',
      await cd.$eval('#scrapeBtn', e => e.disabled));
    check('and explains why on hover',
      /recently/i.test(await cd.$eval('#scrapeBtn', e => e.title)),
      await cd.$eval('#scrapeBtn', e => e.title));
    await cd.close();

    const bad = await open('outages=live&scrape=fail');
    await bad.click('#scrapeBtn');
    await bad.waitForTimeout(500);
    const err = await bad.$eval('#scrapeNote', e => e.innerText);
    check('a refusal is surfaced, not swallowed', /refused|could not/i.test(err), err);
    await bad.close();
  }

  console.log('\n== finding a town ==');
  {
    const p = await open('live');
    const search = async (q) => {
      await p.fill('#outageFilter', q);
      await p.waitForTimeout(250);
      return rows(p);
    };

    /* The question this list exists to answer: is my town out. One outage
       covering four towns has to be findable by any of them. */
    let r = await search('Wyong Creek');
    check('a town in the middle of a multi-town outage is found', r.length === 1, r);
    check('and the row shows the whole outage, not just that town',
      /Kulnura/.test(r[0]) && /Yarramalong/.test(r[0]), r[0]);

    r = await search('wyong');
    check('matching is case-insensitive', r.length === 1, r.length);

    /* A street in the row text must not answer for a town. */
    r = await search('Greystanes');
    check('a town behind a "+4 more" is still found', r.length === 1, r);
    check('and the hidden remainder is admitted to',
      /not listed by the operator/i.test(r[0]), r[0]);

    r = await search('Dubbo');
    check('a single-town outage is found', r.length === 1, r);
    check('the count reports the match', /1 of \d+ match/.test(await p.$eval('#outageFilterCount', e => e.textContent)),
      await p.$eval('#outageFilterCount', e => e.textContent));

    r = await search('Nowheresville');
    check('no match shows none', r.length === 0, r);
    const t = await p.$eval('#outageList', e => e.innerText);
    /* Not the same claim as "no outages". For a name the gazetteer does not
       carry, the honest answer is that we do not recognise the place --
       naming a distributor for it would be invention. The operator caveat
       is tested below with a town that does exist. */
    check('and says what it does not cover',
      /don.t recognise it/i.test(t), t);

    await p.fill('#outageFilter', '');
    await p.waitForTimeout(250);
    /* Clearing the box closes the panel and hands the map back -- there is
       no list to restore. */
    check('clearing the search closes the panel',
      await p.$eval('#outageList', e => e.hidden));
    await p.close();
  }

  console.log('\n== an operator we cannot list, whose total is known ==');
  {
    const p = await open('totals');
    /* These figures used to sit on the per-operator chips. With those gone
       the summary is the only place a whole state's customer count appears,
       and losing it would quietly shrink the national picture. It stays
       apart from the counted total: second-hand, and with no town behind
       it. */
    const t = await summary(p);
    check('the operator total is still shown', /3,067 customers off/.test(t), t);
    check('and is marked as having no town detail', /can.t list by town/i.test(t), t);
    check('it is not folded into the counted total',
      /\+ 3,067/.test(t), t);
    await p.close();
  }

  console.log('\n== one national list, not eight tabbed ones ==');
  {
    const p = await open('live');
    await p.waitForTimeout(1200);
    /* The fixture gives NSW six rows and every other state none, so the
       national list is the NSW rows -- but arrived at by merging eight
       requests rather than by selecting a tab. */
    /* Every state's rows reach one map. The fixture gives NSW six outages
       across nine towns and the rest nothing, so the dots are the NSW towns
       -- but arrived at by merging eight requests rather than by selecting a
       tab. */
    const dots = await p.$$eval('#outageMap .outage-dot', e => e.length);
    check('rows from every state land on one map', dots > 0, dots);
    const r = await searchRows(p, 'o');
    check('and one searchable list', r.length > 2, r.length);
    /* Coverage is national now, so the summary counts every operator in the
       country rather than one state's two or three. */
    const t = await summary(p);
    check('coverage is counted nationally', /\d+ of (1[0-9]|[89])\b/.test(t) || !/of \d+/.test(t), t);
    await p.close();
  }

  console.log('\n== both maps zoom, and neither eats the page ==');
  {
    const p = await open('live');
    await p.waitForTimeout(1300);

    /* Buttons first: the wheel must never be the only way in. */
    for (const sel of ['#outageMap', '#map']) {
      const zc = await p.$$eval(sel + ' .leaflet-control-zoom a', els => els.length);
      check('zoom buttons on ' + sel, zc === 2, zc);
    }

    /* Scrolling over a map you have not touched scrolls the page. This is
       the case that made the fire map hostile: a 600px map mid-page that
       swallowed the wheel on the way past. */
    const before = await p.evaluate(() => window.scrollY);
    await p.hover('#outageMap');
    await p.mouse.wheel(0, 400);
    await p.waitForTimeout(350);
    const after = await p.evaluate(() => window.scrollY);
    check('scrolling over an untouched map moves the page', after > before, { before, after });

    /* Clicking hands the wheel to the map. The baseline is taken AFTER the
       click, because Playwright scrolls an element into view before clicking
       it -- measuring before would credit that scroll to the wheel. */
    await p.click('#outageMap', { position: { x: 200, y: 200 } });
    await p.waitForTimeout(300);
    const parked = await p.evaluate(() => window.scrollY);
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(500);
    const pageNow = await p.evaluate(() => window.scrollY);
    check('after clicking, the wheel no longer scrolls the page',
      pageNow === parked, { parked, pageNow });

    /* And gives it back on the way out, so the page is never stuck. */
    const hintOff = await p.$eval('.outage-mapstage .map-zoomhint', e => e.classList.contains('off'));
    check('the badge says the map has the wheel', hintOff === true);
    await p.hover('.outage-summary');
    await p.waitForTimeout(250);
    const hintBack = await p.$eval('.outage-mapstage .map-zoomhint', e => !e.classList.contains('off'));
    check('and takes it back when the pointer leaves', hintBack === true);
    await p.close();
  }

  console.log('\n== the map ==');
  {
    const p = await open('live');
    await p.waitForTimeout(1200);
    const dots = await p.$$eval('#outageMap .outage-dot', els => els.length);
    /* The fixture's towns are all in the gazetteer, so every one should be a
       dot. Plotting only rows that carry their own coordinate would leave
       most operators off the map entirely. */
    check('towns are plotted as dots', dots > 0, dots);
    const note = await p.$eval('#outageMapNote', e => e.innerText);
    check('the map says how many towns it mapped', /town/i.test(note), note);

    /* Coverage stated positively when it holds. A bar that only ever warns
       leaves a quiet day looking the same as a blind one. */
    const bar = await p.$eval('#outageSummary', e => e.innerText);
    check('the bar carries the unplanned count', /unplanned/i.test(bar), bar);
    check('and planned work separately', /planned/i.test(bar), bar);

    /* The summary bar sits on the map rather than apart from it. */
    const barInMap = await p.$eval('#outageSummary',
      e => !!e.closest('.outage-mapwrap'));
    check('the summary is the bar on top of the map', barInMap);

    await p.click('#outageMap .outage-dot');
    await p.waitForTimeout(400);
    const pop = await p.$eval('.leaflet-popup-content', e => e.innerText).catch(() => '');
    check('clicking a dot opens its detail', /customers off|Status|Cause/i.test(pop), pop);
    check('and names the operator', /Ausgrid|Endeavour|Essential/i.test(pop), pop);
    await p.close();
  }

  console.log('\n== the bar says when the list is complete ==');
  {
    /* Every operator answering is a fact the reader needs: it is what makes
       "no outages" mean no outages rather than no data. */
    const p = await open('quiet');
    await p.waitForTimeout(900);
    const bar = await p.$eval('#outageSummary', e => e.innerText);
    check('a complete list says so', /reporting/i.test(bar), bar);
    check('and does not warn about anything', !/not reporting|not connected/i.test(bar), bar);
    await p.close();
  }

  {
    /* And when an operator is missing, the reassurance must disappear -- it
       would otherwise contradict the warning sitting next to it. */
    const p = await open('partial');
    await p.waitForTimeout(900);
    const bar = await p.$eval('#outageSummary', e => e.innerText);
    check('an incomplete list warns instead', /not reporting|not connected/i.test(bar), bar);
    check('and does not also claim everything is reporting',
      !/all \d+ networks are reporting/i.test(bar), bar);
    await p.close();
  }

  console.log('\n== town names as operators actually write them ==');
  {
    const p = await open('towns');
    await p.waitForTimeout(1400);
    const dots = await p.$$eval('#outageMap .outage-dot', els => els.length);
    /* Four rows: a comma-joined pair, an "and surrounds", a name the ABS
       disambiguates with a state suffix, and one piece of scraped rubbish.
       That is four real towns. An audit of the live data found these three
       shapes accounted for every failure but two. */
    check('a comma-joined list becomes one dot per town', dots === 4, dots);

    const note = await p.$eval('#outageMapNote', e => e.innerText);
    check('nothing real is left unplaced', !/could not be placed/i.test(note), note);
    /* The 404 row is not a town we failed to find, and must not be counted
       as one -- that would overstate what is missing and hide the bad
       scrape behind it. */
    check('the unreadable row is reported separately',
      /no readable place name/i.test(note), note);

    /* Each shape individually, so a regression names itself. */
    await p.fill('#outageFilter', 'Ravensdale');
    await p.waitForTimeout(400);
    check('the second town of a joined pair is searchable',
      (await rows(p)).length === 1, await rows(p));
    await p.fill('#outageFilter', 'Shepparton');
    await p.waitForTimeout(400);
    check('"and surrounds" still finds the town',
      (await rows(p)).length === 1, await rows(p));
    await p.fill('#outageFilter', 'Cromer');
    await p.waitForTimeout(400);
    check('a state-disambiguated ABS name is found',
      (await rows(p)).length === 1, await rows(p));
    await p.close();
  }

  console.log('\n== a town we cannot place is counted, not dropped ==');
  {
    /* With no gazetteer the page can still plot operators that publish
       coordinates, but it must say what is missing rather than draw a
       thinner map and let the reader believe it. */
    const p = await open('live&gaz=off');
    await p.waitForTimeout(1200);
    const note = await p.$eval('#outageMapNote', e => e.innerText);
    check('the map admits the lookup failed', /unavailable/i.test(note), note);
    /* The list is search-scoped now, so the check is that the outages are
       still reachable -- not that they are sitting on screen. */
    const rowCount = (await searchRows(p, 'o')).length;
    check('the outages are still all reachable', rowCount > 0, rowCount);
    await p.close();
  }

  console.log('\n== what a search says when it finds nothing ==');
  {
    const p = await open('live');
    await p.waitForTimeout(1200);

    /* NSW: Ausgrid and Endeavour answer, Essential Energy does not. "No
       outage listed" is true, but it cannot be the whole answer. */
    /* Tamworth: in the gazetteer, deliberately absent from the outage rows.
       Dubbo and Gosford both match real fixture outages and would have
       tested nothing. */
    await p.fill('#outageFilter', 'Tamworth');
    await p.waitForTimeout(400);
    let v = await p.$eval('#outageList', e => e.innerText);
    const cls = await p.$eval('#outageList .outage-verdict', e => e.className).catch(() => '');
    check('NSW says no outage is listed', /No current outage listed/i.test(v), v);
    check('and names the operator it cannot see', /Essential Energy/.test(v), v);
    check('with a link to that operator',
      await p.$eval('#outageList .outage-verdict a', a => /essentialenergy\.com\.au/.test(a.href)));

    /* SA: one distributor, and it blocks us. Here "we cannot see" is certain
       and has to be said plainly -- the reader must not read silence as
       "your power is on". */
    /* No tab to select: the gazetteer says Port Augusta is in SA, and that
       is what decides the answer. */
    await p.fill('#outageFilter', 'Port Augusta');
    await p.waitForTimeout(400);
    v = await p.$eval('#outageList', e => e.innerText);
    check('SA says the provider blocks us', /blocks automated access/i.test(v), v);
    check('and does not let that be read as "no outage"',
      /not the same as saying your power is on/i.test(v), v);
    check('with a link to SA Power Networks',
      await p.$eval('#outageList .outage-verdict a', a => /sapowernetworks\.com\.au/.test(a.href)));
    check('and is styled as a gap, not an all-clear',
      await p.$eval('#outageList .outage-verdict', e => e.classList.contains('blind')));

    /* Victoria: every distributor answers, so no warning belongs here at all.
       Telling someone their provider blocks us when their power is simply on
       is the failure this whole verdict exists to avoid. */
    await p.fill('#outageFilter', 'Ballarat Central');
    await p.waitForTimeout(400);
    v = await p.$eval('#outageList', e => e.innerText);
    check('VIC says no outage is listed', /No current outage listed/i.test(v), v);
    check('and warns about nobody, because nobody is blocked',
      !/blocks automated access/i.test(v), v);
    check('and is styled as an all-clear',
      await p.$eval('#outageList .outage-verdict', e => e.classList.contains('clear')));

    /* A name in two states, neither out. Naming one distributor would mean
       picking at random, so it names both places instead. */
    await p.fill('#outageFilter', 'Richmond');
    await p.waitForTimeout(400);
    v = await p.$eval('#outageList', e => e.innerText);
    check('an ambiguous name lists every state it is in',
      /VIC/.test(v) && /TAS/.test(v), v);
    check('and claims nothing about a distributor',
      !/blocks automated access/i.test(v), v);

    /* A place the gazetteer does not carry. Asserting anything about its
       provider would be invention. */
    await p.fill('#outageFilter', 'Nowheresville');
    await p.waitForTimeout(400);
    v = await p.$eval('#outageList', e => e.innerText);
    check('an unknown place says so rather than guessing',
      /don.t recognise it/i.test(v), v);
    await p.close();
  }

  await b.close();
  console.log('\n----------------------------------------');
  console.log('passed: ' + pass + '   failed: ' + fail);
  process.exit(fail ? 1 : 0);
})();
