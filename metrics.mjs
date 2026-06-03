// metrics.mjs — generic, deterministic, dir-recursive metric walkers for the architectural gate.
// Extracted from arch-gate.mjs so the gate stays under its own God-file limit (the tool dogfoods its
// own checks). Every walker reads only stable in-tree source — skips node_modules/.git/vendor and
// generated build artifacts — so the metrics are deterministic regardless of whether the tree has
// been built. (godFunctionCount stays in arch-gate.mjs because it needs the ast-grep parser.)
// "Skips ... deps/vcs" below means isSkippedDir: node_modules, .venv/venv/site-packages/__pycache__
// (+ .egg-info), .git/vendor — see SKIP_DIRS.
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Ratchet correctness: the working-tree scan must see the SAME file universe as the `git archive HEAD`
// baseline. Otherwise gitignored source-like files (a compiled dist/, a gitignored coordination/) are
// present in the working tree but absent from the archive baseline, so the working count exceeds the
// baseline and the ratchet FALSE-REGRESSES every commit. So when `dir` is inside a git work tree,
// restrict every walk to git's NON-IGNORED set (tracked + untracked-but-not-ignored = what a commit
// would contain). When `dir` is NOT a git repo (the extracted-archive baseline dir, sample fixtures, an
// arbitrary `arch check <dir>`), return null = scan everything (preserves prior behaviour). The
// generated-file + SKIP_DIRS filters still apply on top, for tracked-but-not-authored code (a COMMITTED
// dist/ of compiled .js). Memoized per dir — one `git` fork per dir per process.
const _trackedCache = new Map();
export function gitTrackedSet(dir) {
  if (_trackedCache.has(dir)) return _trackedCache.get(dir);
  let set = null;
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const out = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    set = new Set();
    for (const rel of out.split('\0')) if (rel) set.add(pathResolve(dir, rel));
  } catch { set = null; } // git missing, or not a work tree -> no filtering (scan all)
  _trackedCache.set(dir, set);
  return set;
}

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

// Dependency / VCS / tool-cache / BUILD-OUTPUT directories that never hold authored project source.
// Skipping them keeps every metric on hand-written code: otherwise a Python `.venv` of vendored
// site-packages (or a JS `node_modules`) swamps the counts — a naive scan reported ~1800 fake God
// files from `.venv`. Build dirs (`dist`/`build`/...) matter for the RATCHET specifically: they are
// gitignored, so they're absent from the `git archive HEAD` baseline but present in the working tree —
// counting them makes the working scan exceed the baseline and the ratchet false-regress on every
// commit. (Mirrors scan.mjs's skip-list.)
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor',
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.eggs',
  'dist', 'build', 'coverage', '.next', 'out', '.astro',
]);
export function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || name.endsWith('.egg-info');
}

