// Regression test: build artifacts (compiled .js next to a .ts, *.browser/.min/.bundle, .d.ts) must
// NOT be counted by the metrics — otherwise a `tsc` run doubles the counts and corrupts a ratchet
// baseline (non-deterministic depending on whether the tree was built). Exercises God-function +
// oversized-file metrics.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-gen-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([
  { id: 'no-god-functions', intent: 'no fn over 20 lines', check: { kind: 'max_function_lines', maxLines: 20 }, max: 0, mode: 'ratchet', severity: 'block', lang: 'ts', engine: 'ast-grep' },
  { id: 'no-god-files', intent: 'no file over 20 lines', check: { kind: 'oversized_files', maxLines: 20 }, max: 0, mode: 'ratchet', severity: 'block' },
]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const bigFn = 'export function big(){\n' + Array.from({ length: 40 }, (_, i) => `  const v${i}=${i};`).join('\n') + '\n  return 0;\n}\n';

// authored source is clean; the ONLY oversized/god-function content lives in build artifacts.
const d = mkdtempSync(join(tmpdir(), 'arch-gen-'));
writeFileSync(join(d, 'mod.ts'), 'export const ok = () => 1;\n');     // clean authored source
writeFileSync(join(d, 'mod.js'), bigFn);                              // compiled sibling of mod.ts -> IGNORE
writeFileSync(join(d, 'app.bundle.js'), bigFn);                       // bundle -> IGNORE
writeFileSync(join(d, 'types.d.ts'), 'export type T = ' + Array.from({ length: 40 }, (_, i) => `{ f${i}: number }`).join(' | ') + ';\n'); // .d.ts oversized -> IGNORE
const r = gate(d);
expect('build artifacts NOT counted (gate PASSes on clean authored source)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);

// control: rename the compiled .js to a real authored .mjs WITHOUT a .ts sibling -> now it counts.
writeFileSync(join(d, 'authored.mjs'), bigFn);                        // real source, no .ts sibling -> COUNT
const r2 = gate(d);
expect('a real .mjs source (no .ts sibling) IS counted', r2.code === 3 && /✗ \[no-god-functions\]/.test(r2.out), `exit ${r2.code}: ${r2.out}`);

console.log(failed === 0 ? '\nPASS: generated/build artifacts are excluded; authored source is counted ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
