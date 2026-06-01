// Opt-in real-repo sweep: when the sibling product repos are checked out next to anchor (or
// ANCHOR_CORPUS_DIR points at a dir of repos), run the gate against ACTUAL real codebases and assert
// known-good expectations. SKIPS cleanly when the repos aren't present (e.g. CI), so it never fails a
// fresh checkout — it's a local guard that the gate's behavior holds on real code, complementing the
// always-on synthetic corpus (test-arch-corpus.mjs). No hardcoded user paths: resolves siblings
// relative to the repo, or via ANCHOR_CORPUS_DIR.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
// concord/ is three levels up from prototypes/architectural-gate/; or use ANCHOR_CORPUS_DIR.
const ROOT = process.env.ANCHOR_CORPUS_DIR || resolve(HERE, '..', '..', '..');

let failed = 0, ran = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

// metric(repoSubdir, check) -> the gate's computed value for a single inline invariant, or null if absent.
function metric(relDir, check) {
  const dir = join(ROOT, relDir);
  if (!existsSync(dir)) return null;
  const inv = JSON.stringify([{ id: 'x', intent: 'x', check, max: 999999, mode: 'ratchet', severity: 'block', lang: 'ts', engine: 'ast-grep' }]);
  const tmpInv = join(HERE, '.real-repo-probe.json');
  spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(tmpInv)}, ${JSON.stringify(inv)})`]);
  const r = spawnSync('node', [GATE, dir, '--invariants', tmpInv, '--json'], { encoding: 'utf8' });
  spawnSync('rm', ['-f', tmpInv]);
  try { return JSON.parse(r.stdout).metrics.x; } catch { return null; }
}

// Expectations on the real repos (only the ones present run; comparator describes the invariant).
const CASES = [
  { repo: 'deploysignal/engine', check: { kind: 'oversized_files', maxLines: 800 }, ok: (v) => v >= 1, why: 'engine has known God files (e.g. types/config.ts)' },
  { repo: 'deploysignal/engine', check: { kind: 'max_function_lines', maxLines: 100 }, ok: (v) => v >= 1, why: 'engine has known God functions' },
  { repo: 'tessera/test', check: { kind: 'time_bomb_tests', dirs: ['.'] }, ok: (v) => v === 0, why: 'tessera test/ was de-time-bombed' },
  { repo: 'tessera/test', check: { kind: 'forbid_path', dirs: ['.'], path: 'coordination/' }, ok: (v) => v === 0, why: 'tessera product tests no longer read coordination/' },
  { repo: 'anchor/packages', check: { kind: 'time_bomb_tests', dirs: ['.'] }, ok: (v) => v === 0, why: 'anchor product tests pin no frozen git refs' },
];

for (const c of CASES) {
  const v = metric(c.repo, c.check);
  if (v === null) { console.log(`skip  ${c.repo} ${c.check.kind} — repo not present`); continue; }
  ran++;
  expect(`${c.repo} ${c.check.kind}: ${c.why} (got ${v})`, c.ok(v), `unexpected metric ${v}`);
}

if (ran === 0) { console.log('\nSKIP: no sibling repos present (set ANCHOR_CORPUS_DIR to a dir of checkouts to run) — corpus test covers behavior'); process.exit(0); }
console.log(failed === 0 ? `\nPASS: gate behavior holds on ${ran} real-repo checks ✅` : `\nFAIL: ${failed}/${ran}`);
process.exit(failed ? 1 : 0);
