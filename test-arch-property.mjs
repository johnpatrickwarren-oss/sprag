// Self-contained test for `arch property` — the deterministic acceptance gate that makes an
// AI-authored (or human-authored) invariant trustworthy WITHOUT trusting the author: accept a property
// only if it HOLDS on the current code AND CATCHES BUGS (kills mutants). A strong property is accepted;
// a tautological/weak one is rejected; one that doesn't hold is rejected (wrong, or a real bug).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROP = join(HERE, 'property.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

// a tiny "implementation under test" with a mutable boundary operator (>=)
const d = mkdtempSync(join(tmpdir(), 'arch-prop-'));
mkdirSync(join(d, 'src'));
writeFileSync(join(d, 'src', 'age.js'), 'export const isAdult = (age) => age >= 18;\n');
const propFile = (name, body) => { writeFileSync(join(d, name), `import { isAdult } from './src/age.js';\nprocess.exit(${body} ? 0 : 1);\n`); return `node ${name}`; };

const strong = propFile('p-strong.mjs', 'isAdult(18) === true && isAdult(17) === false'); // pins the boundary -> kills `>=`->`>`
const weak = propFile('p-weak.mjs', "typeof isAdult(20) === 'boolean'");                   // always true -> survives every mutant
const wrong = propFile('p-wrong.mjs', 'isAdult(17) === true');                              // false on current code

const run = (cmd) => { const r = spawnSync('node', [PROP, d, '--prop', cmd, '--target', join(d, 'src'), '--min-kill', '50', '--all'], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

{ const r = run(strong);
  expect('strong property (holds + kills the boundary mutant) ACCEPTED', r.code === 0 && /ACCEPT/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const r = run(weak);
  expect('weak/tautological property (survives mutants) REJECTED', r.code === 3 && /too weak|tautolog/i.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const r = run(wrong);
  expect('property that does not hold REJECTED (wrong, or real bug)', r.code === 3 && /does not hold/i.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: arch property accepts strong invariants, rejects weak/tautological + non-holding ones ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
