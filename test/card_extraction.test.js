/* The browser scraper's card reader, against a DOM shaped like the one it
   actually failed on: Endeavour's outage list panel, which is a heading, a
   filter box, then one block per outage. The first run pulled exactly one
   outage from every card-based site, so this pins the case that broke.

   Run: node test/card_extraction.test.js   (needs playwright + chromium)
*/
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
const { readFileSync } = require('node:fs');

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};

/* Pulled out of the scraper so the test exercises the real function rather
   than a copy that can drift away from it. */
const src = readFileSync(new URL('../scripts/scrape-outages.mjs', 'file://' + __dirname + '/'), 'utf8');
const hintsSrc = src.slice(src.indexOf('const HINTS = ['));
const HINTS = eval(hintsSrc.slice(hintsSrc.indexOf('['), hintsSrc.indexOf('\n];') + 2));
const fnSrc = src.slice(src.indexOf('function extractInPage('), src.indexOf('/* </extract> */'));

const card = (suburb, ref, kind, etr) =>
  `<div class="c"><h3>${suburb}</h3><p>Reference: ${ref}</p><p>${kind}</p>` +
  (etr ? `<p>Est. restoration time: ${etr}</p>` : '') + `</div>`;

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage();

  console.log('\n== an outage list panel of repeated cards ==');
  {
    await p.setContent(`<body><div id="app"><aside>
      <h2>Outage list</h2><div>Last Updated: 24 Sep 2026 08:20</div>
      <input placeholder="Filter list by suburb or Ref. No.">
      <div class="list">
        ${card('Greystanes +4 more', 'INC 1115105492', 'Unplanned outage', '14:30 24/09/26')}
        ${card('Vineyard', 'INC 1115105769', 'Unplanned outage', '12:00 24/09/26')}
        ${card('Orchard Hills', 'INC 1115105749', 'Unplanned outage', '11:00 24/09/26')}
        ${card('Burradoo', 'INC 1115105772', 'Planned outage', '12:00 24/09/26')}
      </div></aside></div></body>`);

    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    check('the card shape is recognised', out.shape === 'cards', out.shape);
    /* The bug this pins: the container picked was a wrapper holding one
       list, so exactly one card came back from every site. */
    check('every card is read, not just the first', out.records.length === 4, out.records.length);
    const first = out.records[0];
    check('the heading line is the location', first.location === 'Greystanes +4 more', first);
    check('the reference is picked up', /1115105492/.test(first.id || ''), first);
    check('a labelled restoration time is read', /14:30/.test(first.restore || ''), first);
    check('an unlabelled type line is read', /unplanned/i.test(first.kind || ''), first);
    check('planned is distinguished from unplanned',
      /planned/i.test(out.records[3].kind) && !/unplanned/i.test(out.records[3].kind),
      out.records[3]);
  }

  console.log('\n== a card laid out as inline spans ==');
  {
    /* The Victorian sites, verbatim from what the scraper actually saw:
       innerText comes back as one run-on string with no line to split on,
       which is why 28 outages a page were being read as none. */
    const vicCard = (suburb, kind, status, etr, custs, loc) =>
      `<div class="card"><span>${suburb}</span><span>${kind}</span><span>${status}</span>` +
      `<span>Estimated restoration:</span><span>${etr}</span>` +
      `<span>Customers affected: ${custs}</span><span>Fault location: ${loc}</span></div>`;
    await p.setContent(`<body><div class="flex flex-col gap-3 w-full">
      ${vicCard('South Melbourne', 'Planned', 'Partially restored', '15:00 19 Sept', '1', 'Albert Road')}
      ${vicCard('Balwyn', 'Planned', 'Partially restored', '14:00 24 Sept', '41', 'Winmalee Road')}
      ${vicCard('Carlton', 'Unplanned', 'Investigating', '14:30 24 Sept', '110', 'Lygon Street')}
      </div></body>`);
    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    check('every card is read', out.records.length === 3, out.records.length);
    const carlton = out.records.find(r => r.location === 'Carlton');
    check('the suburb leads the card', !!carlton, out.records.map(r => r.location));
    check('a value in its own element is paired with its label',
      carlton && /14:30/.test(carlton.restore || ''), carlton);
    check('a label and value in one element are split',
      carlton && carlton.customers === '110', carlton);
    check('an unlabelled type fragment is read',
      carlton && /unplanned/i.test(carlton.kind || ''), carlton);
  }

  console.log('\n== the page\u2019s own totals are read even with no list ==');
  {
    await p.setContent('<body><div id="root"></div>' +
      '<p>Active outages:</p><p>9</p><p>Affected customers:</p><p>1,269</p></body>');
    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    /* The list is behind a panel this never opens, but the operator states
       its own totals -- and those are exactly the dashboard's headline. */
    check('no rows are invented', out.records.length === 0, out.records);
    check('the stated outage count is read', out.reported && out.reported.outages === 9, out.reported);
    check('and the stated customer count', out.reported && out.reported.customers === 1269, out.reported);
  }

  console.log('\n== a sentence form is read too ==');
  {
    await p.setContent('<body><p>Across Canberra there are currently 3 outages affecting 155 customers.</p></body>');
    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    check('outages and customers both come out of one sentence',
      out.reported && out.reported.outages === 3 && out.reported.customers === 155, out.reported);
  }

  console.log('\n== a table on the page still wins ==');
  {
    await p.setContent(`<body>
      <table><tr><th>Suburb</th><th>Customers affected</th></tr>
        <tr><td>Newtown</td><td>412</td></tr></table>
      <div class="list">${card('Vineyard', 'INC 1', 'Unplanned outage', '')}${card('Penrith', 'INC 2', 'Unplanned outage', '')}</div>
      </body>`);
    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    check('a real table is preferred over cards', out.shape === 'table', out.shape);
    check('and its rows are the ones returned',
      out.records.length === 1 && out.records[0].location === 'Newtown', out.records);
  }

  console.log('\n== a page with neither says so ==');
  {
    await p.setContent('<body><div id="root"></div></body>');
    const out = await p.evaluate(new Function('hints', 'return (' + fnSrc + ')(hints);'), HINTS);
    check('nothing is invented', out.records.length === 0, out.records);
    check('and the shape reports none', out.shape === 'none', out.shape);
  }

  await b.close();
  console.log('\n----------------------------------------');
  console.log('passed: ' + pass + '   failed: ' + fail);
  process.exit(fail ? 1 : 0);
})();
