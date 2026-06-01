// More languages: God-function check on PYTHON via @ast-grep/lang-python (real AST).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'py-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-god-functions', intent: 'no Python function over 25 lines', check: { kind: 'max_function_lines', maxLines: 25 }, max: 0, mode: 'ratchet', severity: 'block', lang: 'python', engine: 'ast-grep' }]));
const dirWith = (b) => { const d = mkdtempSync(join(tmpdir(), 'py-')); writeFileSync(join(d, 'm.py'), b); return d; };
const gate = (d) => { const r = spawnSync('node', [GATE, d, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
{ const r = gate(dirWith('def small():\n    return 1\n')); expect('short Python function PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const body = 'def big():\n' + Array.from({length:30},(_,i)=>`    v${i} = ${i}`).join('\n') + '\n    return 0\n';
  const r = gate(dirWith(body)); expect('30-line Python function BLOCKED on no-god-functions', r.code === 3 && /✗ \[no-god-functions\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
console.log(failed === 0 ? '\nPASS: God-function check works on Python via real AST ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
