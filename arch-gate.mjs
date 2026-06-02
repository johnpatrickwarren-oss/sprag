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

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isGeneratedFile, oversizedFilesCount, moduleFaninCount, forbidPathRefCount, timeBombTestCount, untestedModuleCount } from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

// ── ast-grep engine (real AST; TypeScript/JS via @ast-grep/napi) ────────────────
let _sg = null, _goRegistered = false, _pyRegistered = false;
function sgRoot(src, lang) {
  if (!_sg) _sg = require('@ast-grep/napi');
  if (lang === 'go') {
    if (!_goRegistered) { _sg.registerDynamicLanguage({ go: require('@ast-grep/lang-go') }); _goRegistered = true; }
    return _sg.parse('go', src).root();
  }
  if (lang === 'python' || lang === 'py') {
    if (!_pyRegistered) { _sg.registerDynamicLanguage({ python: require('@ast-grep/lang-python') }); _pyRegistered = true; }
    return _sg.parse('python', src).root();
  }
  return _sg.parse('Tsx', src).root();
}
function astgrepMetric(inv, src) {
  const c = inv.check;
  const root = sgRoot(src, inv.lang || 'ts');
  const lines = src.split('\n');
  const supRe = inv.id && new RegExp(`anchor:allow\\s+${inv.id}\\b`);
  const notSuppressed = (n) => !(supRe && supRe.test(lines[n.range().start.line] || ''));

  if (c.kind === 'magic_index_count') {
    return root.findAll('$A[$N]')
      .filter((n) => /^\d+$/.test(n.getMatch('N')?.text() ?? ''))
      .filter(notSuppressed).length;
  }
  if (c.kind === 'forbid_pattern') {
    // author-supplied structural rule: a `pattern`, optionally only when `inside` another node
    // (by `inside` pattern or `inside_kind` node kind, e.g. go_statement for "inside a goroutine").
    const rule = { pattern: c.pattern };
    if (c.inside_kind) rule.inside = { kind: c.inside_kind, stopBy: 'end' };
    else if (c.inside) rule.inside = { pattern: c.inside, stopBy: 'end' };
    return root.findAll({ rule }).filter(notSuppressed).length;
  }
  if (c.kind === 'ast_grep_rule') {
    // FULL extensibility: the invariant carries a raw ast-grep rule object (pattern / kind / inside /
    // has / all / any / not / regex / ...). Counts matches (suppression-aware). Lets a project encode
    // its OWN architectural rules in JSON with no code changes.
    return root.findAll({ rule: c.rule }).filter(notSuppressed).length;
  }
  if (c.kind === 'max_function_lines') {
    // generic God-function detector: count functions whose line span exceeds maxLines (lang-aware).
    const lang = inv.lang || 'ts';
    const kinds = lang === 'go' ? ['function_declaration', 'method_declaration', 'func_literal']
      : (lang === 'python' || lang === 'py') ? ['function_definition']
      : ['function_declaration', 'arrow_function', 'method_definition', 'function_expression', 'generator_function_declaration'];
    let over = 0;
    for (const k of kinds) {
      for (const f of root.findAll({ rule: { kind: k } })) {
        const r = f.range();
        if ((r.end.line - r.start.line + 1) > c.maxLines && notSuppressed(f)) over++;
      }
    }
    return over;
  }
  const isGo = (inv.lang || 'ts') === 'go';
  if (c.kind === 'struct_field_count') {
    if (isGo) {
      const st = root.find(`type ${c.struct} struct { $$$ }`);
      return st ? st.findAll({ rule: { kind: 'field_declaration' } }).length : 0;
    }
    const cls = root.find(`class ${c.struct} { $$$ }`) || root.find(`interface ${c.struct} { $$$ }`);
    if (!cls) return 0;
    return cls.findAll({ rule: { kind: 'public_field_definition' } }).length
      + cls.findAll({ rule: { kind: 'property_signature' } }).length;
  }
  if (c.kind === 'switch_case_count') {
    const sw = root.findAll({ rule: { kind: isGo ? 'expression_switch_statement' : 'switch_statement' } });
    if (!sw.length) return 0;
    return sw[0].findAll({ rule: { kind: isGo ? 'expression_case' : 'switch_case' } }).length;
  }
  throw new Error(`ast-grep: unknown check kind ${c.kind}`);
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
      if (name === 'node_modules' || name === '.git' || name === 'vendor' || name.startsWith('.')) continue;
      if (statSync(join(dir, name)).isDirectory() && !set.has(name)) n++;
    }
  }
  return n;
}

