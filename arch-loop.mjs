#!/usr/bin/env node
// arch-loop.mjs — AI-loop feedback gate. Runs the architectural gate; on a block, feeds the
// violation back to a FIXER and re-checks, until it passes or escalates. The fixer is pluggable:
// a stub (tests) or a claude session (real use; cwd = the code dir, reads ARCH_GATE_FEEDBACK /
// .arch-feedback.md). On escalation it does NOT relax the invariant — a fixer that can't satisfy
// the gate means the change is genuinely incompatible with the architecture; that's a human call.
//
//   node arch-loop.mjs <dir> --fixer "<cmd>" [--max-iters N=3] [--baseline-in <file>]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');

function parse(argv) {
  let dir = null, fixer = null, maxIters = 3, baselineIn = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixer') fixer = argv[++i];
    else if (a === '--max-iters') maxIters = parseInt(argv[++i], 10);
    else if (a === '--baseline-in') baselineIn = argv[++i];
    else if (!a.startsWith('--')) dir = a;
    else { console.error(`arch-loop: unknown arg ${a}`); process.exit(64); }
  }
  return { dir, fixer, maxIters, baselineIn };
}
function gate(dir, baselineIn) {
  const a = [GATE, dir, '--json'];
  if (baselineIn) a.push('--baseline-in', baselineIn);
  const r = spawnSync('node', a, { encoding: 'utf8' });
  let res = { violations: [] };
  try { res = JSON.parse(r.stdout); } catch { /* ignore */ }
  return { blocked: r.status === 3, res };
}
function feedback(violations) {
  return [
    'Your change violates these HUMAN-AUTHORED architectural invariants. Fix the CODE to honor them.',
    'Do NOT relax, delete, or suppress the invariant — change the implementation. Violations:', '',
    ...violations.map((v) => `- [${v.id}] ${v.reasons.join('; ')}\n  intent: ${v.intent}`),
  ].join('\n');
}

const { dir, fixer, maxIters, baselineIn } = parse(process.argv.slice(2));
if (!dir || !fixer) {
  console.error('usage: arch-loop.mjs <dir> --fixer "<cmd>" [--max-iters N] [--baseline-in <file>]');
  process.exit(64);
}
let g = gate(dir, baselineIn), iter = 0;
while (g.blocked && iter < maxIters) {
  iter++;
  const fb = feedback(g.res.violations);
  writeFileSync(join(dir, '.arch-feedback.md'), fb);
  console.log(`[arch-loop] iter ${iter}/${maxIters}: BLOCKED on ${g.res.violations.map((v) => v.id).join(', ')} -> invoking fixer`);
  spawnSync('bash', ['-c', fixer], { cwd: dir, stdio: 'inherit', env: { ...process.env, ARCH_GATE_FEEDBACK: fb } });
  g = gate(dir, baselineIn);
}
if (!g.blocked) {
  console.log(`[arch-loop] CONVERGED in ${iter} iteration(s): architecture passes the gate.`);
  process.exit(0);
}
console.log(`[arch-loop] ESCALATE: still blocked after ${maxIters} fixer iteration(s): ${g.res.violations.map((v) => v.id).join(', ')}.`);
console.log('  A fixer that cannot satisfy the gate suggests the change is genuinely incompatible with the');
console.log('  architecture — escalate to a human. Do NOT relax the invariant to make it pass.');
process.exit(2);
