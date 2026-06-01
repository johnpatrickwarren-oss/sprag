// Integration corpus: runs the gate over corpus/ — small REAL-SHAPED fixtures reproducing the exact
// situations that broke the gate on real repos — and asserts EXACT metric values. This institutionalizes
// the meta-lesson "validate on real-shaped code, not just synthetic single-feature samples": every prior
// bug (determinism on built trees, non-recursive god-functions, layering false-positives) was invisible
// to the per-check unit tests and only surfaced on real code. The corpus locks those behaviors:
//   oversized.ts (>100 ln)                 -> god-files = 1
//   nested/deep/big-fn.ts (40-ln fn)       -> god-functions = 1   (NESTED: locks the recursive walk)
//   nested/deep/big-fn.js (compiled sibling) -> NOT a 2nd god-fn  (locks build-artifact exclusion / determinism)
//   hub.ts imported by a/b/c.ts            -> coupling-hub = 1
//   test/frozen.test.ts (git diff <sha>..HEAD) -> time-bomb-tests = 1
//   test/reads-process.test.ts (readFile coordination/) -> layering = 1
//   test/clean.test.ts (coordination/ only in a // comment) -> NOT counted (locks comment-stripping)
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'corpus');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const r = spawnSync('node', [join(HERE, 'arch-gate.mjs'), CORPUS, '--invariants', join(CORPUS, 'corpus-invariants.json'), '--json'], { encoding: 'utf8' });
let m = {};
try { m = JSON.parse(r.stdout).metrics || {}; } catch { /* leave empty -> fails below */ }

const EXPECTED = { 'god-files': 1, 'god-functions': 1, 'coupling-hub': 1, 'time-bomb-tests': 1, 'layering': 1, 'require-tests': 1 };
for (const [k, v] of Object.entries(EXPECTED)) expect(`${k} == ${v} on real-shaped corpus`, m[k] === v, `got ${JSON.stringify(m[k])} (full: ${JSON.stringify(m)})`);
// the assertions that lock behaviors found only on real repos:
expect('god-functions counts authored .ts ONLY, not the compiled .js sibling (determinism)', m['god-functions'] === 1, `got ${m['god-functions']} (2 => build artifact double-counted)`);
expect('layering counts code references, NOT comment citations (comment-stripping)', m['layering'] === 1, `got ${m['layering']} (2 => comment citation falsely flagged)`);
expect('require-tests counts the untested module ONLY (paid.ts has a test, unpaid.ts does not)', m['require-tests'] === 1, `got ${m['require-tests']} (2 => paid.test.ts not matched to paid.ts)`);

console.log(failed === 0 ? '\nPASS: integration corpus — gate produces exact metrics on real-shaped code ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
