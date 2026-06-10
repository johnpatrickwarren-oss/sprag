#!/usr/bin/env node
// property.mjs — `arch property`: the deterministic ACCEPTANCE gate for a property / invariant (the
// first behavioral rung, authored by a human OR an AI). The point: an invariant is only worth anything
// if it (1) HOLDS on the current code and (2) CATCHES BUGS. Both are decided DETERMINISTICALLY — by
// running the property and by mutation testing — not by trusting whoever wrote it. That is what makes an
// AI-authored invariant safe to use: the model only PROPOSES; a verifier you can't fool (you cannot fake
// killing a mutant) ACCEPTS or REJECTS. Accepted properties are committed and enforced model-free forever
// after, so no model ever sits on the gate. See library/property-templates.md for the sound shapes to
// instantiate, and the AI-authoring contract (spec-blind, black-box, template-bounded).
//
//   arch property <dir> --prop "<cmd>" [--target <dir>] [--min-kill 50] [--all | --since <ref>]
//                       [--prop-file <f>] [--strict-restatement]
//
//   --prop       REQUIRED. Command that runs the property (exit 0 = the property HOLDS).
//   --target     Source dir to mutate when proving strength (default: <dir>). Point it at the
//                implementation under test, NOT where the property file lives.
//   --min-kill   Minimum mutation kill % the property must reach to count as strong (default 50).
//   --prop-file  The property's source file (for the restatement check); else inferred from --prop.
//   --strict-restatement  Make a detected impl-restatement a REJECT instead of a warning.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// First positional = <dir>: skip value-taking flags AND their values, so `--prop "<cmd>" <dir>`
// can't have the command string mistaken for the dir.
const VALUE_OPTS = new Set(['--prop', '--target', '--min-kill', '--since', '--prop-file']);
const dir = (() => { for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (VALUE_OPTS.has(a)) i++; else if (!a.startsWith('--')) return a; } return null; })();
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROP = opt('--prop');
if (!dir || !PROP) { console.error('usage: arch property <dir> --prop "<cmd>" [--target <dir>] [--min-kill 50] [--all | --since <ref>] [--prop-file <f>] [--strict-restatement]'); process.exit(64); }
const target = opt('--target', dir);
const minKill = opt('--min-kill', '50');
const scope = argv.includes('--since') ? ['--since', opt('--since', 'HEAD')] : ['--all'];
const reject = (why) => { console.log(`\n✗ REJECT — ${why}`); process.exit(3); };

// ── (heuristic) impl-restatement guard ──────────────────────────────────────────
// A property that COPIES the implementation kills mutants BY CONSTRUCTION (its private copy of the logic
// isn't mutated) yet asserts impl===impl-copy, proving nothing about spec conformance. The deterministic
// holds+kills criteria can't see this; a verbatim-overlap heuristic catches the lazy copy. (The real fix
// is impl-blind authoring — if the model never sees the code it can't copy it.)
const SRC_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
function readImplSource(t) {
  if (!existsSync(t)) return '';
  if (statSync(t).isFile()) return readFileSync(t, 'utf8');
  let s = '';
  const walk = (p2) => { for (const n of readdirSync(p2)) { if (n === 'node_modules' || n === '.git') continue; const p = join(p2, n); if (statSync(p).isDirectory()) walk(p); else if (SRC_EXTS.some((e) => n.endsWith(e))) s += '\n' + readFileSync(p, 'utf8'); } };
  walk(t); return s;
}
function propertyFiles(cmd, override) {
  if (override) { const p = isAbsolute(override) ? override : join(dir, override); return existsSync(p) ? [p] : []; }
  const out = [];
  for (const tok of cmd.split(/\s+/)) { if (!SRC_EXTS.some((e) => tok.endsWith(e))) continue; const p = isAbsolute(tok) ? tok : join(dir, tok); if (existsSync(p)) out.push(p); }
  return out;
}
// longest contiguous (whitespace-normalized) run of the property source that also appears in the impl
function restatementOverlap(propSrc, implSrc) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const P = norm(propSrc), I = norm(implSrc), L = 40;
  let best = { len: 0, text: '' };
  for (let i = 0; i + L <= P.length; i++) {
    if (!I.includes(P.slice(i, i + L))) continue;
    let len = L; while (i + len < P.length && I.includes(P.slice(i, i + len + 1))) len++;
    if (len > best.len) best = { len, text: P.slice(i, i + len) };
  }
  return best;
}

console.log(`\narch property: validating "${PROP}"\n`);

// 1. HOLDS — the property must pass on the current code. If it fails, the property is wrong OR it just
//    caught a real bug; either way a human decides, we don't auto-accept.
const held = spawnSync(PROP, { shell: true, cwd: dir, stdio: 'ignore' }).status === 0;
console.log(`  holds on current code ...... ${held ? 'yes ✅' : 'NO ✗'}`);
if (!held) reject('the property does not hold on the current code — it is either wrong, or it caught a real bug. A human should look (do NOT just weaken it).');

// 2. CATCHES BUGS — mutation testing proves the property is not a tautology. A property that survives
//    every mutant would pass even if the code were wrong: worthless. (Deterministic, no model.)
const m = spawnSync('node', [join(HERE, 'mutate.mjs'), target, '--test', PROP, '--threshold', String(minKill), ...scope, '--cwd', dir], { encoding: 'utf8' });
process.stdout.write(m.stdout || ''); if (m.stderr) process.stderr.write(m.stderr);
if (m.status === 64) reject(`could not measure strength — mutation pre-flight failed. ${(m.stderr || '').trim()}`);
const mm = (m.stdout || '').match(/\((\d+)\/(\d+) mutants/);
const total = mm ? parseInt(mm[2], 10) : 0;
if (total === 0) {
  console.log('\n⚠ INCONCLUSIVE — no mutable operators in the target, so the property\'s bug-catching power is unproven.');
  console.log('  Point --target at the implementation under test, or cover a case that exercises a comparison/boolean.');
  process.exit(2);
}
if (m.status === 3) reject(`the property is too weak / tautological — it did NOT catch the injected bugs (mutation kill < ${minKill}%). It would pass even if the code were wrong.`);

// 3. holds + kills passed. Heuristic guard: warn (or, with --strict-restatement, reject) if the property
//    copies the implementation — see the note above readImplSource.
const implSrc = readImplSource(target);
let worst = { len: 0 };
for (const pf of propertyFiles(PROP, opt('--prop-file'))) { const ov = restatementOverlap(readFileSync(pf, 'utf8'), implSrc); if (ov.len > worst.len) worst = { ...ov, file: pf }; }
if (worst.len >= 40) {
  console.log(`\n⚠ WARNING — the property shares ${worst.len} verbatim chars with the implementation${worst.file ? ` (${worst.file.split('/').pop()})` : ''}:`);
  console.log(`    …${worst.text.slice(0, 64)}…`);
  console.log('  It likely RESTATES the implementation — kills mutants by construction but proves nothing about spec conformance. A reviewer must confirm it states a RELATION / ORACLE / constant, not a copy (impl-blind authoring prevents this by construction).');
  if (argv.includes('--strict-restatement')) reject('the property restates the implementation (see the warning above); --strict-restatement is set.');
}

console.log(`\n✓ ACCEPT — the property HOLDS and CATCHES BUGS (mutation kill ≥ ${minKill}%). Commit it; from here it is enforced deterministically, no model on the gate.`);
process.exit(0);
