// Self-contained test: the gate FAILS CLOSED when the ast-grep engine can't load.
// Regression guard for the silent-no-op hole — a missing/broken engine used to make every ast-grep
// check return 0 and the gate PASS everything (the worst failure mode for a gate). It must ERROR
// (exit 2) instead. ARCH_ENGINE_UNAVAILABLE forces the load failure deterministically (so the test
// is independent of whether @ast-grep/napi is actually installed).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const writeInv = (inv) => { const f = tmp('arch-fc-inv-') + '/inv.json'; writeFileSync(f, JSON.stringify(inv)); return f; };
const run = (dir, inv) => { const r = spawnSync('node', [GATE, dir, '--invariants', inv], { encoding: 'utf8', env: { ...process.env, ARCH_ENGINE_UNAVAILABLE: '1' } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

// An ast-grep check with the engine unavailable must ERROR (exit 2), NOT score 0 and PASS.
{
  const inv = writeInv([{ id: 'no-god-functions', intent: 'no long functions', check: { kind: 'max_function_lines', maxLines: 3 }, engine: 'ast-grep', lang: 'ts', mode: 'ratchet', severity: 'block' }]);
  const d = tmp('arch-fc-');
  writeFileSync(join(d, 'big.ts'), 'function f() {\n  let a = 1;\n  let b = 2;\n  let c = 3;\n  return a + b + c;\n}\n'); // 6-line fn > 3
  const r = run(d, inv);
  expect('ast-grep check with engine down ERRORS (exit 2), does not silently PASS', r.code === 2 && /unavailable/i.test(r.out) && !/PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// A non-engine check (dependency_count) must still run with the engine unavailable — the engine loads
// lazily, so fail-closed is scoped to checks that actually need it (heuristic/dependency checks are fine).
{
  const inv = writeInv([{ id: 'dep-surface', intent: 'x', check: { kind: 'dependency_count' }, mode: 'ratchet', severity: 'block' }]);
  const d = tmp('arch-fc-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'fx', dependencies: { a: '^1' } }));
  const r = run(d, inv);
  expect('non-engine check still runs with engine down (lazy load, no false abort)', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
}

console.log(failed === 0 ? '\nPASS: gate fails CLOSED on a dead engine; non-engine checks unaffected ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
