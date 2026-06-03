// meta-ratchet.mjs — the gate that guards the GATE. Deterministic, no model, no engine.
//
// Fail-closed (the engine) stops the gate from ACCIDENTALLY becoming a no-op. This stops it from
// being DELIBERATELY relaxed: the AI-loop fixer (or a hurried human) can make a violation vanish not
// by fixing the code but by editing invariants.json to raise a `max` / drop a rule / downgrade
// severity, or by re-recording baseline.json upward to grandfather more debt. That is the reverse
// gear in the one-way clutch — and nothing else notices, because the relaxed config then passes.
//
// `config_relaxations` counts the ways the CURRENT config + baseline are WEAKER than a git ref
// (default HEAD). max: 0, so any relaxation blocks. New invariants and LOWERED thresholds are fine
// (strictly forward). Because the rule lives in the invariant set it guards, deleting it is itself a
// counted relaxation. Escape hatch for a deliberate, reviewed loosening: run with ARCH_ALLOW_RELAX=1
// (the relaxations are still printed — visible, never silent).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The committed version of a tracked file at `ref`, or null if absent there (a brand-new file has no
// prior to weaken from). `:./name` resolves the path relative to `dir` inside the repo.
function fileAtRef(dir, ref, name) {
  try { return execFileSync('git', ['-C', dir, 'show', `${ref}:./${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function parseJSON(s) { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } }

// Numeric ceilings inside a check whose name starts with "max" (maxLines, maxComplexity, maxFanin,
// maxFields, ...). Raising one — or removing it (now unbounded) — is a relaxation.
function maxFields(check) {
  const out = {};
  for (const [k, v] of Object.entries(check || {})) if (/^max/i.test(k) && typeof v === 'number') out[k] = v;
  return out;
}
const enforces = (inv) => typeof inv.max === 'number' || inv.mode === 'ratchet';

// Every way `inv` (new) is weaker than `old` (same id), as human-readable reasons.
function invariantRelaxations(id, old, inv) {
  const out = [];
  if (typeof old.max === 'number' && (typeof inv.max !== 'number' || inv.max > old.max)) {
    out.push(`[${id}] max ${old.max} -> ${typeof inv.max === 'number' ? inv.max : 'removed'} (raised/removed)`);
  }
  const om = maxFields(old.check), nm = maxFields(inv.check);
  for (const [k, ov] of Object.entries(om)) {
    if (!(k in nm)) out.push(`[${id}] check.${k} ${ov} -> removed (now unbounded)`);
    else if (nm[k] > ov) out.push(`[${id}] check.${k} ${ov} -> ${nm[k]} (raised)`);
  }
  if (old.severity === 'block' && inv.severity && inv.severity !== 'block') {
    out.push(`[${id}] severity block -> ${inv.severity} (downgraded)`);
  }
  if (enforces(old) && !enforces(inv)) out.push(`[${id}] no longer enforces (max/ratchet removed)`);
  return out;
}

// All relaxations of the current invariants + baseline vs `ref`. Returns { count, reasons[] }.
export function configRelaxations(dir, check) {
  const ref = check.against || 'HEAD';
  const invName = check.invariants || 'invariants.json';
  const baseName = check.baseline || 'baseline.json';
  const reasons = [];

  const curInv = parseJSON(existsSync(join(dir, invName)) ? readFileSync(join(dir, invName), 'utf8') : null) || [];
  const oldInv = parseJSON(fileAtRef(dir, ref, invName));
  if (Array.isArray(oldInv)) {
    const newById = new Map(curInv.map((i) => [i.id, i]));
    for (const old of oldInv) {
      const inv = newById.get(old.id);
      if (!inv) { reasons.push(`[${old.id}] invariant REMOVED`); continue; } // dropping a rule weakens the gate
      reasons.push(...invariantRelaxations(old.id, old, inv));
    }
  }

  const curBase = parseJSON(existsSync(join(dir, baseName)) ? readFileSync(join(dir, baseName), 'utf8') : null) || {};
  const oldBase = parseJSON(fileAtRef(dir, ref, baseName));
  if (oldBase && typeof oldBase === 'object') {
    for (const [id, ov] of Object.entries(oldBase)) {
      if (typeof ov !== 'number') continue;
      const nv = curBase[id];
      if (typeof nv === 'number' && nv > ov) reasons.push(`baseline[${id}] ${ov} -> ${nv} (raised — grandfathers more debt)`);
    }
  }
  return { count: reasons.length, reasons };
}

// Metric entry point: count of relaxations (max: 0). Prints each reason to stderr so a block is
// actionable; ARCH_ALLOW_RELAX zeroes the count for a deliberate, reviewed loosening (still printed).
export function configRelaxationCount(dir, check) {
  if (!dir) return 0;
  const { count, reasons } = configRelaxations(dir, check);
  if (count) {
    const allowed = !!process.env.ARCH_ALLOW_RELAX;
    console.error(`arch-gate: ${count} config/baseline relaxation(s) vs ${check.against || 'HEAD'}${allowed ? ' (ARCH_ALLOW_RELAX set — permitted)' : ''}:`);
    for (const r of reasons) console.error(`  ~ ${r}`);
    if (allowed) return 0;
  }
  return count;
}
