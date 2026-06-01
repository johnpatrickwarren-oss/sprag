// Self-contained test for scope_diff allowedDirs: a NEW top-level feature dir = scope creep -> block.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'sd-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'scope-dirs', intent: 'only auth/dashboard feature areas', check: { kind: 'scope_diff', allowedDirs: ['auth', 'dashboard'] }, max: 0, mode: 'ratchet', severity: 'block' }]));
const mk = (dirs) => { const d = mkdtempSync(join(tmpdir(), 'sd-repo-')); for (const x of dirs) { mkdirSync(join(d, x)); writeFileSync(join(d, x, 'f.ts'), 'export const x=1;\n'); } return d; };
const gate = (d) => { const r = spawnSync('node', [GATE, d, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
{ const r = gate(mk(['auth', 'dashboard'])); expect('in-scope feature dirs PASS', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const r = gate(mk(['auth', 'dashboard', 'billing'])); expect('new billing/ dir BLOCKED on scope-dirs (scope creep)', r.code === 3 && /✗ \[scope-dirs\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
console.log(failed === 0 ? '\nPASS: scope_diff flags a new top-level feature dir (scope creep) ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
