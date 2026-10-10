/* The category set, its order, and the two second-level filters.

   The chips are asserted in order because the order was specified and a
   reordering is otherwise invisible until someone looks at the page. The
   rest covers the five new categories and the sub-filters, including the
   cases that were wrong when they were first built.

   Run: node test/categories.test.mjs */
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../index_updated_abc_emergency_map.html', import.meta.url), 'utf8');
const grab = (re, what) => {
  const m = re.exec(page);
  if (!m) throw new Error('not found in the page: ' + what);
  return m[0];
};
const base = [
  grab(/const CAT_KEYWORDS=\{[\s\S]*?\n  \};/, 'CAT_KEYWORDS'),
  grab(/const CRIME_VETO=[^\n]*\n/, 'CRIME_VETO'),
  grab(/const POLITICS_VETO=[^\n]*\n/, 'POLITICS_VETO'),
  grab(/const AMBIGUOUS_RE=[\s\S]*?const CLAIM_FATALITY_RE=[^\n]*\n/, 'ambiguous rules'),
  grab(/const FIRE_REGEX=[\s\S]*?;\n/, 'FIRE_REGEX'),
  grab(/const kwMatchers=\{\};/, 'kwMatchers'),
  grab(/function keywordHit\(text,kw\)\{[\s\S]*?\n  \}/, 'keywordHit'),
  grab(/const SOURCE_CATS=\[[\s\S]*?\n  \];/, 'SOURCE_CATS'),
  grab(/function hostOf\(v\)\{[\s\S]*?\n  \}/, 'hostOf'),
  grab(/function sourceCats\(domain,source\)\{[\s\S]*?\n  \}/, 'sourceCats'),
  grab(/const SUBCATS=\{[\s\S]*?\n  \};/, 'SUBCATS'),
  grab(/function subsFor\(title\)\{[\s\S]*?\n  \}/, 'subsFor'),
  grab(/const CAT_LABEL=\{[\s\S]*?\n    health[^\n]*\n/, 'CAT_LABEL'),
  grab(/function classify\(title,domain,source\)\{[\s\S]*?\n  \}/, 'classify')
].join('\n');
const classify = new Function(base + '; return classify;')();
const subsFor = new Function(base + '; return subsFor;')();
const SUBCATS = new Function(base + '; return SUBCATS;')();
const CAT_LABEL = new Function(base + '; return CAT_LABEL;')();

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};
const cat = (t, c) => classify(t, 'abc.net.au', 'ABC News').includes(c);
const sub = (t, s) => subsFor(t).includes(s);

console.log('== the chips, in the order they were asked for ==');
const order = [...page.matchAll(/data-cat="([^"]+)"/g)].map((m) => m[1]);
const want = ['all', 'insurance', 'fire', 'bushfire', 'flood', 'peril', 'environment', 'ai',
  'politics', 'economy', 'roads', 'crime', 'health', 'sport', 'world'];
ck('order matches', JSON.stringify(order) === JSON.stringify(want), { got: order, want });
/* A chip with no label renders as its raw key, which looks like a bug. */
ck('every chip has a label',
  order.filter((c) => c !== 'all').every((c) => !!CAT_LABEL[c]),
  order.filter((c) => c !== 'all' && !CAT_LABEL[c]));

console.log('\n== the five new categories ==');
[['Hailstorm smashes Toowoomba', 'peril'],
 ['Magnitude 5.2 earthquake near Broome', 'peril'],
 ['Coral bleaching worsens on Great Barrier Reef', 'environment'],
 ['Bird flu detected at Victorian egg farm', 'environment'],
 ['Net zero target under review', 'environment'],
 ['Nvidia unveils new GPU for AI training', 'ai'],
 ['Data centre approved for western Sydney', 'ai'],
 ['ChatGPT maker OpenAI raises funding', 'ai'],
 ['Road toll climbs after fatal crash on the Hume', 'roads'],
 ['Motorcyclist dies in collision near Dubbo', 'roads']
].forEach(([t, c]) => ck(c + ': ' + t.slice(0, 44), cat(t, c), classify(t, 'abc.net.au', '')));

