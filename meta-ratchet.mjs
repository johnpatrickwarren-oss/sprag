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
// Exemption arrays inside a check: growing any of them lets MORE through (the allow-list an AI agent
// reaches for — add the hallucinated dep to `allow`, the new feature dir to `allowed/allowedDirs`, the
// untested module to `exclude`). `allowed`/`allowedDirs` are scope_diff's in-scope set, so adding to
// them widens scope; `allow`/`exclude` are exemption lists. Any ADDED entry is a relaxation.
const EXEMPTION_KEYS = ['allow', 'exclude', 'allowed', 'allowedDirs'];

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
  for (const k of EXEMPTION_KEYS) {
    const newArr = Array.isArray(inv.check?.[k]) ? inv.check[k] : [];
    if (!newArr.length) continue; // removing/emptying an exemption list is STRICTER, never flagged
    const oldSet = new Set(Array.isArray(old.check?.[k]) ? old.check[k] : []);
    const added = newArr.filter((x) => !oldSet.has(x));
    if (added.length) out.push(`[${id}] check.${k} exempts more: +${added.join(', ')}`);
  }
  return out;
}

// The "current" version of a config file: the working tree by default, or the STAGED (index) version
// when `from: 'index'` — so a pre-commit hook checks what's actually being COMMITTED, closing the
// stage-a-relaxation-then-revert-the-working-file trick (`git show :./name` reads the index).
function currentConfig(dir, name, from) {
  if (from === 'index') return fileAtRef(dir, '', name);
  return existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null;
}

// All relaxations of the current invariants + baseline vs `ref`. Returns { count, reasons[] }.
export function configRelaxations(dir, check) {
  const ref = check.against || 'HEAD';
  const from = check.from || 'worktree';
  const invName = check.invariants || 'invariants.json';
  const baseName = check.baseline || 'baseline.json';
  const reasons = [];

  const curInv = parseJSON(currentConfig(dir, invName, from)) || [];
  const oldInv = parseJSON(fileAtRef(dir, ref, invName));
  if (Array.isArray(oldInv)) {
    const newById = new Map(curInv.map((i) => [i.id, i]));
    for (const old of oldInv) {
      const inv = newById.get(old.id);
      if (!inv) { reasons.push(`[${old.id}] invariant REMOVED`); continue; } // dropping a rule weakens the gate
      reasons.push(...invariantRelaxations(old.id, old, inv));
    }
  }

  // Ratchet ids still present in the current config — a baseline entry vanishing for one of these drops
  // its floor silently (a removed entry for an already-removed invariant is benign, flagged above).
  const ratchetIds = new Set(curInv.filter((i) => i && i.mode === 'ratchet').map((i) => i.id));
  const curBase = parseJSON(currentConfig(dir, baseName, from)) || {};
  const oldBase = parseJSON(fileAtRef(dir, ref, baseName));
  if (oldBase && typeof oldBase === 'object') {
    for (const [id, ov] of Object.entries(oldBase)) {
      if (typeof ov !== 'number') continue;
      const nv = curBase[id];
      if (typeof nv === 'number') { if (nv > ov) reasons.push(`baseline[${id}] ${ov} -> ${nv} (raised — grandfathers more debt)`); }
      else if (ratchetIds.has(id)) reasons.push(`baseline[${id}] removed (ratchet floor dropped for a still-active rule)`);
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
