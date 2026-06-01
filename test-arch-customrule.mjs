// Self-contained test for ast_grep_rule (custom rule DSL): a project-specific invariant expressed
// as a raw ast-grep rule, no gate code changes. Here: forbid a property mutation inside EITHER a
// setInterval OR setTimeout callback (a composite any+inside rule).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'cr-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{
  id: 'no-timer-mutation', intent: 'no shared mutation inside a timer callback',
  check: { kind: 'ast_grep_rule', rule: { pattern: '$O.$F = $V', inside: { any: [{ pattern: 'setInterval($$$)' }, { pattern: 'setTimeout($$$)' }], stopBy: 'end' } } },
  max: 0, mode: 'ratchet', severity: 'block', lang: 'js', engine: 'ast-grep',
}]));
const dirWith = (b) => { const d = mkdtempSync(join(tmpdir(), 'cr-')); writeFileSync(join(d, 'f.mjs'), b); return d; };
const gate = (d) => { const r = spawnSync('node', [GATE, d, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
{ const r = gate(dirWith('export function f(){ setTimeout(() => { bus.send(1); }, 9); }\n')); expect('clean (timer sends a message) PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ const r = gate(dirWith('export function f(){ setTimeout(() => { model.x = 1; }, 9); }\n')); expect('custom rule flags mutation in setTimeout', r.code === 3 && /✗ \[no-timer-mutation\]/.test(r.out), `exit ${r.code}: ${r.out}`); }
console.log(failed === 0 ? '\nPASS: custom ast-grep rule invariant works (project-specific, no code changes) ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
