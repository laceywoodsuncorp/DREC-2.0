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
    await p.goto('http://localhost:8846/index.html?' + qs, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    p._errs = errs;
    return p;
  };
  const rows = p => p.$$eval('#outageList .outage', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const chips = p => p.$$eval('#outageNetworks .outage-net', els =>
    els.map(e => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), down: e.classList.contains('down'), title: e.title })));
  const summary = p => p.$eval('#outageSummary', e => e.innerText.replace(/\s+/g, ' ').trim());
  const foot = p => p.$eval('#outageFoot', e => e.innerText.replace(/\s+/g, ' ').trim());

  console.log('\n== the iframe is gone and the tile renders from data ==');
  {
    const p = await open('live');
    check('no electricity iframe left in the tile',
      await p.$$eval('#section-outages iframe', els => els.filter(e => !/outage\.report/.test(e.src)).length) === 0);
    check('state tabs are present', await p.$$eval('#outageTabs .state-tab', e => e.length) === 8);
    const r = await rows(p);
    check('outage rows render', r.length === 6, r.length);
    check('each row names its operator',
      r.every(t => /Ausgrid|Endeavour Energy|Essential Energy/.test(t)), r);
    check('customer numbers are formatted', r.some(t => /1,205 customers/.test(t)), r);
    check('no page errors', p._errs.length === 0, p._errs);
    await p.close();
  }

  console.log('\n== biggest outage first, planned work marked as such ==');
  {
    const p = await open('live');
    const r = await rows(p);
    /* Ordering is the Worker's job -- it has the whole list and sorts once.
       What matters here is that the page renders that order rather than
       quietly imposing its own. */
    check('server order is preserved', /Penrith/.test(r[0]) && /Gosford/.test(r[r.length - 1]), r);
    check('planned work carries a tag', /PLANNED/i.test(r.find(t => /Penrith/.test(t)) || ''), r[0]);
    const planned = await p.$$eval('#outageList .outage.planned', e => e.length);
    check('and is styled apart from faults', planned === 1, planned);
    /* A row with no reported count must not invent one. */
    const gosford = r.find(t => /Gosford/.test(t));
    check('a row with no count shows none', gosford && !/customers/.test(gosford), gosford);
    await p.close();
  }

  console.log('\n== an operator that is down stays visible ==');
  {
    const p = await open('partial');
    const c = await chips(p);
    check('every operator still has a chip', c.length === 3, c.map(x => x.text));
    const dead = c.filter(x => x.down);
    check('the failing one is marked, not dropped', dead.length === 1 && /Essential/.test(dead[0].text), c);
    check('its reason is on hover', /403/.test(dead[0].title), dead[0].title);
    check('the summary says the list is incomplete', /incomplete/i.test(await summary(p)), await summary(p));
    check('the working operators still list outages', (await rows(p)).length === 5, (await rows(p)).length);
    await p.close();
  }

  console.log('\n== an unreadable operator is called out, not silently missing ==');
  {
    const p = await open('drift');
    check('the tile explains the gap', /didn.t recognise/i.test(await foot(p)), await foot(p));
    check('and names the operator', /Endeavour/.test(await foot(p)), await foot(p));
    const c = await chips(p);
    /* It must not read as quiet either: "none listed" on an operator whose
       rows were dropped is the most misleading thing this tile could say. */
    check('the chip says the data was unreadable, not "none listed"',
      c.some(x => /not readable/i.test(x.text)) && !c.some(x => /none listed/i.test(x.text)),
      c.map(x => x.text));
    check('and it counts against coverage in the summary',
      /incomplete/i.test(await summary(p)), await summary(p));
    await p.close();
  }

  console.log('\n== quiet and broken do not look the same ==');
  {
    const p = await open('quiet');
    const t = await p.$eval('#outageList', e => e.innerText);
    check('quiet says there are no outages', /No current electricity outages/i.test(t), t);
    check('and does not warn about coverage', !/incomplete/i.test(await summary(p)), await summary(p));
    await p.close();

    const d = await open('down');
    const dt = await d.$eval('#outageList', e => e.innerText);
    check('an unreachable service says so instead',
      /not reporting|couldn|not the same as there being no outages/i.test(dt), dt);
    check('and never claims zero outages', !/No current electricity outages/i.test(dt), dt);
    await d.close();
  }

  console.log('\n== "not connected yet" is not "unavailable" ==');
  {
    const p = await open('unconnected');
    const c = await chips(p);
    check('every operator still has a chip', c.length === 3, c.map(x => x.text));
    check('unconnected operators say so, not "unavailable"',
      c.filter(x => /not connected yet/i.test(x.text)).length === 2, c.map(x => x.text));
    check('and are not styled as a failure', c.filter(x => x.down).length === 0, c);
    const s = await summary(p);
    check('the summary distinguishes it from an outage',
      /not connected yet/i.test(s) && !/not reporting/i.test(s), s);
    check('their own map is still one click away',
      await p.$$eval('#outageNetworks .outage-net a', els => els.every(a => /^https:\/\//.test(a.href))));
    await p.close();
  }

  console.log('\n== an aggregator figures are labelled as such ==');
  {
    const p = await open('via');
    const c = await chips(p);
    const ee = c.find(x => /Essential/.test(x.text));
    check('the chip names the source', /via Power Outages Australia/i.test(ee.text), c.map(x => x.text));
    check('the footer explains why it is not the operator',
      /third-party aggregator/i.test(await foot(p)) && /blocks/i.test(await foot(p)), await foot(p));
    check('operators read directly carry no such label',
      !/via /i.test(c.find(x => /Ausgrid/.test(x.text)).text), c.map(x => x.text));
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
    const c = await chips(p);
    check('the chip marks it as a snapshot',
      /snapshot/i.test(c.find(x => /Ausgrid/.test(x.text)).text), c.map(x => x.text));
    check('the age of the capture is on screen', /captured/i.test(await summary(p)), await summary(p));
    check('and the footer says how to refresh it',
      /scrape outages/i.test(await foot(p)), await foot(p));
    check('operators fetched live carry no such mark',
      !/snapshot/i.test(c.find(x => /Endeavour/.test(x.text)).text), c.map(x => x.text));
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
    /* Not the same claim as "no outages" -- we only know the operators that
       answered. */
    check('and says what it does not cover', /check theirs directly/i.test(t), t);

    await p.fill('#outageFilter', '');
    await p.waitForTimeout(250);
    check('clearing the search restores the list', (await rows(p)).length > 3, (await rows(p)).length);
    await p.close();
  }

  console.log('\n== an absorbed operator says where its rows went ==');
  {
    const p = await open('merged');
    const c = await chips(p);
    const ee = c.find(x => /Endeavour/.test(x.text));
    check('it does not read as "none listed"', !/none listed/i.test(ee.text), ee.text);
    check('it says which operator lists them', /listed under Ausgrid/i.test(ee.text), ee.text);
    await p.close();
  }

  console.log('\n== tabs switch states and carry counts ==');
  {
    const p = await open('live');
    const labels = await p.$$eval('#outageTabs .state-tab', els => els.map(e => e.innerText.trim()));
    check('tabs show per-state counts', labels.some(l => /\(\d+\)/.test(l)), labels);
    check('a state with nothing reporting shows "!"', labels.some(l => /\(!\)/.test(l)), labels);
    await p.click('#outageTabs .state-tab[data-state="VIC"]');
    await p.waitForTimeout(600);
    check('clicking a tab activates it',
      await p.$eval('#outageTabs .state-tab[data-state="VIC"]', e => e.classList.contains('active')));
    check('and loads that state', /VIC|Victoria/.test(await p.$eval('#outageList', e => e.innerText)) ||
      (await rows(p)).length === 0);
    await p.close();
  }

  await b.close();
  console.log('\n----------------------------------------');
  console.log('passed: ' + pass + '   failed: ' + fail);
  process.exit(fail ? 1 : 0);
})();
