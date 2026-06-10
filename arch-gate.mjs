#!/usr/bin/env node
// arch-gate.mjs — architectural-invariant gate (prototype, P1).
//
// Checks a codebase against HUMAN-AUTHORED invariants (invariants.json), RATCHETED against a
// baseline (never-get-worse). Mechanical + deterministic — no model — so no "who verifies the
// verifier" problem. See design/architectural-invariant-gate.md.
//
//   node arch-gate.mjs <dir> [--invariants f] --baseline [--baseline-out f]   # record baseline
//   node arch-gate.mjs <dir> [--invariants f] [--baseline-in f] [--json]      # check (0 pass / 3 blocked)
//
// ENGINES (per-invariant `engine` + `lang`):
//   heuristic (default) — lightweight text/brace parsing of Go-flavored source (no deps).
//   ast-grep            — REAL multi-language AST via @ast-grep/napi (TypeScript/JS here).
// The engine is pluggable per invariant, so one config can gate multiple languages.
//
// Suppressions: a per-occurrence check is suppressed on a line carrying
// `// anchor:allow <invariant-id>: <reason>`; the instance is NOT counted but IS reported
// (auditable escape hatch, not silent). Metric/ratchet invariants are "suppressed" by
// deliberately re-recording the baseline.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSkippedDir, oversizedFilesCount, moduleFaninCount, forbidPathRefCount, timeBombTestCount, untestedModuleCount, testSignalCount, dependencyCount, unlockedDependencyCount, missingPathCount } from './metrics.mjs';
import { secretScanCount } from './secret-scan.mjs';
import { astgrepMetric, godFunctionCount, complexFunctionCount, astgrepTreeCount } from './ast-engine.mjs';
import { configRelaxationCount } from './meta-ratchet.mjs';
import { goldenMismatchCount } from './golden.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Default invariants: the repo ships a sample invariants.json (used by the tests); when absent
// (e.g. a published install), fall back to language-agnostic generic checks so `arch check <dir>`
// is sensible out of the box. (The real entry point is `arch init`, which scaffolds + baselines.)
const BUILTIN_DEFAULT = [
  { id: 'no-god-files', intent: 'No source file over 800 lines (God file).', check: { kind: 'oversized_files', maxLines: 800 }, mode: 'ratchet', severity: 'block' },
  { id: 'no-god-module', intent: 'No module imported by more than 8 files (coupling hub).', check: { kind: 'module_fanin', maxFanin: 8 }, mode: 'ratchet', severity: 'block' },
];
export const INVARIANTS = existsSync(join(HERE, 'invariants.json'))
  ? JSON.parse(readFileSync(join(HERE, 'invariants.json'), 'utf8'))
  : BUILTIN_DEFAULT;
const BASELINE_PATH = join(HERE, 'baseline.json');

const EXT = { go: ['.go'], ts: ['.ts', '.tsx'], tsx: ['.ts', '.tsx'], js: ['.js', '.mjs', '.cjs', '.jsx'], python: ['.py'], py: ['.py'] };
export function readSource(dir, lang = 'go') {
  if (!existsSync(dir)) return '';
  const exts = EXT[lang] || EXT.go;
  return readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

export function collectSuppressions(src) {
  const out = {};
  src.split('\n').forEach((line, i) => {
    const m = line.match(/anchor:allow\s+([\w-]+)\s*:\s*(.+?)\s*$/);
    if (m) (out[m[1]] ||= []).push({ line: i + 1, reason: m[2] });
  });
  return out;
}

// ── heuristic engine (Go-flavored text/brace parsing; no deps) ──────────────────
function blockBody(src, headerRe) {
  const m = headerRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, body = '';
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++; else if (c === '}') depth--;
    if (depth > 0) body += c;
    i++;
  }
  return body;
}
function h_structFieldCount(src, name) {
  const body = blockBody(src, new RegExp(`type\\s+${name}\\s+struct\\s*\\{`));
  if (body == null) return 0;
  return body.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*')).length;
}
function h_switchCaseCount(src, onExpr) {
  const esc = onExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = blockBody(src, new RegExp(`switch\\s+${esc}\\s*\\{`));
  if (body == null) return 0;
  return (body.match(/\bcase\b/g) || []).length;
}
function h_magicIndexCount(src, suppressId) {
  const re = suppressId && new RegExp(`anchor:allow\\s+${suppressId}\\b`);
  let n = 0;
  for (const line of src.split('\n')) {
    if (re && re.test(line)) continue;
    n += (line.match(/\b[A-Za-z_]\w*\[\d+\]/g) || []).length;
  }
  return n;
}
function heuristicMetric(inv, src) {
  const c = inv.check;
  switch (c.kind) {
    case 'struct_field_count': return h_structFieldCount(src, c.struct);
    case 'switch_case_count': return h_switchCaseCount(src, c.on);
    case 'magic_index_count': return h_magicIndexCount(src, inv.id);
    default: throw new Error(`heuristic: unknown check kind ${c.kind} (try engine: ast-grep)`);
  }
}

