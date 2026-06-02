// Self-contained test for `mutate.mjs` (mutation testing). The point: it measures test EFFICACY, not
// count or coverage. A STRONG suite that asserts behavior kills the mutants (PASS); a WEAK suite that
// *executes* the code but asserts nothing — coverage theater, the exact Anchor "2x tests, no better"
// trap — lets every mutant SURVIVE (BLOCKED), even though it's a passing test with full line coverage.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const MUT = join(HERE, 'mutate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const MOD = 'export const ge = (a, b) => a >= b;\nexport const both = (a, b) => a && b;\nexport const flag = () => true;\n';
const mk = (testBody) => {
  const d = mkdtempSync(join(tmpdir(), 'arch-mut-'));
  writeFileSync(join(d, 'm.mjs'), MOD);
  writeFileSync(join(d, 'm.test.mjs'), testBody);
  return d;
};
const mutate = (d, extra = []) => {
  const r = spawnSync('node', [MUT, d, '--test', 'node --test m.test.mjs', '--all', '--cwd', d, '--threshold', '60', ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

// 1. STRONG suite: asserts behavior at the boundaries -> kills the >=, && and true mutants -> PASS.
{ const d = mk(
  `import { test } from 'node:test'; import assert from 'node:assert/strict';\n`
  + `import { ge, both, flag } from './m.mjs';\n`
  + `test('ge', () => { assert.equal(ge(2, 2), true); assert.equal(ge(1, 2), false); });\n`
  + `test('both', () => { assert.equal(both(true, false), false); assert.equal(both(true, true), true); });\n`
  + `test('flag', () => { assert.equal(flag(), true); });\n`);
  const r = mutate(d);
  expect('strong (asserting) suite kills mutants -> PASS', r.code === 0 && /PASS: mutation score 100%/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 2. WEAK suite: executes every function (full line coverage!) but asserts nothing -> all mutants
//    SURVIVE -> BLOCKED. This is the case a count- or coverage-% gate would wave through.
{ const d = mk(
  `import { test } from 'node:test'; import assert from 'node:assert/strict';\n`
  + `import { ge, both, flag } from './m.mjs';\n`
  + `test('smoke (theater)', () => { ge(1, 2); both(true, true); flag(); assert.ok(true); });\n`);
  const r = mutate(d);
  expect('weak (coverage-only, no-assert) suite -> BLOCKED on low mutation score', r.code === 3 && /mutation score 0%/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: mutation testing gates on EFFICACY — kills-bugs, not test count/coverage ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
