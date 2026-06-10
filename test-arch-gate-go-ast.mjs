// Go via REAL AST (@ast-grep/lang-go): proves the ast-grep engine enforces the tenets on Go too,
// INCLUDING the goroutine-mutation check (T5) that the regex/heuristic engine could not express.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
const INV = join(HERE, 'invariants.go-ast.json');
const SAMPLE = join(HERE, 'sample-go-ast');
const BL = join(HERE, 'baseline-go-ast.json');
const CLEAN = readFileSync(join(SAMPLE, 'ui.go'), 'utf8');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV, '--baseline-in', BL], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const goWith = (go) => { const d = mkdtempSync(join(tmpdir(), 'arch-goast-')); cpSync(SAMPLE, d, { recursive: true }); writeFileSync(join(d, 'ui.go'), go); return d; };

spawnSync('node', [GATE, SAMPLE, '--invariants', INV, '--baseline', '--baseline-out', BL], { encoding: 'utf8' });

{ const r = gate(SAMPLE); expect('Go clean sample PASSES (real ast-grep AST)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ const go = CLEAN.replace('\terr    error\n', '\terr    error\n\tselected int\n');
  const r = gate(goWith(go));
  expect('Go rot: +Model field  BLOCKED on model-not-god-object', r.code === 3 && /✗ \[model-not-god-object\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ const go = CLEAN.replace('\tswitch m.view {', '\tx := cols[3]\n\t_ = x\n\tswitch m.view {');
  const r = gate(goWith(go));
  expect('Go rot: magic index cols[3]  BLOCKED on no-positional-rows', r.code === 3 && /✗ \[no-positional-rows\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ // T5: mutation inside a goroutine — the heuristic engine could NOT do this
  const go = CLEAN.replace('\t\tbus <- Msg{}', '\t\tm.view = "x"');
  const r = gate(goWith(go));
  expect('Go rot: mutation in goroutine  BLOCKED on no-goroutine-mutation', r.code === 3 && /✗ \[no-goroutine-mutation\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

{ // Go God-function: a 40-line function -> blocked (real AST line-span)
  const big = "\nfunc bloated() {\n" + Array.from({length:40},(_,i)=>`\tv${i} := ${i}`).join("\n") + "\n}\n";
  const go = CLEAN + big;
  const r = gate(goWith(go));
  expect('Go rot: 40-line function  BLOCKED on no-god-functions', r.code === 3 && /✗ \[no-god-functions\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// H2 regression pair: switch_case_count must honor `on: m.view`, not just count the FIRST switch
// in the (alphabetically) concatenated source. A decoy file sorting before ui.go holds an unrelated
// 6-case `switch k`.
const DECOY = 'package ui\n\nfunc decoy(k int) {\n\tswitch k {\n\tcase 1:\n\tcase 2:\n\tcase 3:\n\tcase 4:\n\tcase 5:\n\tcase 6:\n\t}\n}\n';
{ // (a) the unrelated switch must not be counted -> no false block
  const d = goWith(CLEAN); writeFileSync(join(d, 'aa_decoy.go'), DECOY);
  const r = gate(d);
  expect('Go: unrelated 6-case switch (sorted first) does NOT false-block bounded-dispatch (on: m.view)',
    r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }
{ // (b) growth of the DECLARED m.view dispatch is still caught with the decoy present
  const go = CLEAN.replace('\tcase "nodes":\n\t\tm.views["nodes"] = m.views["nodes"].Update(msg)\n',
    '\tcase "nodes":\n\t\tm.views["nodes"] = m.views["nodes"].Update(msg)\n\tcase "svc":\n\t\tm.views["svc"] = m.views["svc"].Update(msg)\n');
  const d = goWith(go); writeFileSync(join(d, 'aa_decoy.go'), DECOY);
  const r = gate(d);
  expect('Go: +m.view dispatch case BLOCKED even with an unrelated switch sorted first',
    r.code === 3 && /✗ \[bounded-dispatch\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: real Go AST (ast-grep/lang-go) enforces the tenets incl. goroutine-mutation ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
