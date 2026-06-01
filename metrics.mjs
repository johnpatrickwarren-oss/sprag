// metrics.mjs — generic, deterministic, dir-recursive metric walkers for the architectural gate.
// Extracted from arch-gate.mjs so the gate stays under its own God-file limit (the tool dogfoods its
// own checks). Every walker reads only stable in-tree source — skips node_modules/.git/vendor and
// generated build artifacts — so the metrics are deterministic regardless of whether the tree has
// been built. (godFunctionCount stays in arch-gate.mjs because it needs the ast-grep parser.)
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';

// Generated / build-artifact files are NOT authored source — exclude them so metrics reflect
// hand-written code and stay DETERMINISTIC regardless of build state (otherwise a `tsc` run that
// emits .js next to each .ts would double the counts and corrupt a ratchet baseline):
//  - a .js/.cjs/.mjs/.jsx that has a .ts/.tsx sibling (tsc output)
//  - a *.min / *.bundle / *.browser bundle
//  - a .d.ts type-declaration file
export function isGeneratedFile(p) {
  if (/\.d\.ts$/.test(p)) return true;
  if (/\.(min|bundle|browser)\.(js|cjs|mjs|jsx)$/.test(p)) return true;
  const m = p.match(/^(.*)\.(js|cjs|mjs|jsx)$/);
  return !!m && (existsSync(m[1] + '.ts') || existsSync(m[1] + '.tsx'));
}

// oversized_files (generic, language-agnostic, no per-project tuning): count source files whose
// line count exceeds maxLines — the "God file" smell. Recurses, skipping deps/vcs/generated.
const SRC_EXTS = ['.go', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.py', '.rs', '.java', '.rb', '.sh'];
export function oversizedFilesCount(dir, maxLines) {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!SRC_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      if (readFileSync(p, 'utf8').split('\n').length > maxLines) n++;
    }
  };
  walk(dir);
  return n;
}

// module_fanin (generic coupling): how many distinct files import each LOCAL module; flags hub
// modules imported by more than maxFanin files — the k10s "everything depends on the God object"
// smell. Relative-import based (JS/TS family); language-agnostic in spirit.
const FANIN_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
export function moduleFaninCount(dir, maxFanin) {
  if (!dir || !existsSync(dir)) return 0;
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.git' || n === 'vendor') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (FANIN_EXTS.some((e) => n.endsWith(e)) && !isGeneratedFile(p)) files.push(p);
    }
  };
  walk(dir);
  const fanin = new Map(); // resolved module key -> Set(importing file)
  const importRe = /(?:\bfrom|\brequire\(\s*|\bimport\(\s*)\s*['"]([^'"]+)['"]/g;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let m;
    while ((m = importRe.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // local relative imports only
      const key = pathResolve(dirname(f), spec).replace(/\.(ts|tsx|js|mjs|cjs|jsx)$/, '');
      (fanin.get(key) || fanin.set(key, new Set()).get(key)).add(f);
    }
  }
  let n = 0;
  for (const importers of fanin.values()) if (importers.size > maxFanin) n++;
  return n;
}

// Strip comments so a path REFERENCE (import / fs read) is distinguished from a harmless provenance
// citation in a comment (e.g. `// see coordination/X`). Heuristic (good enough for a gate): drops
// /* block */, // line, and # line comments. (`http://` is preserved — the line rule needs a non-`:`.)
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/(^|\s)#.*$/gm, '$1');
}

const REF_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.go', '.py'];

// forbid_path (LAYERING / dependency-direction): count files under `dirs` that REFERENCE a forbidden
// path in code (not in comments) — e.g. product code (test/, src/) reaching into process state
// (coordination/). Catches the "product depends on process" / wrong-layer-dependency smell that the
// size/coupling metrics are blind to. check: { dirs:[...], path:'<regex>' }. Suppression-aware.
export function forbidPathRefCount(dir, check, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const roots = (check.dirs || ['.']).map((d) => join(dir, d)).filter((p) => existsSync(p));
  const re = new RegExp(check.path);
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!REF_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      const raw = readFileSync(p, 'utf8');
      if (supRe && supRe.test(raw)) continue;
      if (re.test(stripComments(raw))) n++;
    }
  };
  for (const r of roots) walk(r);
  return n;
}