// scope_diff (T3) is engine-agnostic: it lexically extracts the capability names (dispatch
// case-label string literals) and counts those NOT in the declared `allowed` scope. Unlike a count
// ratchet, this catches a RENAME to an out-of-scope capability even when the count is unchanged.
function scopeOutOfBoundsCount(src, check, dir) {
  let n = 0;
  if (check.allowed) { // capability names: dispatch case-labels not in the allowed set
    const set = new Set(check.allowed);
    n += [...src.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]).filter((l) => !set.has(l)).length;
  }
  if (check.allowedDirs && dir && existsSync(dir)) { // new top-level feature dirs (scope creep)
    const set = new Set(check.allowedDirs);
    for (const name of readdirSync(dir)) {
      if (isSkippedDir(name) || name.startsWith('.')) continue;
      if (statSync(join(dir, name)).isDirectory() && !set.has(name)) n++;
    }
  }
  return n;
}

export function metricValue(inv, src, dir) {
  if (inv.check.kind === 'module_fanin') return moduleFaninCount(dir, inv.check.maxFanin);
  if (inv.check.kind === 'oversized_files') return oversizedFilesCount(dir, inv.check.maxLines);
  if (inv.check.kind === 'forbid_path') return forbidPathRefCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'time_bomb_tests') return timeBombTestCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'require_tests') return untestedModuleCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'test_signal') return testSignalCount(dir, inv.check);
  if (inv.check.kind === 'require_paths') return missingPathCount(dir, inv.check);
  if (inv.check.kind === 'dependency_count') return dependencyCount(dir, inv.check);
  if (inv.check.kind === 'unlocked_dependencies') return unlockedDependencyCount(dir, inv.check);
  if (inv.check.kind === 'config_relaxations') return configRelaxationCount(dir, inv.check);
  if (inv.check.kind === 'secret_scan') return secretScanCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'golden_outputs') return goldenMismatchCount(dir, inv.check);
  if (inv.check.kind === 'scope_diff') return scopeOutOfBoundsCount(src, inv.check, dir);
  // God-function check: prefer the recursive per-file walk when we have a dir (correct on nested
  // trees); fall back to the concatenated single-parse when only `src` is available.
  if (inv.check.kind === 'max_function_lines' && dir && existsSync(dir)) {
    return godFunctionCount(dir, inv.check.maxLines, inv.lang || 'ts', inv.id);
  }
  if (inv.check.kind === 'max_complexity' && dir && existsSync(dir)) {
    return complexFunctionCount(dir, inv.check.maxComplexity ?? 10, inv.lang || 'ts', inv.id);
  }
  // ast_grep_tree: an author rule matched recursively across the whole tree (vs ast_grep_rule, which
  // only sees the concatenated top-level dir) — powers the type-strictness tenets on a nested src/.
  if (inv.check.kind === 'ast_grep_tree') return astgrepTreeCount(dir, inv.check.rule, inv.lang || 'ts', inv.id);
  return (inv.engine === 'ast-grep') ? astgrepMetric(inv, src) : heuristicMetric(inv, src);
}

export function parseArgs(argv) {
  const o = { dir: null, writeBaseline: false, baselineOut: null, baselineIn: null, json: false, invFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') o.writeBaseline = true;
    else if (a === '--baseline-out') o.baselineOut = argv[++i];
    else if (a === '--baseline-in') o.baselineIn = argv[++i];
    else if (a === '--invariants') o.invFile = argv[++i];
    else if (a === '--json') o.json = true;
    else if (!a.startsWith('--')) o.dir = a;
    else { console.error(`arch-gate: unknown arg ${a}`); process.exit(64); }
  }
  return o;
}

