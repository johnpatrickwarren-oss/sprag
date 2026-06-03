// Self-contained test for config_relaxations (the meta-ratchet): the gate guards its OWN config +
// baseline, blocking any relaxation vs a git ref (raised/removed max, dropped rule, severity
// downgrade, raised baseline). Builds a real temp git repo, commits a config, then relaxes it in the
// working tree and asserts the gate blocks. ARCH_ALLOW_RELAX is the visible escape hatch.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const writeInv = (obj) => { const f = mkdtempSync(join(tmpdir(), 'arch-mr-inv-')) + '/meta.json'; writeFileSync(f, JSON.stringify(obj)); return f; };

// the meta-ratchet rule itself (lives OUTSIDE the guarded repo so it isn't part of the guarded set)
const META = writeInv([{ id: 'no-config-relaxation', intent: 'config may only move forward', check: { kind: 'config_relaxations', invariants: 'guarded.json', baseline: 'guarded-baseline.json', against: 'HEAD' }, max: 0, severity: 'block' }]);

// a committed repo with a guarded config (one rule, max 10) + baseline {a: 5}
function repo(invariants, baseline) {
  const d = mkdtempSync(join(tmpdir(), 'arch-mr-'));
  git(d, 'init', '-q');
  writeFileSync(join(d, 'guarded.json'), JSON.stringify(invariants, null, 2));
  writeFileSync(join(d, 'guarded-baseline.json'), JSON.stringify(baseline, null, 2));
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}
const BASE_INV = [{ id: 'r1', intent: 'x', check: { kind: 'oversized_files', maxLines: 400 }, max: 10, mode: 'ratchet', severity: 'block' }];
const run = (dir, env = {}) => { const r = spawnSync('node', [GATE, dir, '--invariants', META], { encoding: 'utf8', env: { ...process.env, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const relax = (dir, invariants, baseline) => { writeFileSync(join(dir, 'guarded.json'), JSON.stringify(invariants, null, 2)); if (baseline) writeFileSync(join(dir, 'guarded-baseline.json'), JSON.stringify(baseline, null, 2)); };

// unchanged config -> pass
{ const d = repo(BASE_INV, { a: 5 }); const r = run(d); expect('unchanged config PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// raise a check threshold (maxLines 400 -> 800) -> block
{ const d = repo(BASE_INV, { a: 5 }); relax(d, [{ ...BASE_INV[0], check: { kind: 'oversized_files', maxLines: 800 } }]);
  const r = run(d); expect('raised check.maxLines BLOCKED', r.code === 3 && /maxLines 400 -> 800/.test(r.out), `exit ${r.code}: ${r.out}`); }

// remove a rule entirely -> block
{ const d = repo(BASE_INV, { a: 5 }); relax(d, []);
  const r = run(d); expect('removed invariant BLOCKED', r.code === 3 && /\[r1\] invariant REMOVED/.test(r.out), `exit ${r.code}: ${r.out}`); }

// downgrade severity block -> warn -> block
{ const d = repo(BASE_INV, { a: 5 }); relax(d, [{ ...BASE_INV[0], severity: 'warn' }]);
  const r = run(d); expect('severity downgrade BLOCKED', r.code === 3 && /severity block -> warn/.test(r.out), `exit ${r.code}: ${r.out}`); }

// raise a baseline value (grandfather more debt) -> block
{ const d = repo(BASE_INV, { a: 5 }); relax(d, BASE_INV, { a: 9 });
  const r = run(d); expect('raised baseline BLOCKED', r.code === 3 && /baseline\[a\] 5 -> 9/.test(r.out), `exit ${r.code}: ${r.out}`); }

// strictly-forward change (lower max + add a new rule) -> pass
{ const d = repo(BASE_INV, { a: 5 });
  relax(d, [{ ...BASE_INV[0], max: 5 }, { id: 'r2', intent: 'new', check: { kind: 'module_fanin', maxFanin: 3 }, max: 0, mode: 'ratchet', severity: 'block' }], { a: 3 });
  const r = run(d); expect('tighten + add rule PASSES', r.code === 0 && /PASS/.test(r.out), `exit ${r.code}: ${r.out}`); }

// deliberate relaxation permitted by ARCH_ALLOW_RELAX (still printed)
{ const d = repo(BASE_INV, { a: 5 }); relax(d, [{ ...BASE_INV[0], check: { kind: 'oversized_files', maxLines: 800 } }]);
  const r = run(d, { ARCH_ALLOW_RELAX: '1' });
  expect('ARCH_ALLOW_RELAX permits but PRINTS', r.code === 0 && /PASS/.test(r.out) && /maxLines 400 -> 800/.test(r.out), `exit ${r.code}: ${r.out}`); }

console.log(failed === 0 ? '\nPASS: meta-ratchet blocks config/baseline relaxation; forward changes & explicit override pass ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
