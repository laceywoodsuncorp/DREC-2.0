/* Category tagging that follows from the publisher, not just the wording.

   insuranceNEWS is a trade masthead whose whole output is insurance, so its
   headlines rarely say so -- "NIBA finalising code after extensive feedback"
   is an insurance story containing no insurance keyword. Keyword matching
   alone tagged those General, which is why the dashboard's Insurance chip
   was missing the one source that is entirely insurance.

   The rules extracted from the page are the real ones, so a change to the
   page that breaks this fails here.

   Run: node test/classify_source.test.mjs */
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(page);
  if (!m) throw new Error('not found in the page: ' + what);
  return m[0];
};

const classify = new Function([
  grab(/const CAT_KEYWORDS=\{[\s\S]*?\n  \};/, 'CAT_KEYWORDS'),
  grab(/const AMBIGUOUS_RE=[\s\S]*?const CLAIM_FATALITY_RE=[^\n]*\n/, 'ambiguous-term rules'),
  grab(/const FIRE_REGEX=[\s\S]*?;\n/, 'FIRE_REGEX'),
  grab(/const kwMatchers=\{\};/, 'kwMatchers'),
  grab(/function keywordHit\(text,kw\)\{[\s\S]*?\n  \}/, 'keywordHit'),
  grab(/const SOURCE_CATS=\[[\s\S]*?\n  \];/, 'SOURCE_CATS'),
  grab(/function hostOf\(v\)\{[\s\S]*?\n  \}/, 'hostOf'),
  grab(/function sourceCats\(domain,source\)\{[\s\S]*?\n  \}/, 'sourceCats'),
  grab(/function classify\(title,domain,source\)\{[\s\S]*?\n  \}/, 'classify')
].join('\n') + '; return classify;')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

const IN = 'insurancenews.com.au';

console.log('== every insuranceNEWS story is insurance, however it is worded ==');
/* Real headlines from the feed, none of which contain an insurance word. */
[
  'NIBA finalising code after extensive feedback',
  'APRA flags capital review for general sector',
  'Suncorp names new chief executive',
  'Hollard completes Greenstone acquisition',
  'Broker network reports record revenue',
  'Steadfast lifts full-year guidance'
].forEach((t) => {
  const cats = classify(t, IN, 'insuranceNEWS');
  ck('"' + t.slice(0, 44) + '" -> insurance', cats.includes('insurance'), cats);
});

console.log('\n== the tag leads, so the three-tag card cannot drop it ==');
/* The card renders cats.slice(0,3). A story matching several keyword
   categories must not push Insurance off the insurance masthead's own card. */
const busy = classify(
  'Minister and senator clash over inflation and interest rate policy after police court ruling',
  IN, 'insuranceNEWS');
ck('insurance is present on a many-category story', busy.includes('insurance'), busy);
ck('insurance is first', busy[0] === 'insurance', busy);
ck('it survives the card slice', busy.slice(0, 3).includes('insurance'), busy.slice(0, 3));

console.log('\n== other relevant tags are still applied alongside it ==');
const flood = classify('Flood claims surge after Queensland storm', IN, 'insuranceNEWS');
ck('insurance and flood together', flood.includes('insurance') && flood.includes('flood'), flood);
const bush = classify('Bushfire losses mount for insurers', IN, 'insuranceNEWS');
ck('insurance and bushfire together', bush.includes('insurance') && bush.includes('bushfire'), bush);
const econ = classify('Premiums rise as inflation bites', IN, 'insuranceNEWS');
ck('insurance and economy together', econ.includes('insurance') && econ.includes('economy'), econ);
ck('no duplicate insurance tag',
  econ.filter((c) => c === 'insurance').length === 1, econ);

console.log('\n== host forms that must all match ==');
['insurancenews.com.au', 'www.insurancenews.com.au', 'https://www.insurancenews.com.au',
 'https://insurancenews.com.au/local/story', 'INSURANCENEWS.COM.AU'].forEach((d) => {
  ck(JSON.stringify(d), classify('Board appoints director', d, '').includes('insurance'),
    classify('Board appoints director', d, ''));
});
ck('matched by source name when the domain is absent',
  classify('Board appoints director', '', 'insuranceNEWS').includes('insurance'));