export function computeViolations(invariants, metrics, baseline) {
  const violations = [];
  for (const inv of invariants) {
    const v = metrics[inv.id];
    const reasons = [];
    if (typeof inv.max === 'number' && v > inv.max) reasons.push(`${v} exceeds absolute max ${inv.max}`);
    if (inv.mode === 'ratchet' && typeof baseline[inv.id] === 'number' && v > baseline[inv.id]) {
      reasons.push(`regressed ${baseline[inv.id]} -> ${v} (ratchet: must not increase)`);
    }
    // floor: the INVERSE ratchet — a "good" signal (e.g. test_signal) that must never DROP below baseline.
    if (inv.mode === 'floor' && typeof baseline[inv.id] === 'number' && v < baseline[inv.id]) {
      reasons.push(`dropped ${baseline[inv.id]} -> ${v} (floor: must not decrease)`);
    }
    if (reasons.length) violations.push({ id: inv.id, value: v, baseline: baseline[inv.id], reasons, intent: inv.intent, severity: inv.severity });
  }
  return violations;
}

// severity semantics: only 'warn' is non-blocking (reported, exit 0); anything else — 'block' or an
// absent/unknown severity — blocks (fail strict). This is what makes the meta-ratchet's block->warn
// downgrade defense meaningful: a downgrade WOULD change gate behavior, so guarding it matters.
export function isBlocking(violations) {
  return violations.some((v) => (v.severity || 'block') !== 'warn');
}

function report(dir, invariants, metrics, baseline, violations, suppressionList) {
  console.log(`arch-gate: ${dir}`);
  for (const inv of invariants) {
    const b = baseline[inv.id];
    console.log(`  ${inv.id} [${inv.engine || 'heuristic'}/${inv.lang || 'go'}]: ${metrics[inv.id]}${typeof b === 'number' ? ` (baseline ${b})` : ''}`);
  }
  if (suppressionList.length) {
    console.log('Suppressions (auditable — escape hatch is visible, not silent):');
    for (const s of suppressionList) console.log(`  ~ [${s.id}] line ${s.line}: ${s.reason}`);
  }
  const warns = violations.filter((v) => (v.severity || 'block') === 'warn');
  const blocking = violations.filter((v) => (v.severity || 'block') !== 'warn');
  if (warns.length) {
    console.log('\nWARNINGS (severity "warn" — reported, not blocking):');
    for (const vio of warns) {
      console.log(`  ⚠ [${vio.id}] ${vio.reasons.join('; ')}`);
      console.log(`      intent: ${vio.intent}`);
    }
  }
  if (!violations.length) { console.log('PASS: no architectural-invariant violations.'); return; }
  if (!blocking.length) { console.log('PASS: no blocking violations (warnings above).'); return; }
  console.log('\nBLOCKED — architectural invariant(s) violated:');
  for (const vio of blocking) {
    console.log(`  ✗ [${vio.id}] ${vio.reasons.join('; ')}`);
    console.log(`      intent: ${vio.intent}`);
  }
}

function main() {
  const { dir, writeBaseline, baselineOut, baselineIn, json, invFile } = parseArgs(process.argv.slice(2));
  if (!dir) { console.error('usage: arch-gate.mjs <dir> [--invariants f] [--baseline [--baseline-out f]] [--baseline-in f] [--json]'); process.exit(64); }
  const invariants = invFile ? JSON.parse(readFileSync(invFile, 'utf8')) : INVARIANTS;
  const srcByLang = {};
  const getSrc = (lang) => (srcByLang[lang] ??= readSource(dir, lang));
  const metrics = {};
  try {
    for (const inv of invariants) metrics[inv.id] = metricValue(inv, getSrc(inv.lang || 'go'), dir);
  } catch (e) {
    if (e && e.code === 'ENGINE_UNAVAILABLE') { console.error(`arch-gate: ${e.message}`); process.exit(2); }
    throw e;
  }

  if (writeBaseline) {
    writeFileSync(baselineOut || BASELINE_PATH, JSON.stringify(metrics, null, 2) + '\n');
    if (!json) console.log('baseline written:', JSON.stringify(metrics));
    process.exit(0);
  }

  const suppressionList = Object.entries(collectSuppressions(Object.values(srcByLang).join('\n')))
    .flatMap(([id, ls]) => ls.map((s) => ({ id, ...s })));
  const baselinePath = baselineIn || BASELINE_PATH;
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const violations = computeViolations(invariants, metrics, baseline);
  const blocked = isBlocking(violations);

  if (json) {
    process.stdout.write(JSON.stringify({ dir, metrics, baseline, blocked, violations, suppressions: suppressionList }, null, 2) + '\n');
  } else {
    report(dir, invariants, metrics, baseline, violations, suppressionList);
  }
  process.exit(blocked ? 3 : 0);
}

// Run main() when invoked directly. realpathSync(argv[1]) so a SYMLINKED entry (npm link / a
// global install that symlinks the package dir) still matches import.meta.url, which Node resolves
// to the real path — otherwise the guard silently fails and the gate becomes a no-op (exit 0, no
// output), disabling the hook.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
