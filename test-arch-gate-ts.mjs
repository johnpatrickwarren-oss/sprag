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

{ // T5: mutation inside a setInterval callback (the k10s data-race) — forbid_pattern
  const go = CLEAN.replace('    send({});', '    m.view = "x";');
  const r = gate(tsWith(go));
  expect('TS rot: mutation in async callback  BLOCKED on no-async-mutation', r.code === 3 && /no-async-mutation/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ // T3: scope creep — rename a case to an out-of-scope capability (count unchanged)
  const go = CLEAN.replace('    case "nodes":', '    case "metrics":');
  const r = gate(tsWith(go));
  expect('TS rot: out-of-scope capability  BLOCKED on scope-boundary (count unchanged)',
    r.code === 3 && /✗ \[scope-boundary\]/.test(r.out) && !/✗ \[bounded-dispatch\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// H2 regression pair: switch_case_count must honor `on: m.view`, not just count the FIRST switch
// in the (alphabetically) concatenated source. A decoy file sorting before ui.ts holds an unrelated
// 6-case `switch (k)`.
const DECOY = 'export function decoy(k: number): void {\n  switch (k) {\n    case 1: break;\n    case 2: break;\n    case 3: break;\n    case 4: break;\n    case 5: break;\n    case 6: break;\n  }\n}\n';
{ // (a) the unrelated switch must not be counted -> no false block
  const d = tsWith(CLEAN); writeFileSync(join(d, 'aa-decoy.ts'), DECOY);
  const r = gate(d);
  expect('TS: unrelated 6-case switch (sorted first) does NOT false-block bounded-dispatch (on: m.view)',
    r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ // (b) growth of the DECLARED m.view dispatch is still caught with the decoy present (a duplicate
  // in-scope "pods" case grows the dispatch without tripping scope-boundary)
  const go = CLEAN.replace('    case "nodes":\n      m.views["nodes"] = m.views["nodes"].update(msg);\n      break;\n',
    '    case "nodes":\n      m.views["nodes"] = m.views["nodes"].update(msg);\n      break;\n    case "pods":\n      m.views["pods"] = m.views["pods"].update(msg);\n      break;\n');
  const d = tsWith(go); writeFileSync(join(d, 'aa-decoy.ts'), DECOY);
  const r = gate(d);
  expect('TS: +m.view dispatch case BLOCKED even with an unrelated switch sorted first',
    r.code === 3 && /✗ \[bounded-dispatch\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: real-AST (ast-grep) gate enforces the tenets on TypeScript too ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