// God-function detector, recursive + PER FILE: readSource() concatenates only the top-level dir, so
// on a nested tree (e.g. packages/cli/src/) the concatenated path counts 0. This walks the tree and
// parses each file on its own (the correct unit — concatenating mixed files into one parse is fragile),
// summing functions whose line span exceeds maxLines. Suppression-aware via `anchor:allow <id>`.
const FN_JS_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const FN_EXTS = { go: ['.go'], python: ['.py'], py: ['.py'], ts: FN_JS_EXTS, js: FN_JS_EXTS };
const FN_KINDS = {
  go: ['function_declaration', 'method_declaration', 'func_literal'],
  python: ['function_definition'], py: ['function_definition'],
  ts: ['function_declaration', 'arrow_function', 'method_definition', 'function_expression', 'generator_function_declaration'],
};
function godFunctionCount(dir, maxLines, lang, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const exts = FN_EXTS[lang] || FN_EXTS.ts;
  const kinds = FN_KINDS[lang] || FN_KINDS.ts;
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let over = 0;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.git' || n === 'vendor') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!exts.some((e) => n.endsWith(e)) || isGeneratedFile(p)) continue;
      const src = readFileSync(p, 'utf8');
      let root;
      try { root = sgRoot(src, lang); } catch { continue; } // parse error: skip this file
      const lines = src.split('\n');
      for (const k of kinds) {
        for (const f of root.findAll({ rule: { kind: k } })) {
          const r = f.range();
          if ((r.end.line - r.start.line + 1) <= maxLines) continue;
          if (supRe && supRe.test(lines[r.start.line] || '')) continue;
          over++;
        }
      }
    }
  };
  walk(dir);
  return over;
}

// Cyclomatic-complexity decision nodes per language (control-flow branch points). A function's
// complexity ≈ 1 + (decision nodes) + (short-circuit && / || / and / or) within it — a LESS-ARBITRARY
// signal than raw line count: it flags BRANCHY functions (hard to follow + test; cyclomatic > ~10 is
// the McCabe/NIST anchor), not merely long-but-flat ones. Reuses the same ast-grep parse as the
// god-function check, so it is deterministic and adds no model cost. Conservative: a function's count
// includes branches inside nested closures — fine for a ratcheted floor; suppress legit cases.
const DECISION_KINDS = {
  go: ['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case'],
  python: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
  py: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
  ts: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
};
DECISION_KINDS.js = DECISION_KINDS.ts;
const boolPatterns = (lang) => ((lang === 'python' || lang === 'py') ? ['$A and $B', '$A or $B'] : ['$A && $B', '$A || $B']);
function complexFunctionCount(dir, maxComplexity, lang, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const exts = FN_EXTS[lang] || FN_EXTS.ts;
  const fnKinds = FN_KINDS[lang] || FN_KINDS.ts;
  const decisionKinds = DECISION_KINDS[lang] || DECISION_KINDS.ts;
  const bools = boolPatterns(lang);
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let over = 0;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.git' || n === 'vendor') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!exts.some((e) => n.endsWith(e)) || isGeneratedFile(p)) continue;
      const src = readFileSync(p, 'utf8');
      let root;
      try { root = sgRoot(src, lang); } catch { continue; } // parse error: skip this file
      const lines = src.split('\n');
      for (const fk of fnKinds) {
        for (const fn of root.findAll({ rule: { kind: fk } })) {
          let cx = 1;
          for (const dk of decisionKinds) cx += fn.findAll({ rule: { kind: dk } }).length;
          for (const bp of bools) cx += fn.findAll({ rule: { pattern: bp } }).length;
          if (cx <= maxComplexity) continue;
          const sl = fn.range().start.line; // suppression on the function line OR the line directly above
          if (supRe && (supRe.test(lines[sl] || '') || supRe.test(lines[sl - 1] || ''))) continue;
          over++;
        }
      }
    }
  };
  walk(dir);
  return over;
}

export function metricValue(inv, src, dir) {
  if (inv.check.kind === 'module_fanin') return moduleFaninCount(dir, inv.check.maxFanin);
  if (inv.check.kind === 'oversized_files') return oversizedFilesCount(dir, inv.check.maxLines);
  if (inv.check.kind === 'forbid_path') return forbidPathRefCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'time_bomb_tests') return timeBombTestCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'require_tests') return untestedModuleCount(dir, inv.check, inv.id);
  if (inv.check.kind === 'scope_diff') return scopeOutOfBoundsCount(src, inv.check, dir);
  // God-function check: prefer the recursive per-file walk when we have a dir (correct on nested
  // trees); fall back to the concatenated single-parse when only `src` is available.
  if (inv.check.kind === 'max_function_lines' && dir && existsSync(dir)) {
    return godFunctionCount(dir, inv.check.maxLines, inv.lang || 'ts', inv.id);
  }
  if (inv.check.kind === 'max_complexity' && dir && existsSync(dir)) {
    return complexFunctionCount(dir, inv.check.maxComplexity ?? 10, inv.lang || 'ts', inv.id);
  }
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
    if (reasons.length) violations.push({ id: inv.id, value: v, baseline: baseline[inv.id], reasons, intent: inv.intent, severity: inv.severity });
  }
  return violations;
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
  if (!violations.length) { console.log('PASS: no architectural-invariant violations.'); return; }
  console.log('\nBLOCKED — architectural invariant(s) violated:');
  for (const vio of violations) {
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
  for (const inv of invariants) metrics[inv.id] = metricValue(inv, getSrc(inv.lang || 'go'), dir);

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
  const blocked = violations.length > 0;

  if (json) {
    process.stdout.write(JSON.stringify({ dir, metrics, baseline, blocked, violations, suppressions: suppressionList }, null, 2) + '\n');
  } else {
    report(dir, invariants, metrics, baseline, violations, suppressionList);
  }
  process.exit(blocked ? 3 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
