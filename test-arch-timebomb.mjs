// Self-contained test for the `time_bomb_tests` check: flags tests that invoke git against a FROZEN
// ref (pinned SHA / `..HEAD` / `--name-only` / `git show <sha>`) — they can only rot. Proves it flags
// the rot pattern, is PRECISE (a product SHA-256 hash test that never touches git is NOT flagged), and
// is suppression-aware.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-tb-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-time-bomb-tests', intent: 'no frozen-ref tests', check: { kind: 'time_bomb_tests', dirs: ['test'] }, max: 0, mode: 'ratchet', severity: 'block' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'arch-tb-')); mkdirSync(join(d, 'test')); return d; };

// 1. clean product test + a product SHA-256 hash test (no git) -> PASS (precision: hashes != time-bombs)
{ const d = mk();
  writeFileSync(join(d, 'test', 'a.test.ts'), `import {test} from 'node:test';\ntest('math', () => { assert.equal(2+2, 4); });\n`);
  writeFileSync(join(d, 'test', 'hash.test.ts'), `import {test} from 'node:test';\n// FIPS vector\ntest('sha256', () => { assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); });\n`);
  const r = gate(d); expect('clean + product-hash tests PASS (no false positive)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 2. a frozen-ref anti-scope test (git diff <SHA>..HEAD --name-only) -> BLOCKED
{ const d = mk();
  writeFileSync(join(d, 'test', 'antiscope.test.ts'),
    `import {test} from 'node:test';\nimport {execSync} from 'node:child_process';\nconst ROUND_START_SHA = '9e24aa4';\n`
    + `test('anti-scope', () => { const f = execSync(\`git diff \${ROUND_START_SHA} HEAD --name-only\`); assert.deepEqual(f, []); });\n`);
  const r = gate(d); expect('frozen-ref anti-scope test BLOCKED', r.code === 3 && /✗ \[no-time-bomb-tests\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 3. suppression: the same time-bomb with `anchor:allow` is NOT counted
{ const d = mk();
  writeFileSync(join(d, 'test', 'antiscope.test.ts'),
    `import {test} from 'node:test';\nimport {execSync} from 'node:child_process';\n// anchor:allow no-time-bomb-tests: legacy round gate, tracked in #123\nconst SHA = '9e24aa4';\n`
    + `test('anti-scope', () => { execSync(\`git diff \${SHA}..HEAD --name-only\`); });\n`);
  const r = gate(d); expect('suppressed time-bomb NOT counted', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 4. L7: Go and Python test-naming conventions are seen too (was JS-family-only -> silent 0)
{ const d = mk();
  writeFileSync(join(d, 'test', 'scope_test.go'),
    'package scope\n\nimport "os/exec"\n\nconst roundSHA = "9e24aa4aa"\n\nfunc TestAntiScope(t *testing.T) {\n\texec.Command("bash", "-c", "git diff " + roundSHA + "..HEAD --name-only").Run()\n}\n');
  const r = gate(d); expect('frozen-ref _test.go BLOCKED (Go convention seen)', r.code === 3 && /✗ \[no-time-bomb-tests\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const d = mk();
  writeFileSync(join(d, 'test', 'test_scope.py'),
    'import subprocess\n\nROUND_SHA = "9e24aa4aa"\n\ndef test_anti_scope():\n    subprocess.run("git diff " + ROUND_SHA + "..HEAD --name-only", shell=True)\n');
  const r = gate(d); expect('frozen-ref test_*.py BLOCKED (Python convention seen)', r.code === 3 && /✗ \[no-time-bomb-tests\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: time_bomb_tests flags frozen-ref tests, ignores product hashes, honors suppression ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
