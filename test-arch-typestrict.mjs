// Self-contained test for the type-strictness tenets via the recursive author-rule counter
// (ast_grep_tree): counts `any` / non-null `!` / `@ts-ignore` across the WHOLE tree (incl. nested
// dirs — the case the top-level-only ast_grep_rule misses), ratchets them, and honors suppression.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'arch-ts-'));
const writeInv = (rule, id = 'rule') => { const f = mkdtempSync(join(tmpdir(), 'arch-ts-inv-')) + '/inv.json'; writeFileSync(f, JSON.stringify([{ id, intent: 'x', check: { kind: 'ast_grep_tree', lang: 'ts', rule }, mode: 'ratchet', severity: 'block' }])); return f; };
const metric = (dir, inv, id = 'rule') => { const r = spawnSync('node', [GATE, dir, '--invariants', inv, '--json'], { encoding: 'utf8' }); try { return JSON.parse(r.stdout).metrics[id]; } catch { return `ERR ${r.status}: ${r.stdout}${r.stderr}`; } };
const ANY = { kind: 'predefined_type', regex: '^any$' };

// `any` is counted recursively — including a NESTED subdir (the recursion fix vs top-level-only).
{
  const d = tmp();
  mkdirSync(join(d, 'deep'), { recursive: true });
  writeFileSync(join(d, 'a.ts'), 'let x: any = 1;\n');               // top level
  writeFileSync(join(d, 'deep', 'b.ts'), 'const y = z as any;\n');   // nested -> proves recursion
  expect('any counted across nested tree (= 2)', metric(d, writeInv(ANY)) === 2, `got ${metric(d, writeInv(ANY))}`);
}

// suppression: an `anchor:allow` on the line drops that match (visible, not counted).
{
  const d = tmp();
  writeFileSync(join(d, 'a.ts'), 'let x: any = 1; // anchor:allow rule: legacy boundary\nlet w: any = 2;\n');
  expect('suppressed any not counted (= 1 of 2)', metric(d, writeInv(ANY)) === 1, `got ${metric(d, writeInv(ANY))}`);
}

// non-null assertion `x!` counted; boolean `!`/`!=` not.
{
  const d = tmp();
  writeFileSync(join(d, 'a.ts'), 'const a = b!.c;\nconst e = f!;\nconst g = !h;\nif (i != j) {}\n');
  expect('non-null `!` counted (= 2), boolean ! ignored', metric(d, writeInv({ kind: 'non_null_expression' })) === 2, `got ${metric(d, writeInv({ kind: 'non_null_expression' }))}`);
}

// @ts-ignore / @ts-nocheck counted; @ts-expect-error (self-removing) deliberately NOT.
{
  const d = tmp();
  writeFileSync(join(d, 'a.ts'), '// @ts-ignore\nconst a = 1;\n// @ts-nocheck\nconst b = 2;\n// @ts-expect-error\nconst c = 3;\n');
  const inv = writeInv({ kind: 'comment', regex: '@ts-(ignore|nocheck)' });
  expect('@ts-ignore/@ts-nocheck counted (= 2), @ts-expect-error ignored', metric(d, inv) === 2, `got ${metric(d, inv)}`);
}

// ratchet: baseline the current `any` count, add one more -> block.
{
  const d = tmp();
  writeFileSync(join(d, 'a.ts'), 'let x: any = 1;\n');
  const inv = writeInv(ANY);
  const base = join(d, 'base.json');
  spawnSync('node', [GATE, d, '--invariants', inv, '--baseline', '--baseline-out', base], { encoding: 'utf8' }); // baseline = 1
  writeFileSync(join(d, 'a.ts'), 'let x: any = 1;\nlet y: any = 2;\n'); // now 2 > 1
  const r = spawnSync('node', [GATE, d, '--invariants', inv, '--baseline-in', base], { encoding: 'utf8' });
  expect('new `any` regresses the ratchet -> BLOCKED', r.status === 3 && /✗ \[rule\]/.test(r.stdout + r.stderr), `exit ${r.status}: ${r.stdout}${r.stderr}`);
}

console.log(failed === 0 ? '\nPASS: type-strictness counts any/non-null/ts-ignore recursively, ratchets, suppresses ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
