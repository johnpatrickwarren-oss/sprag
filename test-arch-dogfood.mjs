// Dogfood: arch-gate gates its OWN source. Keeps the tool free of God files/functions/hubs by its
// own generic checks (no file >400 lines, no function >60, no module imported by >5 files).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'dogfood-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([
  { id: 'god-files', intent: 'no tool file >400 lines', check: { kind: 'oversized_files', maxLines: 400 }, max: 0, mode: 'ratchet', severity: 'block' },
  { id: 'god-functions', intent: 'no tool function >60 lines', check: { kind: 'max_function_lines', maxLines: 60 }, max: 0, mode: 'ratchet', severity: 'block', lang: 'js', engine: 'ast-grep' },
  { id: 'god-module', intent: 'no tool module imported by >5 files', check: { kind: 'module_fanin', maxFanin: 5 }, max: 0, mode: 'ratchet', severity: 'block' },
]));
// scope to the TOOL's own scripts (exclude tests/samples/node_modules)
const work = mkdtempSync(join(tmpdir(), 'dogfood-'));
for (const f of ['arch.mjs', 'arch-gate.mjs', 'arch-trend.mjs', 'arch-loop.mjs', 'run-tests.mjs']) copyFileSync(join(HERE, f), join(work, f));
const r = spawnSync('node', [GATE, work, '--invariants', INV], { encoding: 'utf8' });
expect('arch-gate passes its OWN generic checks (no God files/functions/hubs)', r.status === 0 && /PASS/.test(r.stdout), `exit ${r.status}: ${r.stdout}${r.stderr}`);
console.log(failed === 0 ? '\nPASS: the tool eats its own dog food ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
