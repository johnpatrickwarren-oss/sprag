// Unit tests for the generic detector walkers in metrics.mjs — the checks arch-gate SHIPS
// (oversized_files, module_fanin, forbid_path, time_bomb_tests, require_tests). The integration
// suites drive their happy paths; `arch mutate` showed the DEFENSIVE edges unasserted: the
// missing-dir early return, the node_modules/.git/vendor skip-list, the generated-file exclusion,
// and the "git AND frozen-ref" conjunction. Each survivor below corresponds to a real edge a flipped
// `||`/`&&`/`true` would silently break (count a build artifact, scan node_modules, crash on a bad
// path, flag a harmless test). Asserting them kills those mutants.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isGeneratedFile, oversizedFilesCount, moduleFaninCount, stripComments,
  forbidPathRefCount, timeBombTestCount, untestedModuleCount,
} from './metrics.mjs';

let failed = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `  -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) failed++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'arch-met-'));
const mk = (d, rel, body) => { const p = join(d, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p; };
const lines = (n) => 'x\n'.repeat(n);
const MISSING = '/no/such/arch-gate/dir';

// ── isGeneratedFile ──────────────────────────────────────────────────────────────
{ const d = tmp(); mk(d, 'a.ts', 'x'); // sibling so a.js counts as tsc output
  eq('.d.ts is generated', isGeneratedFile('x.d.ts'), true);
  eq('.min.js bundle is generated', isGeneratedFile('app.min.js'), true);
  eq('.js with a .ts sibling is generated (tsc output)', isGeneratedFile(join(d, 'a.js')), true);
  eq('a plain authored .ts is NOT generated', isGeneratedFile(join(d, 'a.ts')), false); }

// ── oversized_files: missing dir, skip-list, generated exclusion ──────────────────
{ eq('oversized: missing dir -> 0 (not a crash)', oversizedFilesCount(MISSING, 10), 0);
  const d = tmp();
  mk(d, 'big.ts', lines(40)); mk(d, 'small.ts', lines(5));
  eq('oversized: one file over the limit', oversizedFilesCount(d, 20), 1);
  const d2 = tmp(); // every entry of the skip-list (node_modules / .git / vendor) must be skipped
  mk(d2, 'node_modules/huge.ts', lines(40)); mk(d2, 'vendor/huge.ts', lines(40)); mk(d2, '.git/huge.ts', lines(40));
  eq('oversized: files under node_modules / vendor / .git are all skipped', oversizedFilesCount(d2, 20), 0);
  const d3 = tmp();
  mk(d3, 'gen.ts', lines(2)); mk(d3, 'gen.js', lines(40)); // gen.js is tsc output of gen.ts
  eq('oversized: a generated .js (has .ts sibling) is not counted', oversizedFilesCount(d3, 20), 0);
  const d4 = tmp();
  mk(d4, 'types.d.ts', lines(40)); // generated declaration
  eq('oversized: a big .d.ts is not counted (generated)', oversizedFilesCount(d4, 20), 0); }

// ── module_fanin: missing dir, hub threshold, node_modules skip ───────────────────
{ eq('fanin: missing dir -> 0', moduleFaninCount(MISSING, 2), 0);
  const d = tmp();
  mk(d, 'hub.ts', 'export const x = 1;\n');
  mk(d, 'a.ts', "import { x } from './hub';\n");
  mk(d, 'b.ts', "import { x } from './hub';\n");
  mk(d, 'c.ts', "import { x } from './hub';\n");
  eq('fanin: hub imported by 3 files exceeds maxFanin 2', moduleFaninCount(d, 2), 1);
  eq('fanin: same hub does not exceed maxFanin 3', moduleFaninCount(d, 3), 0);
  const d2 = tmp();
  mk(d2, 'hub.ts', 'export const x = 1;\n');
  mk(d2, 'a.ts', "import { x } from './hub';\n");
  mk(d2, 'node_modules/dep/q.ts', "import { x } from '../../hub';\n"); // must NOT count toward fanin
  mk(d2, 'vendor/v.ts', "import { x } from '../hub';\n");
  mk(d2, '.git/g.ts', "import { x } from '../hub';\n");
  eq('fanin: importers under node_modules / vendor / .git are skipped', moduleFaninCount(d2, 1), 0); }

// ── forbid_path: missing dir, code vs comment, default dirs ───────────────────────
{ eq('forbid_path: missing dir -> 0', forbidPathRefCount(MISSING, { path: 'coordination/' }), 0);
  const d = tmp();
  mk(d, 'reader.ts', "const p = readFile('coordination/state.json');\n"); // real code ref
  mk(d, 'citer.ts', '// see coordination/ for context\n'); // comment-only citation
  mk(d, 'node_modules/dep.ts', "readFile('coordination/x');\n"); // refs in skipped dirs don't count
  mk(d, 'vendor/v.ts', "readFile('coordination/x');\n");
  eq('forbid_path: a code reference is counted; comment citations + skipped-dir refs are not',
    forbidPathRefCount(d, { dirs: ['.'], path: 'coordination/' }), 1);
  eq('forbid_path: dirs defaults to "." when omitted',
    forbidPathRefCount(d, { path: 'coordination/' }), 1); }

// ── stripComments: keeps code, drops comments (keeps http://) ─────────────────────
{ eq('stripComments keeps the code before a // comment', /code/.test(stripComments('code // x')), true);
  eq('stripComments drops the // comment text', /secret/.test(stripComments('code // secret')), false);
  eq('stripComments preserves http:// in a string', /http:\/\//.test(stripComments("const u = 'http://x';")), true); }

// ── time_bomb_tests: missing dir, requires BOTH git-invoke AND frozen-ref ─────────
{ eq('time_bomb: missing dir -> 0', timeBombTestCount(MISSING, { dirs: ['.'] }), 0);
  const d = tmp();
  mk(d, 'bomb.test.ts', "execSync('git diff abc1234..HEAD --name-only');\n"); // git + frozen ref
  eq('time_bomb: git-invoke + frozen ref is flagged', timeBombTestCount(d, { dirs: ['.'] }), 1);
  const d2 = tmp();
  mk(d2, 'ok.test.ts', "execSync('git status');\n"); // git invoke but NO frozen ref
  eq('time_bomb: git WITHOUT a frozen ref is NOT flagged (needs both)', timeBombTestCount(d2, { dirs: ['.'] }), 0);
  const d3 = tmp();
  mk(d3, 'hash.test.ts', "assert.equal(sha, 'abc1234deadbeef');\n"); // a SHA-looking literal, no git
  eq('time_bomb: a product hash literal without git is NOT flagged', timeBombTestCount(d3, { dirs: ['.'] }), 0); }

// ── require_tests: missing dir, covered vs uncovered, default dirs ────────────────
{ eq('require_tests: missing dir -> 0', untestedModuleCount(MISSING, { dirs: ['.'] }), 0);
  const d = tmp();
  mk(d, 'src/tested.ts', 'export const a = 1;\n');
  mk(d, 'src/tested.test.ts', 'test\n');
  mk(d, 'src/untested.ts', 'export const b = 2;\n');
  eq('require_tests: exactly the one module without a test is flagged',
    untestedModuleCount(d, { dirs: ['src'] }), 1); }

console.log(failed === 0 ? '\nPASS: generic detector walkers — edges (missing dir / skip-list / generated / both-markers) asserted ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
