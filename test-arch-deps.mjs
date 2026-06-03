// Self-contained test for the supply-chain checks:
//   dependency_count      — ratcheted third-party dependency SURFACE (can't grow silently)
//   unlocked_dependencies — deps DECLARED in package.json but ABSENT from the lockfile
//                           (the offline fingerprint of a hallucinated / slopsquatted package)
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
const writeInv = (inv) => { const f = tmp('arch-dep-inv-') + '/inv.json'; writeFileSync(f, JSON.stringify(inv)); return f; };
const writePkg = (dir, deps, dev) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', dependencies: deps, devDependencies: dev || {} }, null, 2));
const writeLock = (dir, names) => writeFileSync(join(dir, 'package-lock.json'),
  JSON.stringify({ name: 'fx', lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: '1.0.0' }])) } }, null, 2));
const run = (dir, inv, extra = []) => { const r = spawnSync('node', [GATE, dir, '--invariants', inv, ...extra], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

// ── dependency_count: ratchet on declared surface ───────────────────────────────
{
  const inv = writeInv([{ id: 'dep-surface', intent: 'dependency surface must not grow silently', check: { kind: 'dependency_count' }, mode: 'ratchet', severity: 'block' }]);
  const d = tmp('arch-dep-');
  writePkg(d, { a: '^1', b: '^2' });
  const base = join(d, 'base.json');
  run(d, inv, ['--baseline', '--baseline-out', base]); // baseline = 2
  // unchanged -> pass
  let r = run(d, inv, ['--baseline-in', base]);
  expect('dependency_count unchanged (2) PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
  // add a dep -> regress 2 -> 3 -> block
  writePkg(d, { a: '^1', b: '^2', c: '^3' });
  r = run(d, inv, ['--baseline-in', base]);
  expect('dependency_count grew 2->3 BLOCKED', r.code === 3 && /✗ \[dep-surface\]/.test(r.out), `exit ${r.code}: ${r.out}`);
}

// ── unlocked_dependencies: hallucinated package guard ───────────────────────────
{
  const inv = writeInv([{ id: 'no-ghost-deps', intent: 'every declared dep must resolve in the lockfile', check: { kind: 'unlocked_dependencies' }, max: 0, severity: 'block' }]);
  // ghost-pkg declared but not in the lockfile -> 1 unlocked -> block
  const d1 = tmp('arch-dep-');
  writePkg(d1, { 'real-pkg': '^1', 'ghost-pkg': '^1' });
  writeLock(d1, ['real-pkg']);
  let r = run(d1, inv);
  expect('declared-but-unlocked dep BLOCKED', r.code === 3 && /✗ \[no-ghost-deps\]/.test(r.out), `exit ${r.code}: ${r.out}`);
  // all declared deps resolved -> pass
  const d2 = tmp('arch-dep-');
  writePkg(d2, { 'real-pkg': '^1' }, { 'dev-pkg': '^1' });
  writeLock(d2, ['real-pkg', 'dev-pkg']);
  r = run(d2, inv);
  expect('all deps locked PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
  // allow-list exempts a deliberate unlocked dep (e.g. a local file:/workspace: link)
  const inv2 = writeInv([{ id: 'no-ghost-deps', intent: 'x', check: { kind: 'unlocked_dependencies', allow: ['ghost-pkg'] }, max: 0, severity: 'block' }]);
  r = run(d1, inv2);
  expect('allow-listed unlocked dep PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`);
}

console.log(failed === 0 ? '\nPASS: dependency surface ratchets; hallucinated (unlocked) deps blocked ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
