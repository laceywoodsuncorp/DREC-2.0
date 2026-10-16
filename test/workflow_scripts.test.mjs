/* Inline scripts in the workflows that a stray apostrophe would break.

   Several workflow steps run Node as a single-quoted shell argument:

     node -e '
       ...javascript...
     '

   Any apostrophe inside ends the quote. The rest of the script is then
   read as shell, and the step fails at RUN time -- `bash -n` passes it,
   because "//" is a perfectly valid command name until something tries to
   execute it. That is what happened on 16 October: a comment saying
   "GitHub's own schedule" broke the live check's cron step, so for the
   whole afternoon it printed the build and died before reporting whether
   the Worker was dispatching outage captures -- the one thing it had just
   been extended to report. The fix's own warning comment then repeated
   the mistake, which is the case for a test rather than care.

   Run: node test/workflow_scripts.test.mjs */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const ck = (n, c, e) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')); }
};

const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
let blocks = 0;
for (const f of files) {
  const text = readFileSync(new URL(f, dir), 'utf8');
  /* node -e ' ... ' spanning lines, closed by a line holding only the quote. */
  const re = /node -e '\n([\s\S]*?)\n\s*'\s*\n/g;
  let m;
  while ((m = re.exec(text))) {
    blocks++;
    const lines = m[1].split('\n');
    const offenders = lines.map((l, i) => ({ i, l: l.trim() })).filter((x) => x.l.includes("'"));
    ck(f + ': single-quoted node script #' + blocks + ' has no apostrophe',
      offenders.length === 0, offenders.map((x) => x.l.slice(0, 90)));
  }
}
ck('the scan found the inline scripts it is meant to guard', blocks >= 2, blocks);

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
