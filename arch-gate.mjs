#!/usr/bin/env node
// arch-gate.mjs — P0 architectural-invariant gate (prototype).
//
// Checks a codebase against HUMAN-AUTHORED invariants (invariants.json), RATCHETED against a
// baseline (never-get-worse). Mechanical + deterministic — no model — so no "who verifies the
// verifier" problem. See design/architectural-invariant-gate.md.
//
//   node arch-gate.mjs <dir> --baseline   # record <dir>'s current metrics as the accepted baseline
//   node arch-gate.mjs <dir>              # check <dir>:  exit 0 = pass,  exit 3 = blocked (rot),  64 = usage
//
// NOTE (P0): metric extraction here is lightweight text/brace parsing of Go-flavored source, kept
// reliable on a small sample. Production would delegate to real AST engines (go/ast, ts-morph) and
// pattern engines (semgrep / ast-grep) per the design's adapter model — this proves the gate logic,
// the invariant model, and the ratchet, without that machinery.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INVARIANTS = JSON.parse(readFileSync(join(HERE, 'invariants.json'), 'utf8'));
const BASELINE_PATH = join(HERE, 'baseline.json');

function readSource(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.go'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

// Body between the brace that follows a header match and its matching close brace.
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
function magicIndexCount(src) {
  // identifier indexed by an integer literal — the `ra[3]` positional-fragility smell.
  return (src.match(/\b[A-Za-z_]\w*\[\d+\]/g) || []).length;
}
function metricValue(inv, src) {
  switch (inv.check.kind) {
    case 'struct_field_count': return structFieldCount(src, inv.check.struct);
    case 'switch_case_count': return switchCaseCount(src, inv.check.on);
    case 'magic_index_count': return magicIndexCount(src);
    default: throw new Error(`unknown check kind: ${inv.check.kind}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const writeBaseline = args.includes('--baseline');
  if (!dir) { console.error('usage: arch-gate.mjs <dir> [--baseline]'); process.exit(64); }

  const src = readSource(dir);
  const metrics = {};
  for (const inv of INVARIANTS) metrics[inv.id] = metricValue(inv, src);

  if (writeBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(metrics, null, 2) + '\n');
    console.log('baseline written:', JSON.stringify(metrics));
    process.exit(0);
  }

  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
  const violations = [];
  for (const inv of INVARIANTS) {
    const v = metrics[inv.id];
    const reasons = [];
    if (typeof inv.max === 'number' && v > inv.max) reasons.push(`${v} exceeds absolute max ${inv.max}`);
    if (inv.mode === 'ratchet' && typeof baseline[inv.id] === 'number' && v > baseline[inv.id]) {
      reasons.push(`regressed ${baseline[inv.id]} -> ${v} (ratchet: must not increase)`);
    }
    if (reasons.length) violations.push({ inv, reasons });
  }

  console.log(`arch-gate: ${dir}`);
  for (const inv of INVARIANTS) {
    const b = baseline[inv.id];
    console.log(`  ${inv.id}: ${metrics[inv.id]}${typeof b === 'number' ? ` (baseline ${b})` : ''}`);
  }
  if (!violations.length) { console.log('PASS: no architectural-invariant violations.'); process.exit(0); }
  console.log('\nBLOCKED — architectural invariant(s) violated:');
  for (const { inv, reasons } of violations) {
    console.log(`  ✗ [${inv.id}] ${reasons.join('; ')}`);
    console.log(`      intent: ${inv.intent}`);
  }
  process.exit(3);
}
main();
