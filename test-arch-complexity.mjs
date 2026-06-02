// Self-contained test for the `max_complexity` check (cyclomatic complexity, ast-grep). The point vs
// `max_function_lines`: it flags BRANCHY functions, not long-but-flat ones — a less-arbitrary signal.
// Proves: a long flat function passes, a branchy function blocks, and suppression is honored. Zero
// model cost — pure AST counting (decision nodes + short-circuit booleans), same parse as god-functions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const INV = mkdtempSync(join(tmpdir(), 'arch-cx-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'max-complexity', intent: 'no function over cyclomatic 5', check: { kind: 'max_complexity', maxComplexity: 5 }, max: 0, mode: 'ratchet', severity: 'block', lang: 'js', engine: 'ast-grep' }]));
const gate = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const dirWith = (body) => { const d = mkdtempSync(join(tmpdir(), 'arch-cx-')); writeFileSync(join(d, 'f.mjs'), body); return d; };

// 1. a LONG but FLAT function (40 straight-line statements, no branches) -> PASS.
//    This is the whole point: length alone is not complexity. `max_function_lines` would flag this; `max_complexity` does not.
{ const flatLong = 'export function flat() {\n' + Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join('\n') + '\n  return 0;\n}\n';
  const r = gate(dirWith(flatLong)); expect('long-but-flat function PASSES (length != complexity)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 2. a short but BRANCHY function (many decision points) -> BLOCKED.
{ const branchy = `export function branchy(a, b, c, d) {
  if (a && b) return 1;
  if (c || d) return 2;
  for (let i = 0; i < c; i++) { if (i % 2 === 0) return i; }
  while (d) { if (a) break; }
  return a ? (b ? 3 : 4) : 5;
}\n`;
  const r = gate(dirWith(branchy)); expect('branchy function BLOCKED (cyclomatic > 5)', r.code === 3 && /✗ \[max-complexity\]/.test(r.out), `exit ${r.code}: ${r.out}`); }

// 3. suppression: the same branchy function with `anchor:allow` is NOT counted.
{ const branchy = `// anchor:allow max-complexity: cohesive dispatch, reviewed in #321
export function branchy(a, b, c, d) {
  if (a && b) return 1;
  if (c || d) return 2;
  for (let i = 0; i < c; i++) { if (i % 2 === 0) return i; }
  return a ? (b ? 3 : 4) : 5;
}\n`;
  const r = gate(dirWith(branchy)); expect('suppressed branchy function NOT counted', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: max_complexity flags branchy (not long-flat) functions, honors suppression ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
