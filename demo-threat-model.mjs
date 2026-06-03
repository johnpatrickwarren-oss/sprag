// demo-threat-model.mjs — a runnable proof that sprag is "the gate that can't be weakened".
//
// Scenario: the gate is green. An AI agent introduces a real violation, then — told "make the gate
// pass" — tries every shortcut to SILENCE the gate instead of fixing the code. sprag blocks each one.
// Finally the agent fixes the code for real and the gate goes green. The honest escape (a reviewed
// loosening) is shown too: it passes, but prints what it loosened. Self-verifying: exits non-zero if
// any bypass LEAKS through, or the real fix doesn't pass — so it doubles as a regression test.
//
//   node demo-threat-model.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
const INV = 'arch-invariants.json', BASE = 'arch-baseline.json';
let leaks = 0;

const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@a' } });
const write = (d, name, obj) => writeFileSync(join(d, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
const gate = (d, env = {}) => { const r = spawnSync('node', [GATE, d, '--invariants', join(d, INV), '--baseline-in', join(d, BASE)], { encoding: 'utf8', env: { ...process.env, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

const SMALL = 'export const a = (x) => x + 1;\nexport const b = (x) => x * 2;\n';
const godFn = () => { let s = 'export function tangle(x) {\n  let r = x;\n'; for (let i = 0; i < 30; i++) s += `  if (r > ${i}) r += ${i};\n`; return s + '  return r;\n}\n'; };
const setGod = (i, max) => i.id === 'no-god-functions' ? { ...i, check: { ...i.check, maxLines: max } } : i;

const INVARIANTS = [
  { id: 'no-god-functions', intent: 'no function > 20 lines', check: { kind: 'max_function_lines', maxLines: 20 }, lang: 'js', engine: 'ast-grep', mode: 'ratchet', severity: 'block' },
  { id: 'no-config-relaxation', intent: 'config moves forward only (worktree)', check: { kind: 'config_relaxations', invariants: INV, baseline: BASE, against: 'HEAD' }, max: 0, severity: 'block' },
  { id: 'no-config-relaxation-staged', intent: 'config moves forward only (staged)', check: { kind: 'config_relaxations', invariants: INV, baseline: BASE, against: 'HEAD', from: 'index' }, max: 0, severity: 'block' },
];

// Report one bypass attempt. For a bypass we WANT `blocked` true; a false means the cheat LEAKED.
const report = (label, blocked, detail) => { console.log(`  ${blocked ? '🛡  BLOCKED' : '🚨 LEAKED '}  ${label}${blocked ? '' : `  -- ${detail}`}`); if (!blocked) leaks++; };

// ── set the stage: a clean, green repo ──────────────────────────────────────────
const d = mkdtempSync(join(tmpdir(), 'sprag-threat-'));
git(d, 'init', '-q');
write(d, 'src.js', SMALL);
write(d, INV, INVARIANTS);
write(d, BASE, { 'no-god-functions': 0 });
git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'clean: the gate is green');

console.log('\n  sprag threat model — "make the gate pass" vs a gate that can\'t be weakened\n');
console.log(`  green baseline ........................ ${gate(d).code === 0 ? 'PASS ✅' : 'UNEXPECTED ❌'}`);

// ── the agent introduces a real violation ──────────────────────────────────────
write(d, 'src.js', SMALL + godFn());
const v = gate(d);
if (v.code !== 3) leaks++;
console.log(`  agent adds a 32-line god function ..... ${v.code === 3 ? 'BLOCKED ✅ (the honest signal)' : 'NOT BLOCKED ❌'}\n`);
console.log('  told "make the gate pass", the agent tries to silence the gate instead of fixing it:\n');

const origInv = readFileSync(join(d, INV), 'utf8'), origBase = readFileSync(join(d, BASE), 'utf8');
const restore = () => { write(d, INV, JSON.parse(origInv)); write(d, BASE, JSON.parse(origBase)); };

// 1. raise the threshold so the function "fits"
write(d, INV, INVARIANTS.map((i) => setGod(i, 50)));
report('raise the limit (maxLines 20 → 50)', gate(d).code === 3, 'leaked'); restore();

// 2. re-record the baseline upward to grandfather the new debt
write(d, BASE, { 'no-god-functions': 1 });
report('re-baseline (0 → 1, grandfather the debt)', gate(d).code === 3, 'leaked'); restore();

// 3. delete the rule entirely
write(d, INV, INVARIANTS.filter((i) => i.id !== 'no-god-functions'));
report('delete the rule', gate(d).code === 3, 'leaked'); restore();

// 4. downgrade the rule from block to warn
write(d, INV, INVARIANTS.map((i) => i.id === 'no-god-functions' ? { ...i, severity: 'warn' } : i));
report('downgrade severity (block → warn)', gate(d).code === 3, 'leaked'); restore();

// 5. stage a relaxed config, then revert the WORKING file (so the tree looks clean)
write(d, INV, INVARIANTS.map((i) => setGod(i, 50)));
git(d, 'add', INV);          // the relaxation is now staged…
write(d, INV, JSON.parse(origInv)); // …but the working file is reverted
report('stage-then-revert the relaxed config', gate(d).code === 3, 'leaked');
git(d, 'reset', '-q'); restore();

// 6. kill the analyzer so checks score 0 and "pass"
report('kill the analysis engine', gate(d, { ARCH_ENGINE_UNAVAILABLE: '1' }).code === 2, 'leaked (silent pass!)');

// ── the only two ways the gate goes green ──────────────────────────────────────
console.log('\n  the gate only goes green two ways — fix it, or loosen it ON PURPOSE and on the record:\n');

write(d, 'src.js', SMALL); // actually fix the code (decompose / remove the god function)
console.log(`  fix the code for real ................. ${gate(d).code === 0 ? 'PASS ✅' : 'UNEXPECTED ❌'}`);
if (gate(d).code !== 0) leaks++;

write(d, 'src.js', SMALL + godFn());           // re-introduce the violation
write(d, INV, INVARIANTS.map((i) => setGod(i, 50))); // and deliberately raise the limit…
const ovr = gate(d, { ARCH_ALLOW_RELAX: '1' }); // …with an explicit, reviewed override
const visible = ovr.code === 0 && /relaxation/.test(ovr.out);
console.log(`  loosen with ARCH_ALLOW_RELAX=1 ....... ${visible ? 'PASS ✅ (but the relaxation is PRINTED, never silent)' : 'UNEXPECTED ❌'}`);
if (!visible) leaks++;
restore();

console.log(leaks === 0
  ? '\n  Every bypass blocked; the gate can only be passed honestly. ✅\n'
  : `\n  ${leaks} bypass(es) LEAKED. ❌\n`);
process.exit(leaks ? 1 : 0);
