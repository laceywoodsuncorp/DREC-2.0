/* The ABS disambiguates a repeated locality name with a suffix, and it uses
   three different forms. The gazetteer builder only stripped one of them,
   which left ordinary towns unreachable by an exact lookup -- and an outage
   whose town cannot be placed simply never appears on the map, which looks
   exactly like no outage.

   Measured against the live feeds, these were among the unplaced:

     LONGFORD   TAS   the gazetteer holds "LONGFORD (TAS.)"
     COLO       NSW   holds "COLO (HAWKESBURY - NSW)"
     RED HILL   QLD   holds "RED HILL (BRISBANE - QLD)"
     PRESTON    QLD   holds "PRESTON (LOCKYER VALLEY - QLD)"

   The state is its own column in the data, so all three suffix forms are
   noise. Only a recognised state code is accepted at the end of the bracket,
   so a name that genuinely ends in brackets is left alone.

   The regex is read out of scripts/build-gazetteer.mjs rather than restated
   here, so this tests the shipped code.

   Run: node test/gazetteer_names.test.mjs */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../scripts/build-gazetteer.mjs', import.meta.url), 'utf8');
const m = /const STATE_SUFFIX = [\s\S]*?\.trim\(\);/.exec(src);
if (!m) { console.log('FAIL could not find the suffix stripper in build-gazetteer.mjs'); process.exit(1); }
const strip = new Function('rawName', m[0] + '\n return name;');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  if (got === want) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got)
    + '\n         want ' + JSON.stringify(want)); }
};

console.log('== the form that was already handled ==');
eq(strip('CROMER (NSW)'), 'CROMER', 'bare state code');
eq(strip('CROWS NEST (QLD)'), 'CROWS NEST', 'bare state code, two words');

console.log('\n== the form with a full stop, which was not ==');
eq(strip('LONGFORD (TAS.)'), 'LONGFORD', 'LONGFORD (TAS.)');
eq(strip('NORTH SHORE (VIC.)'), 'NORTH SHORE', 'NORTH SHORE (VIC.)');

console.log('\n== the LGA form, which was not handled at all ==');
eq(strip('RED HILL (BRISBANE - QLD)'), 'RED HILL', 'RED HILL (BRISBANE - QLD)');
eq(strip('COLO (HAWKESBURY - NSW)'), 'COLO', 'COLO (HAWKESBURY - NSW)');
eq(strip('PRESTON (LOCKYER VALLEY - QLD)'), 'PRESTON', 'PRESTON (LOCKYER VALLEY - QLD)');
eq(strip('COLO (BATHURST REGIONAL - NSW)'), 'COLO', 'an LGA of three words');

console.log('\n== names that must be left exactly as they are ==');
eq(strip('TOOWOOMBA CITY'), 'TOOWOOMBA CITY', 'a suburb-level name');
eq(strip('MOUNT ISA'), 'MOUNT ISA', 'no suffix at all');
eq(strip('WAGGA WAGGA'), 'WAGGA WAGGA', 'a repeated word');
/* The suffix is only noise when it names a state. Anything else in brackets
   is part of the name and stripping it would invent a different place. */
eq(strip('BULLS (NOT A STATE)'), 'BULLS (NOT A STATE)', 'brackets that are not a state');
eq(strip('THE GAP (FAR NORTH)'), 'THE GAP (FAR NORTH)', 'a bracketed qualifier that is not a state');

console.log('\n----------------------------------------');
console.log('passed: ' + pass + '   failed: ' + fail);
process.exit(fail ? 1 : 0);
