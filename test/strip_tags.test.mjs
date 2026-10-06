/* stripTags is the chokepoint every agency's text passes through on its way
   to the dashboard, and it had its two steps the wrong way round.

   It removed tags first and decoded entities second. A feed that encodes its
   markup therefore had nothing to strip on the first pass, and then had live
   markup built for it on the second. Measured on the live service, Tasmania's
   alert level was the string "Informational<br>" -- the tag was never in the
   XML as a tag, it was "&lt;br&gt;", and this function assembled it.

   Run: node test/strip_tags.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const m = /function stripTags\(html\) \{[\s\S]*?\n\}/.exec(src);
if (!m) { console.log('FAIL could not find stripTags in src/worker.js'); process.exit(1); }
const stripTags = new Function(m[0] + '; return stripTags;')();

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + JSON.stringify(got)
    + '\n         want ' + JSON.stringify(want)); }
};

console.log('== entity-encoded markup is removed, not assembled ==');
eq('the Tasmania case', stripTags('Informational&lt;br&gt;'), 'Informational');
eq('encoded tag mid-string', stripTags('Advice&lt;br&gt;and act'), 'Advice and act');
eq('encoded block tag', stripTags('&lt;p&gt;Watch and Act&lt;/p&gt;'), 'Watch and Act');

console.log('\n== real markup is still removed ==');
eq('a plain tag', stripTags('Watch and Act<br>'), 'Watch and Act');
eq('wrapping tags', stripTags('<b>Emergency</b> Warning'), 'Emergency Warning');
eq('an attribute with a bracket', stripTags('<a href="?a=1&b=2">Advice</a>'), 'Advice');

console.log('\n== entities that are meant to survive, do ==');
eq('an ampersand', stripTags('Advice &amp; prepare'), 'Advice & prepare');
eq('a quote', stripTags('&quot;Advice&quot;'), '"Advice"');
/* A doubly-encoded entity is a feed escaping the text "&lt;br&gt;" on
   purpose. Decoding it one step is right; turning it into a tag is not, and
   is why &amp; is decoded after the bracket entities rather than before. */
eq('double encoding stays text', stripTags('&amp;lt;br&amp;gt;'), '&lt;br&gt;');

console.log('\n== ordinary text is untouched ==');
eq('plain text', stripTags('Emergency Warning'), 'Emergency Warning');
eq('whitespace collapses', stripTags('Watch   and\n\nAct'), 'Watch and Act');
eq('empty', stripTags(''), '');

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
