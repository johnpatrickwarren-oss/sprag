// Unit tests for arch-gate's exported building blocks. The existing suites drive the gate END-TO-END
// (spawn the CLI, assert pass/block); they leave the detectors' BOUNDARY behavior — the exact line at
// which "ok" becomes "over", the zero/empty cases, the ratchet vs absolute-max logic — unasserted.
// `arch mutate` surfaced those as surviving mutants. This file kills them by asserting exact metric
// values right at the limit, so a flipped `>`/`<=`/`&&`/`===` changes an assertion.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSource, collectSuppressions, metricValue, computeViolations, parseArgs,
} from './arch-gate.mjs';

let failed = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `  -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) failed++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'arch-unit-'));
const write = (d, name, body) => { const p = join(d, name); writeFileSync(p, body); return p; };
const mv = (check, src, dir, extra = {}) => metricValue({ id: 'x', check, ...extra }, src, dir);

// ── readSource: only matching extensions, concatenated ──────────────────────────
{ const d = tmp();
  write(d, 'a.go', 'package a\n'); write(d, 'b.go', 'package b\n'); write(d, 'c.ts', 'x\n');
  const go = readSource(d, 'go');
  eq('readSource(go) picks both .go files, skips .ts', /package a/.test(go) && /package b/.test(go) && !/x/.test(go), true);
  eq('readSource on a missing dir is empty', readSource(join(d, 'nope'), 'go'), ''); }

// ── collectSuppressions: capture id + reason on the right line; ignore plain lines ─
{ const supp = collectSuppressions('clean\n// anchor:allow my-rule: a good reason\nmore\n');
  eq('suppression id captured', Object.keys(supp), ['my-rule']);
  eq('suppression line number is 1-based', supp['my-rule'][0].line, 2);
  eq('suppression reason captured', supp['my-rule'][0].reason, 'a good reason');
  eq('no suppression -> empty object', collectSuppressions('just code\n'), {}); }

// ── max_function_lines: the boundary. A fn of exactly maxLines is OK; one line longer is over. ───
{ const d = tmp();
  // body() spans exactly 5 lines (decl line .. closing brace). atLimit maxLines:5 -> 0; maxLines:4 -> 1.
  write(d, 'f.ts', 'function body() {\n  const a = 1;\n  const b = 2;\n  return a;\n}\n');
  eq('fn exactly at maxLines is NOT over (boundary: > not >=)', mv({ kind: 'max_function_lines', maxLines: 5 }, '', d, { lang: 'ts', engine: 'ast-grep' }), 0);
  eq('fn one line over maxLines IS over', mv({ kind: 'max_function_lines', maxLines: 4 }, '', d, { lang: 'ts', engine: 'ast-grep' }), 1); }

// ── max_complexity: starts at 1, +1 per decision node and per &&/||. ─────────────
{ const d = tmp();
  // flat() has complexity 1 (no branches). branchy() has 1 + 2 ifs + 1 && = 4.
  write(d, 'g.ts', 'function flat() { return 1; }\nfunction branchy(a, b) {\n  if (a) { return 1; }\n  if (b && a) { return 2; }\n  return 3;\n}\n');
  eq('both fns under a high complexity limit -> 0', mv({ kind: 'max_complexity', maxComplexity: 10 }, '', d, { lang: 'ts', engine: 'ast-grep' }), 0);
  eq('branchy fn (cx 4) over limit 3 -> 1', mv({ kind: 'max_complexity', maxComplexity: 3 }, '', d, { lang: 'ts', engine: 'ast-grep' }), 1);
  eq('branchy fn (cx 4) exactly at limit 4 -> 0 (boundary: <= not <)', mv({ kind: 'max_complexity', maxComplexity: 4 }, '', d, { lang: 'ts', engine: 'ast-grep' }), 0); }

// ── switch_case_count (ast-grep): counts cases; a zero-case switch is 0, not a crash. ─────────────
{ const src = 'switch (x) {\n  case 1: break;\n  case 2: break;\n  case 3: break;\n}\n';
  eq('3-case switch counts 3', mv({ kind: 'switch_case_count', on: 'x' }, src, null, { engine: 'ast-grep', lang: 'ts' }), 3); }

// ── switch_case_count (heuristic, Go text): the `|| []` empty-match fallback must hold at 0. ──────
{ eq('heuristic switch with cases counts them', mv({ kind: 'switch_case_count', on: 'v' }, 'switch v {\ncase 1:\ncase 2:\n}\n', null), 2);
  eq('heuristic switch with NO cases -> 0 (|| [] fallback, not a crash)', mv({ kind: 'switch_case_count', on: 'v' }, 'switch v {\n}\n', null), 0); }

// ── magic_index_count (heuristic): counts arr[3]; a suppressed line is skipped. ───────────────────
{ eq('two magic-index reads counted', mv({ kind: 'magic_index_count' }, 'a := ra[3]\nb := rb[7]\n', null, { id: 'no-pos' }), 2);
  eq('a suppressed magic-index line is skipped', mv({ kind: 'magic_index_count' }, 'a := ra[3] // anchor:allow no-pos: ok\nb := rb[7]\n', null, { id: 'no-pos' }), 1); }

// ── scope_diff: case-labels outside the allowed set count as scope creep. ────────────────────────
{ eq('out-of-scope dispatch label counted, allowed ones ignored',
    mv({ kind: 'scope_diff', allowed: ['create', 'read'] }, 'case "create":\ncase "read":\ncase "delete":\n', null), 1); }

// ── oversized_files: file at maxLines OK, over is counted. ───────────────────────────────────────
{ const d = tmp();
  write(d, 'small.ts', 'a\n'.repeat(10)); write(d, 'big.ts', 'a\n'.repeat(40));
  eq('one file over the line limit is flagged, the small one is not', mv({ kind: 'oversized_files', maxLines: 20 }, '', d), 1); }

// ── computeViolations: absolute max + ratchet boundaries (the core gate decision). ───────────────
{ const inv = [{ id: 'm', mode: 'ratchet', max: 5, intent: 'i', severity: 'block', check: {} }];
  eq('value at the absolute max is NOT a violation (> not >=)', computeViolations(inv, { m: 5 }, {}).length, 0);
  eq('value over the absolute max IS a violation', computeViolations(inv, { m: 6 }, {}).length, 1);
  eq('ratchet: equal to baseline is OK', computeViolations(inv, { m: 3 }, { m: 3 }).length, 0);
  eq('ratchet: above baseline (but under max) is a violation', computeViolations(inv, { m: 4 }, { m: 3 }).length, 1);
  // non-ratchet mode must NOT apply the baseline regression rule.
  const noRatchet = [{ id: 'm', mode: 'absolute', max: 5, intent: 'i', severity: 'block', check: {} }];
  eq('non-ratchet mode ignores baseline regressions', computeViolations(noRatchet, { m: 4 }, { m: 3 }).length, 0); }

// ── parseArgs: flags map to the right fields; bare arg is the dir. ───────────────────────────────
{ const o = parseArgs(['mydir', '--json', '--invariants', 'inv.json', '--baseline-in', 'b.json']);
  eq('parseArgs reads dir', o.dir, 'mydir');
  eq('parseArgs reads --json', o.json, true);
  eq('parseArgs reads --invariants value', o.invFile, 'inv.json');
  eq('parseArgs reads --baseline-in value', o.baselineIn, 'b.json');
  eq('parseArgs --baseline default false when absent', parseArgs(['d']).writeBaseline, false); }

console.log(failed === 0 ? '\nPASS: detector boundaries + core gate logic asserted directly ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
