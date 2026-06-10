// Self-contained test for `mutate.mjs` (mutation testing). The point: it measures test EFFICACY, not
// count or coverage. A STRONG suite that asserts behavior kills the mutants (PASS); a WEAK suite that
// *executes* the code but asserts nothing — coverage theater, the exact Anchor "2x tests, no better"
// trap — lets every mutant SURVIVE (BLOCKED), even though it's a passing test with full line coverage.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

// 3. --exclude: a non-source FIXTURE file (untested, so its mutants survive) is skipped, so the score
//    reflects only the real module. Without the exclude the fixture drags the score down -> BLOCKED;
//    with it, the strong suite scores 100% -> PASS. This is what lets mutate run on a repo that holds
//    test fixtures or uses a test-naming convention the .test./.spec. heuristic misses.
{ const d = mk(
  `import { test } from 'node:test'; import assert from 'node:assert/strict';\n`
  + `import { ge, both, flag } from './m.mjs';\n`
  + `test('ge', () => { assert.equal(ge(2, 2), true); assert.equal(ge(1, 2), false); });\n`
  + `test('both', () => { assert.equal(both(true, false), false); assert.equal(both(true, true), true); });\n`
  + `test('flag', () => { assert.equal(flag(), true); });\n`);
  writeFileSync(join(d, 'fixture.mjs'), 'export const x = (a, b) => a >= b && b === 1;\n'); // untested source
  const without = mutate(d);
  expect('without --exclude, untested fixture drags score down -> BLOCKED', without.code === 3, `exit ${without.code}: ${without.out}`);
  const withExc = mutate(d, ['--exclude', 'fixture.mjs']);
  expect('with --exclude fixture.mjs, only the tested module is mutated -> PASS 100%', withExc.code === 0 && /PASS: mutation score 100%/.test(withExc.out), `exit ${withExc.code}: ${withExc.out}`); }

// 4. --since with an UNRESOLVABLE ref fails loudly (exit 64) instead of silently reporting "nothing to
//    mutate" and passing. A gate that green-lights because git couldn't resolve the base (the classic
//    CI mistake of diffing an unfetched `origin/<base>`) is worse than no gate.
{ const d = mkdtempSync(join(tmpdir(), 'arch-mut-git-'));
  const git = (...a) => spawnSync('git', a, { cwd: d });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(d, 'm.mjs'), MOD); writeFileSync(join(d, 'm.test.mjs'), 'test\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  const r = spawnSync('node', [MUT, d, '--test', 'true', '--since', 'no-such-ref', '--cwd', d], { encoding: 'utf8' });
  expect('--since with an unresolvable ref fails loudly (exit 64), not a silent pass', r.status === 64 && /failed/.test(r.stdout + r.stderr), `exit ${r.status}: ${r.stdout}${r.stderr}`); }

// 5. Dir scoping is PATH-CORRECT: (a) scoping to <repo>/src must NOT leak sibling dirs that share
//    the raw string prefix (src-other/); (b) a symlinked invocation path (macOS tmpdir lives under
//    the /var -> /private/var symlink, while git rev-parse realpaths) must still match — not silently
//    report "nothing to mutate" and exit 0 (a no-op gate).
{ const d = mkdtempSync(join(tmpdir(), 'arch-mut-scope-')); // un-realpathed (symlinked on macOS)
  const git = (...a) => spawnSync('git', a, { cwd: d });
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'src-other'));
  writeFileSync(join(d, 'src', 'a.mjs'), 'export const a = (x, y) => x >= y;\n');
  writeFileSync(join(d, 'src-other', 'b.mjs'), 'export const b = (x, y) => x && y;\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'init');
  writeFileSync(join(d, 'src', 'a.mjs'), 'export const a = (x, y) => x >= y && x !== 0;\n');
  writeFileSync(join(d, 'src-other', 'b.mjs'), 'export const b = (x, y) => x && y && x !== 0;\n');
  const r = spawnSync('node', [MUT, join(d, 'src'), '--since', 'HEAD', '--test', 'true', '--cwd', d], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  expect('dir scope through a symlinked path still finds the changed files (no silent no-op)',
    !/no changed source files/.test(out) && /across 1 file\(s\)/.test(out), `exit ${r.status}: ${out}`);
  expect('dir scope does NOT leak the sibling src-other/ (separator-boundary match)',
    !/src-other/.test(out), `exit ${r.status}: ${out}`); }

console.log(failed === 0 ? '\nPASS: mutation testing gates on EFFICACY — kills-bugs, not test count/coverage ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