// time_bomb_tests: tests that can ONLY rot — they invoke git against a FROZEN reference (a pinned commit
// SHA, a `git diff <ref>..HEAD` / `--name-only` anti-scope diff, a `git show <sha>` byte-identity check,
// or a SHA-named const). Once HEAD moves past that point they fail regardless of product correctness, so
// they belong in a round-aware GATE, not the permanent suite. Deterministic; flags whole files. The
// signal requires BOTH a git invocation AND a frozen-ref marker (so a product SHA-256 hash test that
// never touches git is not flagged). check: { dirs:['test'] }. Suppression-aware.
const TEST_EXTS = ['.test.ts', '.test.tsx', '.test.js', '.test.mjs', '.test.cjs', '.spec.ts', '.spec.js'];
export function timeBombTestCount(dir, check, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const roots = (check.dirs || ['test']).map((d) => join(dir, d)).filter((p) => existsSync(p));
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  const gitInvoke = /(?:execSync|execFileSync|spawnSync|\bexec)\s*\(\s*[`'"]git\b|[`'"]\s*git\s+(?:diff|show|rev-list|log|merge-base)\b/;
  const frozenRef = /--name-only|\.\.HEAD|git\s+show\s+[`'"$]?\{?[\w-]*\}?:?[0-9a-f]{7,40}|[0-9a-f]{7,40}\s+HEAD|(?:SHA|sha|ref|baseline|round[_-]?start|frozen)\w*\s*[:=]\s*[`'"][0-9a-f]{7,40}[`'"]/i;
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!TEST_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      const raw = readFileSync(p, 'utf8');
      if (supRe && supRe.test(raw)) continue;
      const code = stripComments(raw);
      if (gitInvoke.test(code) && frozenRef.test(code)) n++;
    }
  };
  for (const r of roots) walk(r);
  return n;
}

// require_tests: the deterministic SHADOW of test-driven-development. Flags source modules under
// `dirs` that have NO corresponding test anywhere in the tree. It can't prove a test was written
// FIRST, but it enforces TDD's durable outcome — "no untested code ships" — as a ratchet (grandfather
// today's untested files, block NEW ones). "Has a test" is matched by base name, layout-agnostic:
//   src/foo.ts -> foo.{test,spec}.{ts,tsx,js,mjs,cjs,jsx} | foo_test.go | test_foo.py | foo_test.py
// Excludes the test files themselves, generated artifacts, and (by default) barrel `index.*` files;
// `check.exclude` (regex on the relative path) overrides the default exclusion. Suppression-aware.
const CODE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.go', '.py'];
function testCovers(name) { // the source base-name a test file is "about", or null if not a test
  let m;
  if ((m = name.match(/^(.*)\.(test|spec)\.(?:ts|tsx|js|mjs|cjs|jsx)$/))) return m[1];
  if ((m = name.match(/^(.*)_test\.go$/))) return m[1];
  if ((m = name.match(/^test_(.+)\.py$/))) return m[1];
  if ((m = name.match(/^(.*)_test\.py$/))) return m[1];
  return null;
}
const srcBase = (name) => name.replace(/\.(?:ts|tsx|js|mjs|cjs|jsx|go|py)$/, '');
export function untestedModuleCount(dir, check, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const roots = (check.dirs || ['src']).map((d) => join(dir, d)).filter((p) => existsSync(p));
  if (!roots.length) return 0;
  const excludeRe = check.exclude ? new RegExp(check.exclude) : /(^|\/)index\.(?:ts|tsx|js|mjs|cjs|jsx)$/;
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  // 1. collect the base name of every test in the WHOLE tree (tests may live anywhere).
  const covered = new Set();
  const collect = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { collect(p); continue; }
      const b = testCovers(name);
      if (b !== null) covered.add(b);
    }
  };
  collect(dir);
  // 2. count source modules under `dirs` with no covering test.
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!CODE_EXTS.some((e) => name.endsWith(e))) continue;
      if (testCovers(name) !== null || isGeneratedFile(p) || excludeRe.test(p)) continue;
      if (supRe && supRe.test(readFileSync(p, 'utf8'))) continue;
      if (!covered.has(srcBase(name))) n++;
    }
  };
  for (const r of roots) walk(r);
  return n;
}
