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

console.log(failed === 0 ? '\nPASS: real Go AST (ast-grep/lang-go) enforces the tenets incl. goroutine-mutation ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