console.log('\n== and hosts that must NOT match ==');
/* Suffix-matched on a label boundary. A plain substring test would accept a
   lookalike host that merely contains ours. */
['notinsurancenews.com.au', 'insurancenews.com.au.example.com', 'abc.net.au',
 'insurancebusinessmag.com'].forEach((d) => {
  const cats = classify('Board appoints director', d, '');
  ck(JSON.stringify(d) + ' is not tagged insurance', !cats.includes('insurance'), cats);
});
ck('a subdomain of ours does match', classify('X', 'feeds.insurancenews.com.au', '').includes('insurance'));

console.log('\n== the stem overreach, measured headline by headline ==');
/* Every single keyword used to be matched as a stem, which was wrong far
   more often than right: 12 of these 13 were mis-tagged. A trailing * now
   marks the keywords that are genuinely stems and everything else is a whole
   word. Listed individually so a regression names the headline it broke. */
[
  ['Bushfire warning for the Blue Mountains', ['bushfire']],
  ['Severe weather warning issued for the Hunter', ['flood']],
  ['Flood warning upgraded for the Macquarie', ['flood']],
  ['Emergency warning as fire approaches Warburton', []],
  ['Warrant issued for missing man', []],
  ['War in Ukraine enters third year', ['world']],
  ['Insurance policy changes hit small business', ['insurance']],
  /* No line of cover named, so the narrow premium rule leaves it alone.
     This expected ['insurance'] while premium* was a standalone trigger;
     "policy" on its own is not an insurance word either -- a government
     policy on premiums reads identically. */
  ['New policy on premiums announced', []],
  ['Policyholders face higher excess', ['insurance']],
  ['Police charge man over Brisbane stabbing', ['crime']],
  ['Court sentences man over arson', ['crime']],
  ['Council courtesy bus returns to service', []],
  ['PM hailed the housing agreement', []],
  ['Hailstones smash windscreens in Toowoomba', ['flood']],
  ['Fluctuating fuel prices squeeze drivers', ['economy']],
  ['Interest rates on hold says RBA', ['economy']],
  ['Striker signs with Melbourne Victory', ['sport']],
  ['Minister announces election date', ['politics']],
  ['Insurer rejects claim after storm', ['insurance', 'flood']],
  ['Illawarra Mercury reports on council budget', ['economy']]
].forEach(([title, want]) => {
  const got = classify(title, 'abc.net.au', 'ABC News');
  const missing = want.filter((w) => !got.includes(w));
  const extra = got.filter((g) => !want.includes(g));
  ck(title.slice(0, 46), missing.length === 0 && extra.length === 0,
    { got, want, missing, extra });
});

console.log('\n== a phrase keyword still matches, marker or not ==');
/* The stem marker is redundant on a multi-word phrase, since a substring
   already matches a longer word at its end -- but adding it broke the phrase
   outright for one revision, because the asterisk was matched literally. */
ck('"fuel prices" matches the "fuel price" phrase',
  classify('Fuel prices climb again', 'abc.net.au', '').includes('economy'));
ck('"interest rates" matches the "interest rate" phrase',
  classify('Interest rates unchanged', 'abc.net.au', '').includes('economy'));
ck('no keyword is matched with a literal asterisk',
  !classify('Report mentions fuel price* in a footnote', 'abc.net.au', '').includes('nonsense'));

console.log('\n== natural perils support a claims headline ==');
/* The perils are why this dashboard exists: a claims surge after an event
   is the insurance story its readers most want flagged. */
