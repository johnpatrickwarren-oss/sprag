// Self-contained test for module_fanin (coupling): flags a hub module imported by too many files.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-fi-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-god-module', intent: 'no module imported by >3 files', check: { kind: 'module_fanin', maxFanin: 3 }, max: 0, mode: 'ratchet', severity: 'block' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
// hub: 5 files import ./model.mjs
{ const d = mkdtempSync(join(tmpdir(), 'arch-fi-')); writeFileSync(join(d, 'model.mjs'), 'export const M = 1;\n');
  for (let i = 0; i < 5; i++) writeFileSync(join(d, `v${i}.mjs`), `import { M } from './model.mjs';\nexport const x = M;\n`);
  const r = gate(d); expect('hub module (fan-in 5) BLOCKED on no-god-module', r.code === 3 && /✗ \[no-god-module\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
// no hub: each imports its own pair
{ const d = mkdtempSync(join(tmpdir(), 'arch-fi-')); for (let i = 0; i < 4; i++) { writeFileSync(join(d, `a${i}.mjs`), `import './b${i}.mjs';\n`); writeFileSync(join(d, `b${i}.mjs`), 'export const y = 1;\n'); }
  const r = gate(d); expect('no hub (fan-in 1 each) PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
// TEST imports are NOT coupling: ./util.mjs imported by 2 production files + 4 tests -> fan-in 2 (PASS),
// not 6 (which would BLOCK). A widely-tested core module must not read as a God-module hub.
{ const d = mkdtempSync(join(tmpdir(), 'arch-fi-')); writeFileSync(join(d, 'util.mjs'), 'export const U = 1;\n');
  for (const p of ['prodA', 'prodB']) writeFileSync(join(d, `${p}.mjs`), `import { U } from './util.mjs';\nexport const x = U;\n`);
  for (let i = 0; i < 4; i++) writeFileSync(join(d, `t${i}.test.mjs`), `import { U } from './util.mjs';\nif (!U) throw 0;\n`);
  const r = gate(d); expect('test imports excluded from fan-in (2 prod + 4 tests -> PASS)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
console.log(failed === 0 ? '\nPASS: fan-in flags a God-module hub, passes a decoupled tree ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
