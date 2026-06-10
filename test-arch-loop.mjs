// Self-contained test for the AI-loop feedback gate (stub fixers; no claude needed).
// Proves: (A) a fixer that resolves the violation -> loop CONVERGES; (B) a no-op fixer -> loop
// ESCALATES (bounded — it does not thrash forever and does not relax the invariant);
// (C) a DEAD ENGINE (gate exit 2) fails CLOSED — the loop must not report convergence;
// (D) --invariants is forwarded to the gate, so the loop gates the USER's ruleset.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOP = join(HERE, 'arch-loop.mjs');
const GATE = join(HERE, 'arch-gate.mjs');
const SAMPLE = join(HERE, 'sample');
const CLEAN = readFileSync(join(SAMPLE, 'ui.go'), 'utf8');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

// ensure the default baseline reflects the clean sample (6, 0, 2)
spawnSync('node', [GATE, SAMPLE, '--baseline'], { encoding: 'utf8' });

function rottedDir() {
  const d = mkdtempSync(join(tmpdir(), 'arch-loop-'));
  cpSync(SAMPLE, d, { recursive: true });
  // introduce rot: a magic-index access (positional fragility)
  writeFileSync(join(d, 'ui.go'), CLEAN.replace('\tswitch m.view {', '\tx := m.cols[3]\n\t_ = x\n\tswitch m.view {'));
  return d;
}

// Case A — fixer resolves the violation (restores typed access): loop CONVERGES.
{
  const d = rottedDir();
  const fix = join(d, 'fix.sh');
  writeFileSync(fix, `#!/bin/bash\ncat > ui.go <<'GOEOF'\n${CLEAN}GOEOF\n`);
  chmodSync(fix, 0o755);
  const r = spawnSync('node', [LOOP, d, '--fixer', 'bash fix.sh', '--max-iters', '3'], { encoding: 'utf8' });
  expect('AI-loop CONVERGES when the fixer resolves the violation',
    r.status === 0 && /CONVERGED/.test(r.stdout), `exit ${r.status}: ${r.stdout}`);
}

// Case B — no-op fixer: loop ESCALATES after max-iters (bounded; invariant not relaxed).
{
  const d = rottedDir();
  const r = spawnSync('node', [LOOP, d, '--fixer', 'true', '--max-iters', '2'], { encoding: 'utf8' });
  expect('AI-loop ESCALATES when the fixer cannot resolve it',
    r.status === 2 && /ESCALATE/.test(r.stdout), `exit ${r.status}: ${r.stdout}`);
}

// Case C — DEAD ENGINE: the gate exits 2 (fail-closed). The loop must NOT print CONVERGED /
// exit 0 — a dead gate reading as a green gate is the exact failure the gate itself refuses.
{
  const d = mkdtempSync(join(tmpdir(), 'arch-loop-dead-'));
  writeFileSync(join(d, 'big.ts'), 'function f() {\n  let a = 1;\n  let b = 2;\n  let c = 3;\n  return a + b + c;\n}\n');
  const inv = join(d, 'inv.json');
  writeFileSync(inv, JSON.stringify([{ id: 'no-god-functions', intent: 'x', check: { kind: 'max_function_lines', maxLines: 3 }, engine: 'ast-grep', lang: 'ts', mode: 'ratchet', severity: 'block', max: 0 }]));
  const r = spawnSync('node', [LOOP, d, '--fixer', 'true', '--invariants', inv], { encoding: 'utf8', env: { ...process.env, ARCH_ENGINE_UNAVAILABLE: '1' } });
  expect('AI-loop fails CLOSED on a dead engine (no CONVERGED, non-zero exit)',
    r.status !== 0 && !/CONVERGED/.test(r.stdout) && /unavailable|did not run/i.test(r.stdout + r.stderr),
    `exit ${r.status}: ${r.stdout}${r.stderr}`);
}

// Case D — --invariants is forwarded: a custom ruleset (magic-index, max 0) blocks the rotted
// code; a fixer that removes the magic index converges. Without forwarding, the loop would gate
// the gate's own sample ruleset and trivially "converge" without ever invoking the fixer.
{
  const d = mkdtempSync(join(tmpdir(), 'arch-loop-inv-'));
  writeFileSync(join(d, 'app.go'), 'package main\n\nfunc f(xs []int) int {\n\treturn xs[3]\n}\n');
  const inv = join(d, 'inv.json');
  writeFileSync(inv, JSON.stringify([{ id: 'no-magic-index', intent: 'no positional access', check: { kind: 'magic_index_count' }, max: 0, mode: 'ratchet', severity: 'block' }]));
  const fix = join(d, 'fix.sh');
  writeFileSync(fix, '#!/bin/bash\nprintf \'package main\\n\\nfunc f(xs []int) int {\\n\\treturn len(xs)\\n}\\n\' > app.go\n');
  chmodSync(fix, 0o755);
  const r = spawnSync('node', [LOOP, d, '--fixer', 'bash fix.sh', '--invariants', inv, '--max-iters', '3'], { encoding: 'utf8' });
  expect('AI-loop gates the CUSTOM --invariants ruleset (blocks, fixes, converges)',
    r.status === 0 && /BLOCKED on no-magic-index/.test(r.stdout) && /CONVERGED in [1-9]/.test(r.stdout),
    `exit ${r.status}: ${r.stdout}${r.stderr}`);
  expect('AI-loop feedback file cites the custom invariant',
    existsSync(join(d, '.arch-feedback.md')) && /no-magic-index/.test(readFileSync(join(d, '.arch-feedback.md'), 'utf8')),
    'feedback file missing or does not mention no-magic-index');
}

console.log(failed === 0 ? '\nPASS: AI-loop converges, escalates, fails closed on a dead engine, honors --invariants ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
