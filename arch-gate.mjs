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
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const INVARIANTS = JSON.parse(readFileSync(join(HERE, 'invariants.json'), 'utf8'));
const BASELINE_PATH = join(HERE, 'baseline.json');

const EXT = { go: ['.go'], ts: ['.ts', '.tsx'], tsx: ['.ts', '.tsx'] };
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
let _sg = null, _goRegistered = false;
function sgRoot(src, lang) {
  if (!_sg) _sg = require('@ast-grep/napi');
  if (lang === 'go') {
    if (!_goRegistered) { _sg.registerDynamicLanguage({ go: require('@ast-grep/lang-go') }); _goRegistered = true; }
    return _sg.parse('go', src).root();
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
function scopeOutOfBoundsCount(src, allowed) {
  const labels = [...src.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]);
  const set = new Set(allowed || []);
  return labels.filter((l) => !set.has(l)).length;
}

// oversized_files (generic, language-agnostic, no per-project tuning): count source files whose
// line count exceeds maxLines — the "God file" smell. Recurses, skipping deps/vcs.
const SRC_EXTS = ['.go', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.py', '.rs', '.java', '.rb', '.sh'];
function oversizedFilesCount(dir, maxLines) {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!SRC_EXTS.some((e) => name.endsWith(e))) continue;
      if (readFileSync(p, 'utf8').split('\n').length > maxLines) n++;
    }
  };
  walk(dir);
  return n;
}

export function metricValue(inv, src, dir) {
  if (inv.check.kind === 'oversized_files') return oversizedFilesCount(dir, inv.check.maxLines);
  if (inv.check.kind === 'scope_diff') return scopeOutOfBoundsCount(src, inv.check.allowed);
  return (inv.engine === 'ast-grep') ? astgrepMetric(inv, src) : heuristicMetric(inv, src);
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null, writeBaseline = false, baselineOut = null, baselineIn = null, json = false, invFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') writeBaseline = true;
    else if (a === '--baseline-out') baselineOut = argv[++i];
    else if (a === '--baseline-in') baselineIn = argv[++i];
    else if (a === '--invariants') invFile = argv[++i];
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) dir = a;
    else { console.error(`arch-gate: unknown arg ${a}`); process.exit(64); }
  }
  if (!dir) { console.error('usage: arch-gate.mjs <dir> [--invariants f] [--baseline [--baseline-out f]] [--baseline-in f] [--json]'); process.exit(64); }

  const invariants = invFile ? JSON.parse(readFileSync(invFile, 'utf8')) : INVARIANTS;
  const srcByLang = {};
  const getSrc = (lang) => (srcByLang[lang] ??= readSource(dir, lang));

  const metrics = {};
  for (const inv of invariants) metrics[inv.id] = metricValue(inv, getSrc(inv.lang || 'go'), dir);

  if (writeBaseline) {
    const out = baselineOut || BASELINE_PATH;
    writeFileSync(out, JSON.stringify(metrics, null, 2) + '\n');
    if (!json) console.log('baseline written:', JSON.stringify(metrics));
    process.exit(0);
  }

  const allSrc = Object.values(srcByLang).join('\n');
  const suppressions = collectSuppressions(allSrc);
  const baselinePath = baselineIn || BASELINE_PATH;
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
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
  const blocked = violations.length > 0;
  const suppressionList = Object.entries(suppressions).flatMap(([id, ls]) => ls.map((s) => ({ id, ...s })));

  if (json) {
    process.stdout.write(JSON.stringify({ dir, metrics, baseline, blocked, violations, suppressions: suppressionList }, null, 2) + '\n');
    process.exit(blocked ? 3 : 0);
  }

  console.log(`arch-gate: ${dir}`);
  for (const inv of invariants) {
    const b = baseline[inv.id];
    console.log(`  ${inv.id} [${inv.engine || 'heuristic'}/${inv.lang || 'go'}]: ${metrics[inv.id]}${typeof b === 'number' ? ` (baseline ${b})` : ''}`);
  }
  if (suppressionList.length) {
    console.log('Suppressions (auditable — escape hatch is visible, not silent):');
    for (const s of suppressionList) console.log(`  ~ [${s.id}] line ${s.line}: ${s.reason}`);
  }
  if (!blocked) { console.log('PASS: no architectural-invariant violations.'); process.exit(0); }
  console.log('\nBLOCKED — architectural invariant(s) violated:');
  for (const vio of violations) {
    console.log(`  ✗ [${vio.id}] ${vio.reasons.join('; ')}`);
    console.log(`      intent: ${vio.intent}`);
  }
  process.exit(3);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