// oversized_files (generic, language-agnostic, no per-project tuning): count source files whose
// line count exceeds maxLines — the "God file" smell. Recurses, skipping deps/vcs/generated.
const SRC_EXTS = ['.go', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.py', '.rs', '.java', '.rb', '.sh'];
export function oversizedFilesCount(dir, maxLines) {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0;
  const tracked = gitTrackedSet(dir);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!SRC_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
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
  const tracked = gitTrackedSet(dir);
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (isSkippedDir(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (FANIN_EXTS.some((e) => n.endsWith(e)) && !isGeneratedFile(p) && !(tracked && !tracked.has(pathResolve(p)))) files.push(p);
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
  const tracked = gitTrackedSet(dir);
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!REF_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
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
  const tracked = gitTrackedSet(dir);
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!TEST_EXTS.some((e) => name.endsWith(e)) || isGeneratedFile(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
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
  const tracked = gitTrackedSet(dir);
  // 1. collect the base name of every test in the WHOLE tree (tests may live anywhere).
  const covered = new Set();
  const collect = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { collect(p); continue; }
      if (tracked && !tracked.has(pathResolve(p))) continue;
      const b = testCovers(name);
      if (b !== null) covered.add(b);
    }
  };
  collect(dir);
  // 2. count source modules under `dirs` with no covering test.
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!CODE_EXTS.some((e) => name.endsWith(e))) continue;
      if (testCovers(name) !== null || isGeneratedFile(p) || excludeRe.test(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
      if (supRe && supRe.test(readFileSync(p, 'utf8'))) continue;
      if (!covered.has(srcBase(name))) n++;
    }
  };
  for (const r of roots) walk(r);
  return n;
}

// ── supply chain: dependency surface + hallucinated ("unlocked") deps ────────────
// Two AI-codegen dependency failure modes the size/coupling/test metrics never see:
//   (1) silent SURFACE GROWTH — every added third-party package enlarges the attack +
//       maintenance surface. A ratchet makes each addition a deliberate, auditable re-baseline
//       instead of a free side effect of "just npm-install it".
//   (2) hallucinated / typo'd packages ("slopsquatting") — a dependency DECLARED in the manifest
//       but never RESOLVED into the lockfile is the deterministic, OFFLINE fingerprint of a package
//       that doesn't really exist (or was never installed). No registry call, no model.
// Manifests live at known/top-level paths, so these dodge the nested-tree concatenation limit that
// constrains the ast-grep pattern checks.
function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// Declared dependency NAMES of a manifest (npm package.json / Go go.mod / pip requirements.txt).
// `groups` only applies to package.json; go.mod & requirements.txt have no group concept.
function declaredDeps(manifestPath, groups) {
  const base = manifestPath.replace(/^.*\//, '');
  const names = new Set();
  if (base === 'package.json') {
    const pkg = readJSON(manifestPath) || {};
    for (const g of groups) for (const name of Object.keys(pkg[g] || {})) names.add(name);
    return names;
  }
  if (base === 'go.mod') { // `require ( ... )` blocks + single `require x v` lines; skip // indirect
    let inBlock = false;
    for (const raw of readFileSync(manifestPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!inBlock && /^require\s+\($/.test(line)) { inBlock = true; continue; }
      if (inBlock && line === ')') { inBlock = false; continue; }
      const m = inBlock ? line.match(/^(\S+)\s+v\S+(.*)$/) : line.match(/^require\s+(\S+)\s+v\S+(.*)$/);
      if (m && !/\/\/\s*indirect/.test(m[2] || '')) names.add(m[1]);
    }
    return names;
  }
  if (base === 'requirements.txt') {
    for (const raw of readFileSync(manifestPath, 'utf8').split('\n')) {
      const t = raw.trim();
      if (!t || t.startsWith('#') || t.startsWith('-')) continue; // skip blanks/comments/-r/-e flags
      const m = t.match(/^([A-Za-z0-9._-]+)/);
      if (m) names.add(m[1].toLowerCase());
    }
    return names;
  }
  return names;
}

// dependency_count (supply-chain surface): number of DECLARED third-party deps in a manifest.
// Ratcheted, so the surface can't grow without a deliberate re-baseline. check:
// { manifest?: 'package.json', include?: ['dependencies','optionalDependencies'] }.
export function dependencyCount(dir, check) {
  if (!dir) return 0;
  const manifest = join(dir, check.manifest || 'package.json');
  if (!existsSync(manifest)) return 0;
  return declaredDeps(manifest, check.include || ['dependencies', 'optionalDependencies']).size;
}

// All package names RESOLVED in an npm lockfile — unioned across the v1 `dependencies` tree and the
// v2/v3 `packages` map (keyed by `.../node_modules/<name>`), so any lockfile version is covered.
function lockedNpmNames(lockPath) {
  const lock = readJSON(lockPath);
  const names = new Set();
  if (!lock) return names;
  if (lock.packages) {
    for (const key of Object.keys(lock.packages)) {
      const i = key.lastIndexOf('node_modules/');
      if (i >= 0) names.add(key.slice(i + 'node_modules/'.length));
    }
  }
  const walkV1 = (deps) => { for (const [name, v] of Object.entries(deps || {})) { names.add(name); if (v && v.dependencies) walkV1(v.dependencies); } };
  if (lock.dependencies) walkV1(lock.dependencies);
  return names;
}

// unlocked_dependencies (hallucination / slopsquat guard, npm): deps DECLARED in package.json but
// ABSENT from the resolved lockfile — the offline fingerprint of a package that doesn't exist or was
// never installed. Inert (0) unless BOTH manifest and lockfile are present. peerDependencies are
// excluded by default (the consumer, not you, resolves them). check:
// { manifest?: 'package.json', lockfile?: 'package-lock.json', include?: [...], allow?: [names] }.
// Escape hatch: `allow` lists deliberately-unlocked names (e.g. a `file:`/`workspace:` local link) —
// auditable in the invariants file, not silent. Use `max: 0` (not a ratchet).
export function unlockedDependencyCount(dir, check) {
  if (!dir) return 0;
  const manifest = join(dir, check.manifest || 'package.json');
  if (manifest.replace(/^.*\//, '') !== 'package.json') return 0; // npm-only for now
  const lockPath = join(dir, check.lockfile || 'package-lock.json');
  if (!existsSync(manifest) || !existsSync(lockPath)) return 0;
  const allow = new Set(check.allow || []);
  const locked = lockedNpmNames(lockPath);
  let n = 0;
  for (const name of declaredDeps(manifest, check.include || ['dependencies', 'devDependencies', 'optionalDependencies'])) {
    if (!locked.has(name) && !allow.has(name)) n++;
  }
  return n;
}
