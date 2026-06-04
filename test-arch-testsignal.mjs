// test_signal + floor mode: a "good" signal (active test cases + assertions) that must never DROP below
// baseline — catching the test-gaming require_tests misses (deleting a redundant test, skipping, trimming
// assertions). Mirrors test-arch-fanin's spawn-the-gate style.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const INV = mkdtempSync(join(tmpdir(), 'ts-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-weakened-tests', intent: 'test signal must not drop', check: { kind: 'test_signal', dirs: ['.'] }, mode: 'floor', severity: 'block' }]));
const FULL = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from './f.mjs';\ntest('a', () => { assert.equal(f(1), 1); assert.equal(f(2), 2); });\ntest('b', () => { assert.equal(f(3), 3); });\n`;
const setup = (body) => { const d = mkdtempSync(join(tmpdir(), 'ts-')); writeFileSync(join(d, 'f.mjs'), 'export const f = (x) => x;\n'); writeFileSync(join(d, 'f.test.mjs'), body); return d; };
const baseline = (d) => spawnSync('node', [GATE, d, '--invariants', INV, '--baseline', '--baseline-out', join(d, 'bl.json')], { encoding: 'utf8' });
const gate = (d) => { const r = spawnSync('node', [GATE, d, '--invariants', INV, '--baseline-in', join(d, 'bl.json')], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

// PASS: adding a test grows the signal.
{ const d = setup(FULL); baseline(d);
  writeFileSync(join(d, 'f.test.mjs'), FULL + `test('c', () => { assert.equal(f(4), 4); });\n`);
  const r = gate(d); expect('adding a test PASSES (signal grew)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// BLOCK: deleting a test + its assertions drops the signal.
{ const d = setup(FULL); baseline(d);
  writeFileSync(join(d, 'f.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from './f.mjs';\ntest('a', () => { assert.equal(f(1), 1); });\n`);
  const r = gate(d); expect('deleting a test/assertions BLOCKED (floor)', r.code === 3 && /floor: must not decrease/.test(r.out), `exit ${r.code}: ${r.out}`); }

// BLOCK: skipping a test (active case no longer counts).
{ const d = setup(FULL); baseline(d);
  writeFileSync(join(d, 'f.test.mjs'), FULL.replace("test('b'", "test.skip('b'"));
  const r = gate(d); expect('skipping a test BLOCKED (floor)', r.code === 3 && /floor/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: test_signal floor blocks test-gaming (delete/skip/trim), allows growth ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
