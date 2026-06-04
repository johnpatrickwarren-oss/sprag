// test_file_weakened: per-file anti-gaming. Catches a strong-for-weak SWAP within a test file (or skip/trim)
// even when net test signal GROWS (offset by new tests) — the gap the net test_signal floor permits.
// Git-based: compares each tracked test file's active signal in the working tree vs HEAD.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const INV = mkdtempSync(join(tmpdir(), 'tfw-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-test-file-weakening', intent: 'no test file may weaken', check: { kind: 'test_file_weakened', dirs: ['.'] }, max: 0, severity: 'block' }]));
const STRONG = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('f', () => { assert.equal(f(1), 1); assert.equal(f(2), 2); });\n";
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'tfw-'));
  execFileSync('git', ['-C', d, 'init', '-q']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 'x@x']); execFileSync('git', ['-C', d, 'config', 'user.name', 'x']);
  writeFileSync(join(d, 'f.mjs'), 'export const f = (x) => x;\n');
  writeFileSync(join(d, 'f.test.mjs'), STRONG);
  execFileSync('git', ['-C', d, 'add', '-A']); execFileSync('git', ['-C', d, 'commit', '-qm', 'seed']);
  return d;
}
const gate = (d) => { const r = spawnSync('node', [GATE, d, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

// BLOCK: trim f.test.mjs (signal drops) WHILE adding a new test file (net signal GROWS) -> caught per-file.
{ const d = repo();
  writeFileSync(join(d, 'f.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('f', () => { assert.equal(f(1), 1); });\n"); // dropped an assertion
  writeFileSync(join(d, 'g.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('g1', () => { assert.ok(1); });\ntest('g2', () => { assert.ok(1); });\n"); // new -> net grows
  const r = gate(d); expect('per-file weakening BLOCKED even when net signal grows', r.code === 3 && /no-test-file-weakening/.test(r.out), `exit ${r.code}: ${r.out}`); }

// PASS: f.test.mjs unchanged + a new test added -> no file weakened.
{ const d = repo();
  writeFileSync(join(d, 'g.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('g', () => { assert.ok(1); });\n");
  const r = gate(d); expect('adding tests without weakening any file PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: test_file_weakened catches a per-file strong-for-weak swap the net floor permits ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