[
  'Flood claims surge after Queensland storm',
  'Hail claims top $400m',
  'Storm claims pour in across Victoria',
  'Cyclone claims expected to top $2bn',
  'Bushfire claims mount',
  'Earthquake claims lodged in Melbourne',
  'Landslide claims under assessment',
  'Lightning claims spike in summer',
  'Water damage claims rise',
  'Claims assessors sent to Lismore',
  'Loss adjusters sent after hailstorm claims',
  'Claims denied after floodwater entered'
].forEach((t) => {
  ck('insurance: ' + t.slice(0, 44),
    classify(t, 'abc.net.au', 'ABC News').includes('insurance'),
    classify(t, 'abc.net.au', 'ABC News'));
});

console.log('\n== but "claims" also means "kills", and a peril makes that likely ==');
/* The trap that comes with restoring the perils. A peril plus a death toll
   is a casualty report, not an insurance story, and every one of these has
   both. The fatality sense always attaches the claim to a person or a life,
   which is what the veto keys on -- so it does not touch "Flood claims
   surge", where the claims are the subject rather than the object. */
[
  'Fire claims three lives',
  'Floods claim two lives in northern NSW',
  'Storm claimed the life of a Sydney man',
  'Bushfire claims a firefighter',
  'Cyclone claims two victims',
  'Heatwave claims elderly residents',
  'Crash claims the life of a motorist'
].forEach((t) => {
  ck('not insurance: ' + t.slice(0, 44),
    !classify(t, 'abc.net.au', 'ABC News').includes('insurance'),
    classify(t, 'abc.net.au', 'ABC News'));
});

console.log('\n== lines of cover and affordability ==');
[
  'Premiums rise 15% for Queensland homeowners',
  'Health premiums jump again in April',
  'Strata premiums double in flood zones',
  'Motor premiums climb as repair costs bite',
  'Northern Australia premiums remain unaffordable',
  'Household claims rise sharply',
  'Car claims take longer to settle'
].forEach((t) => {
  ck('insurance: ' + t.slice(0, 44),
    classify(t, 'abc.net.au', 'ABC News').includes('insurance'),
    classify(t, 'abc.net.au', 'ABC News'));
});

console.log('\n== and the ordinary senses of both words stay out ==');
[
  'Qantas expands premium economy',
  'Woolworths launches premium own-brand range',
  'Premium fuel prices hit record',
  'Premium Bonds winners announced',
  'Premium wine exports to China rebound',
  'Man claims he was assaulted',
  'Police claim offender fled',
  'Teen claims victory at nationals',
  'Minister claims budget is balanced',
  'Group claims responsibility for attack'
].forEach((t) => {
  ck('not insurance: ' + t.slice(0, 44),
    !classify(t, 'abc.net.au', 'ABC News').includes('insurance'),
    classify(t, 'abc.net.au', 'ABC News'));
});

ck('a trade headline with no support is caught by the publisher',
  classify('Claims bill tops $1bn', 'insurancenews.com.au', 'insuranceNEWS').includes('insurance'));

console.log('\n== other outlets are unaffected ==');
ck('an ABC bushfire story is bushfire and nothing else',
  JSON.stringify(classify('Bushfire warning for the Blue Mountains', 'abc.net.au', 'ABC News'))
    === JSON.stringify(['bushfire']),
  classify('Bushfire warning for the Blue Mountains', 'abc.net.au', 'ABC News'));
ck('an ordinary story with no keywords stays untagged',
  classify('Council approves new library for Eaglehawk', 'bendigoadvertiser.com.au', 'Bendigo Advertiser').length === 0);
ck('a genuine insurance keyword still works from any outlet',
  classify('Insurance claims rejected after storm', 'abc.net.au', 'ABC News').includes('insurance'));

console.log('\n== the Illawarra regression stays fixed ==');
/* "war" inside "Illawarra" used to tag every Illawarra Mercury story World. */
ck('Illawarra is not World news',
  !classify('Illawarra Mercury reports on council budget', 'illawarramercury.com.au', 'Illawarra Mercury')
    .includes('world'));

console.log('\n== missing inputs do not throw ==');
ck('no domain or source', Array.isArray(classify('A headline')));
ck('null throughout', Array.isArray(classify(null, null, null)));
ck('empty title', classify('', IN, 'insuranceNEWS').includes('insurance'));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
