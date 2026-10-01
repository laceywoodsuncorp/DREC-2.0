/* How articles are tagged into category chips.

   The old matcher matched a bare prefix with a word boundary on the left
   only, so almost nothing landed in the right chip:

     "war"    matched "warning"      -> every weather warning was World news
     "hail"   matched "hailed"       -> a firefighter hailed a hero was a hailstorm
     "polic"  matched "policy"       -> housing policy was Crime
     "insur"  matched "insurrection" -> insurrection charges were Insurance
     "swim"   matched "swimmer"      -> a drowning was Sport
     "storm"  matched Melbourne Storm -> an NRL result was a weather event
     "claim"  matched any claim      -> studies and confessions were Insurance

   Every headline below is the kind these outlets actually publish, and each
   one was tagged wrongly before. Run: node test/classify.test.mjs */
import { readFileSync } from 'node:fs';

/* Lifted from the page so this exercises what ships, not a copy of it. */
const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
/* The end marker is searched for AFTER the start marker, not from the top of
   the file -- looking for the first "\n\n" anywhere found one in the <head>
   and sliced away the regex this needs. */
const slice = (from, to) => {
  const i = page.indexOf(from);
  if (i < 0) throw new Error('not found in page: ' + from);
  const j = page.indexOf(to, i + from.length);
  if (j < 0) throw new Error('end marker not found after ' + from);
  return page.slice(i, j);
};
const src = slice('const CAT_RULES={', 'const CAT_LABEL=')
  + slice('const FIRE_REGEX=', '\n\n')
  + slice('function classify(title,summary){', 'function readCache')
  + '; return classify;';
const classify = new Function(src)();

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
/* `want` must all be present; `notWant` must all be absent. */
const tag = (headline, want, notWant, summary) => {
  const got = classify(headline, summary);
  const missing = (want || []).filter(c => !got.includes(c));
  const wrong = (notWant || []).filter(c => got.includes(c));
  check(headline.slice(0, 62), !missing.length && !wrong.length,
    { got, missing, wrong });
};

console.log('== a word boundary on both ends ==');
tag('Severe weather warning issued for coastal NSW', ['flood'], ['world']);
tag('Police warn of scam targeting elderly residents', ['crime'], ['world']);
tag('Firefighter hailed a hero after rescuing family from blaze', ['fire'], ['flood']);
tag('New housing policy announced by Premier', ['politics'], ['crime']);
tag('Insurrection charges laid in US court', ['crime'], ['insurance']);
tag('Swimmer drowns at Bondi Beach', [], ['sport']);
tag('Warm weather forecast for the weekend', [], ['world']);

console.log('\n== a firefighter story with no "fire" in it ==');
/* "Firefighter" contains "fire" but \b(fire|blaze)\b correctly will not match
   inside it, so a rescue headline that never says the word was landing in
   General. A firefighter pulling a family out is a fire incident. */
tag('Firefighter hailed a hero after rescuing family', ['fire'], []);
tag('Firefighter trapped as roof collapses', ['fire'], []);
/* But not every firefighter story is an incident. */
tag('Firefighters rally outside parliament over pay', ['politics'], ['fire']);

console.log('\n== the Melbourne Storm is not a weather event ==');
tag('Melbourne Storm beat Panthers in grand final thriller', ['sport'], ['flood']);
tag('Storm thrash Roosters to seal top spot', ['sport'], ['flood']);
/* And the veto must not swallow real weather. */
tag('Storm damage closes roads across the Hunter', ['flood'], ['sport']);
tag('Thunderstorms bring flash flooding to Brisbane', ['flood'], ['sport']);

console.log('\n== an ambiguous word needs corroborating ==');
tag('Study claims coffee reduces risk of disease', ['health'], ['insurance']);
tag('Man claims responsibility for graffiti spree', [], ['insurance']);
tag('Insurance claims surge after hailstorm', ['insurance', 'flood'], []);
tag('Claims payout delays frustrate flood victims', ['insurance', 'flood'], []);
tag('IAG lifts premiums as catastrophe costs climb', ['insurance'], []);

console.log('\n== a strike is not automatically politics ==');
tag('Air strike kills civilians in Gaza', ['world'], ['politics']);
tag('Lightning strike sparks grassfire near Dubbo', ['bushfire'], ['politics']);
tag('Nurses strike over pay and staffing', ['politics'], []);
tag('Industrial action halts rail services', ['politics'], []);

console.log('\n== house fire against bushfire ==');
tag('Family escapes as fire guts Melbourne home', ['fire'], ['bushfire']);
tag('Bushfire threatens homes near Bega, residents told to evacuate', ['bushfire'], ['fire']);
tag('Total fire ban declared across three districts', ['bushfire'], ['fire']);

console.log('\n== the summary helps when the headline is coy ==');
/* Headlines are written to intrigue. The subject is often only in the
   standfirst, which is why it is read too. */
tag('“We lost everything in minutes”', ['fire'],
  [], 'A house fire destroyed the family home in Geelong overnight, with firefighters called just after 2am.');
/* But a strong term in a summary alone must not promote: an aside about
   China in paragraph one does not make a local story World news. */
tag('Council approves new childcare centre', [], ['world'],
  'The mayor said the design was inspired by a visit to China last year.');

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
