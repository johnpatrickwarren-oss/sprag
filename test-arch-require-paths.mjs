// Self-contained test for require_paths — the deterministic floor under Anchor's "durable project
// trail" discipline: a required artifact (file or dir) must exist; missing ones block at max:0.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-rp-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'project-trail', intent: 'the durable project trail must exist', check: { kind: 'require_paths', paths: ['PROJECT-TRAIL.md', 'docs/adr'] }, max: 0, severity: 'block' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

// all required paths present (a file + a dir) -> PASS
{ const d = mkdtempSync(join(tmpdir(), 'arch-rp-'));
  writeFileSync(join(d, 'PROJECT-TRAIL.md'), '# trail\n');
  mkdirSync(join(d, 'docs', 'adr'), { recursive: true });
  const r = gate(d); expect('all required paths present PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// a missing required path -> BLOCKED
{ const d = mkdtempSync(join(tmpdir(), 'arch-rp-'));
  writeFileSync(join(d, 'PROJECT-TRAIL.md'), '# trail\n'); // docs/adr missing
  const r = gate(d); expect('missing required path (docs/adr) BLOCKED', r.code === 3 && /✗ \[project-trail\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// both missing -> BLOCKED (count 2)
{ const d = mkdtempSync(join(tmpdir(), 'arch-rp-'));
  const r = gate(d); expect('all required paths missing BLOCKED', r.code === 3 && /✗ \[project-trail\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: require_paths enforces that required artifacts (file/dir) exist ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