console.log('\n== and what they must not swallow ==');
/* "ai" is two letters, so it has to be a whole word or it matches inside
   ordinary ones. "crash" is a market crash and a plane crash on this feed,
   which is why roads is almost entirely phrases. */
ck('"rain" is not AI', !cat('Rain expected across the state', 'ai'));
ck('"said" is not AI', !cat('He said it would rain', 'ai'));
ck('a market crash is not a road accident', !cat('Market crash wipes billions', 'roads'));
ck('a plane crash is not a road accident', !cat('Three killed in light plane crash', 'roads'));

console.log('\n== floods and perils are now separate ==');
ck('a flood is a flood', cat('Flood warning upgraded for the Macquarie', 'flood'));
ck('and not a peril', !cat('Flood warning upgraded for the Macquarie', 'peril'));
ck('a hailstorm is a peril', cat('Hailstorm smashes Toowoomba', 'peril'));
ck('and not a flood', !cat('Hailstorm smashes Toowoomba', 'flood'));

console.log('\n== the peril sub-filter ==');
[['Hailstorm smashes Toowoomba', 'peril:hail'],
 ['Magnitude 5.2 earthquake near Broome', 'peril:earthquake'],
 ['Cyclone Alfred crosses the coast', 'peril:cyclone'],
 ['Mudslide closes Great Ocean Road', 'peril:landslide'],
 ['Heatwave grips Adelaide', 'peril:heatwave'],
 ['Severe thunderstorm warning issued', 'peril:storm'],
 ['Tsunami warning cancelled', 'peril:tsunami'],
 ['Drought declared across the Riverina', 'peril:drought']
].forEach(([t, k]) => ck(k + ': ' + t.slice(0, 40), sub(t, k), subsFor(t)));
ck('every peril option has a label', SUBCATS.peril.options.every((o) => o[0] && o[1] && o[2].length));

console.log('\n== the politics sub-filter ==');
[['Albanese dips toe back into comedy', 'politics:au'],
 ['Dutton announces nuclear policy', 'politics:au'],
 ['Greens push for rent freeze', 'politics:au']
].forEach(([t, k]) => ck(k + ': ' + t.slice(0, 40), sub(t, k) && cat(t, 'politics'), subsFor(t)));
/* These reached neither the category nor the filter when it was first
   built: the politics list was Australia-only, so "Starmer faces Commons
   revolt" and "Putin meets Xi Jinping" matched nothing at all and the
   Global option had nothing to show. */
[['Trump signs executive order at the White House', 'politics:global'],
 ['Starmer faces Commons revolt', 'politics:global'],
 ['Putin meets Xi Jinping in Beijing', 'politics:global'],
 ['NATO summit agrees new target', 'politics:global']
].forEach(([t, k]) => ck(k + ': ' + t.slice(0, 40), sub(t, k) && cat(t, 'politics'), {
  cats: classify(t, 'abc.net.au', ''), subs: subsFor(t) }));

console.log('\n== sport, which was missing most of the back page ==');
[
  'Matildas qualify for World Cup', 'Wallabies name squad for spring tour',
  'Melbourne Cup favourite scratched', 'Bowler takes five wickets at the MCG',
  'AFLW grand final sells out', 'Socceroos draw with Japan',
  'Opals win bronze at the Olympics', 'State of Origin decider in Brisbane',
  'Jockey suspended after protest', 'Supercars round moves to Adelaide'
].forEach((t) => ck('sport: ' + t.slice(0, 44), cat(t, 'sport'), classify(t, 'abc.net.au', '')));

console.log('\n== sport words that are something else elsewhere ==');
/* Left out of the list on purpose: a medical test, the ashes a bushfire
   leaves, a policy goal, a bus coach, a nightclub, an election victory. */
ck('a medical test is not sport', !cat('Blood test shortage hits clinics', 'sport'));
ck('bushfire ashes are not sport', !cat('Residents return to ashes after bushfire', 'sport'));
ck('a policy goal is not sport', !cat('Government sets emissions goal', 'sport'));
ck('an election victory is not sport', !cat('Labor claims victory in Werriwa', 'sport'));

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
