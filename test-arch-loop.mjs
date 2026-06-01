// Self-contained test for the AI-loop feedback gate (stub fixers; no claude needed).
// Proves: (A) a fixer that resolves the violation -> loop CONVERGES; (B) a no-op fixer -> loop
// ESCALATES (bounded — it does not thrash forever and does not relax the invariant).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
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

console.log(failed === 0 ? '\nPASS: AI-loop converges on a good fixer, escalates on a stuck one ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
