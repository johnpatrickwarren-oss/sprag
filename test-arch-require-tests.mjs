// Self-contained test for the `require_tests` check (the deterministic shadow of TDD): flags source
// modules under `dirs` that have no corresponding test (base-name match, layout-agnostic). Proves it
// passes a tested module, blocks an untested one, excludes barrel index files, and honors suppression.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-rt-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'require-tests', intent: 'every source module has a test', check: { kind: 'require_tests', dirs: ['src'] }, max: 0, mode: 'ratchet', severity: 'block' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'arch-rt-')); mkdirSync(join(d, 'src')); return d; };

// 1. a module WITH a co-located test -> PASS
{ const d = mk();
  writeFileSync(join(d, 'src', 'foo.ts'), 'export const foo = () => 1;\n');
  writeFileSync(join(d, 'src', 'foo.test.ts'), "import {foo} from './foo';\ntest('foo', () => { assert.equal(foo(), 1); });\n");
  const r = gate(d); expect('tested module PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 2. an UNTESTED module -> BLOCKED (test may live anywhere, but none covers bar)
{ const d = mk();
  writeFileSync(join(d, 'src', 'bar.ts'), 'export const bar = () => 2;\n');
  const r = gate(d); expect('untested module BLOCKED', r.code === 3 && /✗ \[require-tests\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 3. a barrel index.ts with no test is EXCLUDED (re-exports, nothing to test) -> PASS
{ const d = mk();
  writeFileSync(join(d, 'src', 'index.ts'), "export * from './x';\n");
  const r = gate(d); expect('barrel index.ts excluded (PASS)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 4. suppression: an untested module with `anchor:allow` is NOT counted
{ const d = mk();
  writeFileSync(join(d, 'src', 'bar.ts'), '// anchor:allow require-tests: legacy module, tracked in #99\nexport const bar = () => 2;\n');
  const r = gate(d); expect('suppressed untested module NOT counted', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: require_tests passes tested modules, blocks untested, excludes barrels, honors suppression ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
