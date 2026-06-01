// Multi-language proof: the SAME gate, driven by the ast-grep (real-AST) engine, enforces the
// k10s tenets on TYPESCRIPT. Passes the clean TS sample; blocks the 3 rot diffs on the right
// invariant — using a genuine TS AST, not regex.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
const INV = join(HERE, 'invariants.ts.json');
const SAMPLE = join(HERE, 'sample-ts');
const BL = join(HERE, 'baseline-ts.json');
const CLEAN = readFileSync(join(SAMPLE, 'ui.ts'), 'utf8');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

function gate(dir) {
  const r = spawnSync('node', [GATE, dir, '--invariants', INV, '--baseline-in', BL], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
function tsWith(go) { const d = mkdtempSync(join(tmpdir(), 'arch-ts-')); cpSync(SAMPLE, d, { recursive: true }); writeFileSync(join(d, 'ui.ts'), go); return d; }

// baseline from clean TS sample (real AST: Model=5, magic=0, switch=2)
spawnSync('node', [GATE, SAMPLE, '--invariants', INV, '--baseline', '--baseline-out', BL], { encoding: 'utf8' });

{ const r = gate(SAMPLE); expect('TS clean sample PASSES (ast-grep engine)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ const go = CLEAN.replace('  err: Error | null = null;', '  err: Error | null = null;\n  selected = 0;');
  const r = gate(tsWith(go));
  expect('TS rot: +Model field  BLOCKED on model-not-god-object', r.code === 3 && /model-not-god-object/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ const go = CLEAN.replace('  switch (m.view) {', '  const a = cols[3];\n  void a;\n  switch (m.view) {');
  const r = gate(tsWith(go));
  expect('TS rot: magic index cols[3]  BLOCKED on no-positional-rows', r.code === 3 && /no-positional-rows/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ const go = CLEAN.replace('    case "nodes":\n      m.views["nodes"] = m.views["nodes"].update(msg);\n      break;\n',
    '    case "nodes":\n      m.views["nodes"] = m.views["nodes"].update(msg);\n      break;\n    case "svc":\n      m.views["svc"] = m.views["svc"].update(msg);\n      break;\n');
  const r = gate(tsWith(go));
  expect('TS rot: +dispatch case  BLOCKED on bounded-dispatch', r.code === 3 && /bounded-dispatch/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: real-AST (ast-grep) gate enforces the tenets on TypeScript too ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
