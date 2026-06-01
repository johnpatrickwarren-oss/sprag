// Self-contained test for the `forbid_path` check (LAYERING / dependency-direction): flags files under
// `dirs` that REFERENCE a forbidden path in code — e.g. product tests reaching into process state
// (coordination/). Proves it flags a real code reference, IGNORES harmless comment citations, and is
// suppression-aware. This is the check that would have caught tessera's product↔process fusion.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-lay-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'product-not-depend-on-process', intent: 'product must not read coordination/', check: { kind: 'forbid_path', dirs: ['test'], path: 'coordination/' }, max: 0, mode: 'ratchet', severity: 'block' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'arch-lay-')); mkdirSync(join(d, 'test')); return d; };

// 1. a test that only MENTIONS coordination/ in a comment -> PASS (citation, not a dependency)
{ const d = mk();
  writeFileSync(join(d, 'test', 'a.test.ts'), `import {test} from 'node:test';\n// design per coordination/specs/Q-R28-SPEC.md\ntest('adapter', () => { assert.ok(parse(input)); });\n`);
  const r = gate(d); expect('comment citation of coordination/ PASSES (not a dependency)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 2. a test that READS a coordination/ path in code -> BLOCKED (product depends on process)
{ const d = mk();
  writeFileSync(join(d, 'test', 'b.test.ts'), `import {test} from 'node:test';\nimport {readFileSync} from 'node:fs';\n`
    + `test('hygiene', () => { const m = readFileSync('coordination/MEMORIAL.md','utf8'); assert.ok(m.includes('Phase 3')); });\n`);
  const r = gate(d); expect('code reference to coordination/ BLOCKED', r.code === 3 && /✗ \[product-not-depend-on-process\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 3. suppression: the same code reference with `anchor:allow` is NOT counted
{ const d = mk();
  writeFileSync(join(d, 'test', 'b.test.ts'), `import {test} from 'node:test';\nimport {readFileSync} from 'node:fs';\n// anchor:allow product-not-depend-on-process: transitional, tracked in #45\n`
    + `test('hygiene', () => { readFileSync('coordination/MEMORIAL.md','utf8'); });\n`);
  const r = gate(d); expect('suppressed layering violation NOT counted', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: forbid_path flags code references, ignores comment citations, honors suppression ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
