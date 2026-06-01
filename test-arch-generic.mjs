// Self-contained test for the generic, language-agnostic oversized_files (God-file) check.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
const INV = join(HERE, 'invariants.generic.json');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const dirWith = (name, lines) => { const d = mkdtempSync(join(tmpdir(), 'arch-gen-')); writeFileSync(join(d, name), Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join('\n')); return d; };

{ const r = gate(dirWith('ok.ts', 50)); expect('small file PASSES (no God file)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const r = gate(dirWith('huge.ts', 900)); expect('900-line file BLOCKED on no-god-files', r.code === 3 && /✗ \[no-god-files\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: generic God-file check passes small files, blocks oversized ones ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
