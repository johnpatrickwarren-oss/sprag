// Self-contained test for golden_outputs — the behavioral characterization gate. The headline case:
// a refactor that silently changes behavior is caught by comparing output to the approved golden.
// Record mode creates/refreshes goldens; a missing golden blocks (fail-closed, not a silent pass).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-gold-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'behavior', intent: 'output must match the approved golden', check: { kind: 'golden_outputs', cases: [{ name: 'add', cmd: 'node src.js', golden: 'add.golden' }] }, max: 0, severity: 'block' }]));
const gate = (dir, env = {}) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8', env: { ...process.env, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const repo = (body) => { const d = mkdtempSync(join(tmpdir(), 'arch-gold-')); writeFileSync(join(d, 'src.js'), body); return d; };

// record the golden, then a matching run passes
{
  const d = repo("console.log('result:', 1 + 1);\n");
  const rec = gate(d, { ARCH_RECORD_GOLDEN: '1' });
  expect('record mode writes the golden + passes', rec.code === 0 && existsSync(join(d, 'add.golden')), `exit ${rec.code}`);
  const ok = gate(d);
  expect('output matching the golden PASSES', ok.code === 0 && /PASS/.test(ok.out), `exit ${ok.code}: ${ok.out}`);

  // a "refactor" that silently changes behavior -> mismatch -> BLOCKED
  writeFileSync(join(d, 'src.js'), "console.log('result:', 1 + 3);\n");
  const drift = gate(d);
  expect('refactor that changes behavior BLOCKED', drift.code === 3 && /golden MISMATCH/i.test(drift.out), `exit ${drift.code}: ${drift.out}`);
}

// a missing golden blocks (fail-closed), it is not a silent pass
{
  const d = repo("console.log('x');\n");
  const r = gate(d);
  expect('missing golden BLOCKS (not a silent pass)', r.code === 3 && /golden missing/i.test(r.out), `exit ${r.code}: ${r.out}`);
}

console.log(failed === 0 ? '\nPASS: golden_outputs catches silent behavior change, records goldens, blocks on missing ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
