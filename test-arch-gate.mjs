// Self-contained test for the architectural-invariant gate (no deps).
// Proves the gate (a) PASSES the clean sample, and (b) BLOCKS each k10s-style rot diff —
// god-object growth, positional magic-index access, and central-dispatch growth — naming the
// right invariant. The architectural analog of the behavioral test-gate.mjs.
//
//   node test-arch-gate.mjs    (exit 0 = all cases behaved as expected)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
const SAMPLE = join(HERE, 'sample');
const CLEAN_GO = readFileSync(join(SAMPLE, 'ui.go'), 'utf8');

function runGate(dir) {
  const r = spawnSync('node', [GATE, dir], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function sampleWith(go) {
  const d = mkdtempSync(join(tmpdir(), 'arch-rot-'));
  cpSync(SAMPLE, d, { recursive: true });
  writeFileSync(join(d, 'ui.go'), go);
  return d;
}
let failed = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
  if (!cond) failed++;
};

// 0. Record the clean sample as the accepted baseline.
spawnSync('node', [GATE, SAMPLE, '--baseline'], { encoding: 'utf8' });

// 1. Clean sample passes.
{
  const r = runGate(SAMPLE);
  expect('clean sample PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// 2. ROT A — god object: add a field to Model.
{
  const go = CLEAN_GO.replace('\tquitting bool\n', '\tquitting bool\n\tselected int\n');
  const r = runGate(sampleWith(go));
  expect('rot: +Model field  BLOCKED on model-not-god-object',
    r.code === 3 && /model-not-god-object/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// 3. ROT B — positional fragility: magic-index access into a flattened array.
{
  const go = CLEAN_GO.replace('\tswitch m.view {', '\talloc := m.cols[3]\n\t_ = alloc\n\tswitch m.view {');
  const r = runGate(sampleWith(go));
  expect('rot: magic index m.cols[3]  BLOCKED on no-positional-rows',
    r.code === 3 && /no-positional-rows/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// 4. ROT C — central-dispatch growth: add a case to the view switch.
{
  const go = CLEAN_GO.replace(
    '\tcase "nodes":\n\t\tm.views["nodes"] = m.views["nodes"].Update(msg)\n',
    '\tcase "nodes":\n\t\tm.views["nodes"] = m.views["nodes"].Update(msg)\n\tcase "services":\n\t\tm.views["services"] = m.views["services"].Update(msg)\n');
  const r = runGate(sampleWith(go));
  expect('rot: +dispatch case  BLOCKED on bounded-dispatch',
    r.code === 3 && /bounded-dispatch/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// 5. ROT D — scope creep: RENAME a dispatch case to an out-of-scope capability. Count is unchanged
//    (bounded-dispatch passes), but scope-boundary catches the new capability — what a ratchet misses.
{
  const go = CLEAN_GO.replace('\tcase "nodes":', '\tcase "metrics":');
  const r = runGate(sampleWith(go));
  expect('rot: out-of-scope capability  BLOCKED on scope-boundary (count unchanged, bounded-dispatch passes)',
    r.code === 3 && /✗ \[scope-boundary\]/.test(r.out) && !/✗ \[bounded-dispatch\]/.test(r.out), `exit ${r.code}: ${r.out}`);
}

console.log(failed === 0
  ? '\nPASS: gate passes clean code and blocks all 4 k10s-style rot diffs ✅'
  : `\nFAIL: ${failed} case(s) did not behave as expected`);
process.exit(failed === 0 ? 0 : 1);
