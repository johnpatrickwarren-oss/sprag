// golden.mjs — golden_outputs: a deterministic behavioral characterization gate (the first behavioral
// rung). Runs human-declared commands and compares their output to committed golden files; any
// divergence blocks. It catches the highest-value behavioral failure of AI codegen — "the refactor
// silently changed behavior" — with a MODEL-FREE oracle: the approved golden output, no LLM judge, no
// who-verifies-the-verifier.
//
// Unlike every structural check, this EXECUTES the code, so sprag's "deterministic regardless of build
// state, never runs the tree" guarantee does not apply: it belongs in the OPT-IN, OUT-OF-BAND tier
// (CI / pre-merge, where `arch mutate` lives), NOT the per-commit hot path. The commands must be
// deterministic (same input -> same output); a flaky command makes a flaky gate.
//
// Record / refresh goldens with ARCH_RECORD_GOLDEN=1 (writes each command's current output to its
// golden file, then passes). The committed golden diff IS the auditable approval — you can't refresh a
// golden without it showing up as a reviewed file change (and a meta-ratchet can guard the golden dir).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, ''); // tolerant of trailing whitespace/newlines

// golden_outputs: count behavioral divergences across `cases` (each { name?, cmd, golden, timeout?,
// includeStderr?, expectExit? }). Returns the mismatch count (use max: 0). In record mode, writes the
// current outputs as the new goldens and returns 0.
export function goldenMismatchCount(dir, check) {
  if (!dir) return 0;
  const record = !!process.env.ARCH_RECORD_GOLDEN;
  let mismatches = 0;
  for (const c of check.cases || []) {
    if (!c || !c.cmd || !c.golden) continue;
    const r = spawnSync(c.cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: c.timeout || 60000 });
    const got = norm((r.stdout || '') + (c.includeStderr ? r.stderr || '' : ''));
    const label = c.name || c.cmd;
    const goldenPath = join(dir, c.golden);
    if (record) { writeFileSync(goldenPath, got + '\n'); continue; }
    if (!existsSync(goldenPath)) { console.error(`arch-gate: golden missing for "${label}" (${c.golden}) — record with ARCH_RECORD_GOLDEN=1`); mismatches++; continue; }
    if (got !== norm(readFileSync(goldenPath, 'utf8'))) { console.error(`arch-gate: golden MISMATCH "${label}" (${c.golden}) — behavior changed vs the approved output`); mismatches++; }
    else if (typeof c.expectExit === 'number' && r.status !== c.expectExit) { console.error(`arch-gate: "${label}" exit ${r.status} != expected ${c.expectExit}`); mismatches++; }
  }
  return mismatches;
}
