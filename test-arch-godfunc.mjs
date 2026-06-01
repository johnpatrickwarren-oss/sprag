// Self-contained test for the generic God-function check (max_function_lines, ast-grep JS/TS).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-gf-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-god-functions', intent: 'no function over 30 lines', check: { kind: 'max_function_lines', maxLines: 30 }, max: 0, mode: 'ratchet', severity: 'block', lang: 'js', engine: 'ast-grep' }]));
const dirWith = (body) => { const d = mkdtempSync(join(tmpdir(), 'arch-gf-')); writeFileSync(join(d, 'f.mjs'), body); return d; };
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
{ const r = gate(dirWith('export const f = () => 1;\nfunction g(){ return 2; }\n')); expect('short functions PASS', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const big = 'export function big(){\n' + Array.from({length:40},(_,i)=>`  const v${i}=${i};`).join('\n') + '\n  return 0;\n}\n';
  const r = gate(dirWith(big)); expect('40-line function BLOCKED on no-god-functions', r.code === 3 && /✗ \[no-god-functions\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
// regression guard: a God function NESTED in a subdir must still be detected (readSource() only reads
// the top-level dir, so the metric must walk recursively — this is what made the metric 0 on packages/).
{ const d = mkdtempSync(join(tmpdir(), 'arch-gf-nested-'));
  mkdirSync(join(d, 'pkg', 'src'), { recursive: true });
  writeFileSync(join(d, 'index.mjs'), 'export const ok = () => 1;\n'); // top-level file is clean
  const big = 'export function big(){\n' + Array.from({ length: 40 }, (_, i) => `  const v${i}=${i};`).join('\n') + '\n  return 0;\n}\n';
  writeFileSync(join(d, 'pkg', 'src', 'deep.mjs'), big); // God function two levels down
  const r = gate(d); expect('nested God function detected (recursive walk)', r.code === 3 && /✗ \[no-god-functions\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
console.log(failed === 0 ? '\nPASS: God-function check passes short functions, blocks oversized ones (incl. nested) ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
