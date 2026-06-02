#!/usr/bin/env node
// mutate.mjs — opt-in, INCREMENTAL mutation testing for arch-gate. Measures test EFFICACY (do the tests
// CATCH BUGS?) — the count-independent answer to "are these tests worth anything", and the only signal a
// test suite can't game by adding volume. Mutates one operator at a time in CHANGED source files (git
// diff) by default; runs your test command per mutant; a mutant is KILLED if the suite then fails.
// score = killed/total. Deterministic, ZERO model tokens — but heavy (mutants × suite runtime), so run
// it OUT-OF-BAND (CI / nightly / pre-merge), NOT as the per-commit gate.
//
//   arch mutate <dir> --test "<cmd>" [--since <ref>] [--all] [--threshold 60] [--max-mutants 200] [--cwd <d>] [--exclude <globs>]
//
//   --test       REQUIRED. Test command to run per mutant (exit 0 = tests pass = mutant SURVIVED).
//   --since REF   Mutate files changed vs REF (default: changed-vs-HEAD). Incremental — the point.
//   --all         Mutate every source file under <dir> (full run; slow — for a baseline, not the loop).
//   --threshold   Min mutation score % to pass (default 60). Exit 3 if below.
//   --max-mutants Cap total mutants (default 200) so an incremental run stays bounded.
//   --cwd         Working dir for the test command (default: the repo root).
//   --exclude G   Comma-separated path globs to skip (e.g. 'corpus/**,test-*.mjs') — fixtures + tests
//                 the .test./.spec. heuristic misses. `*` = within a segment, `**` = across segments.
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('--'));
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const TEST = opt('--test');
if (!dir || !TEST) { console.error('usage: arch mutate <dir> --test "<cmd>" [--since <ref>] [--all] [--threshold 60] [--max-mutants 200] [--cwd <d>] [--exclude <globs>]'); process.exit(64); }
const threshold = parseFloat(opt('--threshold', '60'));
const maxMutants = parseInt(opt('--max-mutants', '200'), 10);
const gitTop = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const repoRoot = gitTop.status === 0 ? gitTop.stdout.trim() : dir;
const cwd = opt('--cwd', repoRoot);

const SRC = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const isTest = (n) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(n);
const isGen = (p) => /\.d\.ts$/.test(p) || /\.(min|bundle|browser)\.(js|cjs|mjs|jsx)$/.test(p)
  || (/\.(js|cjs|mjs|jsx)$/.test(p) && (existsSync(p.replace(/\.[^.]+$/, '.ts')) || existsSync(p.replace(/\.[^.]+$/, '.tsx'))));

// --exclude: comma-separated globs (`*` = within a path segment, `**` = across segments) matched against
// the repo-relative path. The escape hatch for non-source files the name heuristics miss — fixtures
// (corpus/**), and repos whose tests don't use the .test./.spec. convention (e.g. test-*.mjs).
const EXCLUDE = (opt('--exclude', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length;) {
    if (g[i] === '*' && g[i + 1] === '*') { re += '.*'; i += 2; }
    else if (g[i] === '*') { re += '[^/]*'; i++; }
    else { re += g[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + re + '$');
}
const EXCLUDE_RE = EXCLUDE.map(globRe);
const rel = (p) => (p.startsWith(repoRoot + '/') ? p.slice(repoRoot.length + 1) : p);
const excluded = (p) => EXCLUDE_RE.some((re) => re.test(rel(p)));

let targets = [];
if (has('--all')) {
  (function walk(d) { for (const n of readdirSync(d)) { if (['node_modules', '.git', 'vendor'].includes(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (SRC.some((e) => n.endsWith(e)) && !isTest(n) && !isGen(p) && !excluded(p)) targets.push(p); } })(dir);
} else {
  const ref = opt('--since', 'HEAD');
  const r = spawnSync('git', ['-C', repoRoot, 'diff', '--name-only', ref], { encoding: 'utf8' });
  targets = (r.stdout || '').split('\n').filter(Boolean).map((f) => join(repoRoot, f))
    .filter((p) => p.startsWith(dir) && existsSync(p) && SRC.some((e) => p.endsWith(e)) && !isTest(p) && !isGen(p) && !excluded(p));
}
if (!targets.length) { console.log('mutate: no changed source files (use --all, or --since <ref>). nothing to mutate.'); process.exit(0); }

// Mask strings + comments (same length, newlines preserved) so we never mutate operators inside them.
function mask(src) {
  let out = '', i = 0, st = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (!st) {
      if (c === '/' && n === '/') { st = '//'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { st = '/*'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { st = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === '//') { if (c === '\n') { st = null; out += c; } else out += ' '; i++; continue; }
    if (st === '/*') { if (c === '*' && n === '/') { st = null; out += '  '; i += 2; } else { out += (c === '\n' ? '\n' : ' '); i++; } continue; }
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === st) { st = null; out += c; i++; continue; }
    out += (c === '\n' ? '\n' : ' '); i++;
  }
  return out;
}

// Overlap-free, low-false-positive operators (logic / equality / boundary / boolean literal).
const OPERATORS = [[/&&/g, '||'], [/\|\|/g, '&&'], [/===/g, '!=='], [/!==/g, '==='], [/<=/g, '<'], [/>=/g, '>'], [/\btrue\b/g, 'false'], [/\bfalse\b/g, 'true']];

const points = [];
for (const f of targets) {
  const src = readFileSync(f, 'utf8'); const masked = mask(src);
  for (const [re, repl] of OPERATORS) { re.lastIndex = 0; let m; while ((m = re.exec(masked))) points.push({ f, src, idx: m.index, len: m[0].length, was: m[0], repl }); }
}
points.sort((a, b) => a.f.localeCompare(b.f) || a.idx - b.idx);
const run = points.slice(0, maxMutants);
const capped = points.length > maxMutants;

const runTests = () => spawnSync(TEST, { shell: true, cwd, stdio: 'ignore' }).status === 0;
if (!runTests()) { console.error(`mutate: tests FAIL on the un-mutated code — fix the suite first (cwd=${cwd}, cmd=${TEST}).`); process.exit(64); }

let current = null; // restore on interrupt
const restore = () => { if (current) { try { writeFileSync(current.f, current.src); } catch { /* */ } current = null; } };
process.on('SIGINT', () => { restore(); process.exit(130); });

let killed = 0; const survivors = [];
for (const pt of run) {
  current = pt;
  writeFileSync(pt.f, pt.src.slice(0, pt.idx) + pt.repl + pt.src.slice(pt.idx + pt.len));
  let survived;
  try { survived = runTests(); } finally { writeFileSync(pt.f, pt.src); current = null; }
  if (survived) survivors.push(pt); else killed++;
}

const total = run.length;
const score = total ? Math.round((killed / total) * 100) : 100;
console.log(`\nmutation score: ${score}%  (${killed}/${total} mutants killed${capped ? `; capped at ${maxMutants} of ${points.length}` : ''}) across ${targets.length} file(s)`);
if (survivors.length) {
  console.log('SURVIVED — tests did not catch these (real coverage gaps, not missing tests):');
  for (const s of survivors.slice(0, 25)) console.log(`   ${s.f.replace(repoRoot + '/', '')}:${s.src.slice(0, s.idx).split('\n').length}  ${s.was} -> ${s.repl}`);
}
if (score < threshold) { console.log(`\n✗ mutation score ${score}% < threshold ${threshold}% — the suite has tests but they don't catch these bugs.`); process.exit(3); }
console.log(`\nPASS: mutation score ${score}% ≥ ${threshold}%.`);
