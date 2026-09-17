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
    await p.goto('http://localhost:8846/index.html?outages=' + scenario, { waitUntil: 'domcontentloaded' });
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
    check('outage rows render', r.length === 4, r.length);
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
    check('the working operators still list outages', (await rows(p)).length === 3, (await rows(p)).length);
    await p.close();
  }

  console.log('\n== an unreadable operator is called out, not silently missing ==');
  {
    const p = await open('drift');
    check('the tile explains the gap', /didn.t recognise/i.test(await foot(p)), await foot(p));
    check('and names the operator', /Endeavour/.test(await foot(p)), await foot(p));
    const c = await chips(p);
    check('it is not reported as down', c.filter(x => x.down).length === 0, c);
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
