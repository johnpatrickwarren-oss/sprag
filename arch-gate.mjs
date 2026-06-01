#!/usr/bin/env node
// arch-gate.mjs — P0 architectural-invariant gate (prototype).
//
// Checks a codebase against HUMAN-AUTHORED invariants (invariants.json), RATCHETED against a
// baseline (never-get-worse). Mechanical + deterministic — no model — so no "who verifies the
// verifier" problem. See design/architectural-invariant-gate.md.
//
//   node arch-gate.mjs <dir> --baseline [--baseline-out f]   # record <dir>'s metrics as baseline
//   node arch-gate.mjs <dir> [--baseline-in f] [--json]      # check: exit 0 = pass, 3 = blocked
//
// Auditable suppressions: a per-occurrence check (e.g. no-positional-rows) is suppressed on a line
// carrying `// anchor:allow <invariant-id>: <reason>`. Suppressed instances are NOT counted as
// violations but ARE reported (an escape hatch that's visible, not silent). Metric/ratchet
// invariants are "suppressed" deliberately by re-recording the baseline, not by a line comment.
//
// NOTE (P0): metric extraction is lightweight text/brace parsing of Go-flavored source. Production
// would delegate to real AST engines (go/ast, ts-morph) + pattern engines (semgrep / ast-grep) per
// the design's adapter model — this proves the invariant model, ratchet, suppressions, and gate.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INVARIANTS = JSON.parse(readFileSync(join(HERE, 'invariants.json'), 'utf8'));
const BASELINE_PATH = join(HERE, 'baseline.json');

export function readSource(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.go'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

// `// anchor:allow <id>: <reason>` -> { id: [{ line, reason }] }
export function collectSuppressions(src) {
  const out = {};
  src.split('\n').forEach((line, i) => {
    const m = line.match(/anchor:allow\s+([\w-]+)\s*:\s*(.+?)\s*$/);
    if (m) (out[m[1]] ||= []).push({ line: i + 1, reason: m[2] });
  });
  return out;
}

function blockBody(src, headerRe) {
  const m = headerRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, body = '';
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth > 0) body += c;
    i++;
  }
  return body;
}
function structFieldCount(src, name) {
  const body = blockBody(src, new RegExp(`type\\s+${name}\\s+struct\\s*\\{`));
  if (body == null) return 0;
  return body.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*')).length;
}
function switchCaseCount(src, onExpr) {
  const esc = onExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = blockBody(src, new RegExp(`switch\\s+${esc}\\s*\\{`));
  if (body == null) return 0;
  return (body.match(/\bcase\b/g) || []).length;
}
// per-line so lines carrying an `anchor:allow no-positional-rows` suppression are excluded.
function magicIndexCount(src) {
  let n = 0;
  for (const line of src.split('\n')) {
    if (/anchor:allow\s+no-positional-rows\b/.test(line)) continue;
    n += (line.match(/\b[A-Za-z_]\w*\[\d+\]/g) || []).length;
  }
  return n;
}
export function metricValue(inv, src) {
  switch (inv.check.kind) {
    case 'struct_field_count': return structFieldCount(src, inv.check.struct);
    case 'switch_case_count': return switchCaseCount(src, inv.check.on);
    case 'magic_index_count': return magicIndexCount(src);
    default: throw new Error(`unknown check kind: ${inv.check.kind}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null, writeBaseline = false, baselineOut = null, baselineIn = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') writeBaseline = true;
    else if (a === '--baseline-out') baselineOut = argv[++i];
    else if (a === '--baseline-in') baselineIn = argv[++i];
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) dir = a;
    else { console.error(`arch-gate: unknown arg ${a}`); process.exit(64); }
  }
  if (!dir) { console.error('usage: arch-gate.mjs <dir> [--baseline [--baseline-out f]] [--baseline-in f] [--json]'); process.exit(64); }

  const src = readSource(dir);
  const metrics = {};
  for (const inv of INVARIANTS) metrics[inv.id] = metricValue(inv, src);

  if (writeBaseline) {
    const out = baselineOut || BASELINE_PATH;
    writeFileSync(out, JSON.stringify(metrics, null, 2) + '\n');
    if (!json) console.log('baseline written:', JSON.stringify(metrics));
    process.exit(0);
  }

  const suppressions = collectSuppressions(src);
  const baselinePath = baselineIn || BASELINE_PATH;
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const violations = [];
  for (const inv of INVARIANTS) {
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
  for (const inv of INVARIANTS) {
    const b = baseline[inv.id];
    console.log(`  ${inv.id}: ${metrics[inv.id]}${typeof b === 'number' ? ` (baseline ${b})` : ''}`);
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

// Run as CLI only when executed directly (so the extractors can be imported, e.g. by arch-trend.mjs).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
