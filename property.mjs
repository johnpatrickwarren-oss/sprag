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
//
//   --prop      REQUIRED. Command that runs the property (exit 0 = the property HOLDS).
//   --target    Source dir to mutate when proving strength (default: <dir>). Point it at the
//               implementation under test, NOT where the property file lives.
//   --min-kill  Minimum mutation kill % the property must reach to count as strong (default 50).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('--'));
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROP = opt('--prop');
if (!dir || !PROP) { console.error('usage: arch property <dir> --prop "<cmd>" [--target <dir>] [--min-kill 50] [--all | --since <ref>]'); process.exit(64); }
const target = opt('--target', dir);
const minKill = opt('--min-kill', '50');
const scope = argv.includes('--since') ? ['--since', opt('--since', 'HEAD')] : ['--all'];
const reject = (why) => { console.log(`\n✗ REJECT — ${why}`); process.exit(3); };

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

console.log(`\n✓ ACCEPT — the property HOLDS and CATCHES BUGS (mutation kill ≥ ${minKill}%). Commit it; from here it is enforced deterministically, no model on the gate.`);
process.exit(0);
