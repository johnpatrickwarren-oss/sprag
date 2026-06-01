#!/usr/bin/env node
// arch.mjs — unified CLI for the architectural-invariant gate.
//
//   arch check  <dir> [--invariants f] [--baseline-in f] [--json]   gate a dir (exit 0 pass / 3 blocked)
//   arch baseline <dir> [--invariants f] [--baseline-out f]         record the accepted baseline
//   arch trend  <repo> <src> [--invariants f] [--last N]            architectural-debt trend over history
//   arch loop   <dir> --fixer "<cmd>" [--max-iters N]               AI-loop: gate -> fix -> re-gate
//   arch install-hook <repo> <src> [invariants]                     install the pre-commit gate
//   arch init   <dir> [--lang go|ts|js] [--out f]                   scaffold generic invariants + baseline
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args) => process.exit(spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1);

function detectLang(dir) {
  const count = { go: 0, ts: 0, js: 0 };
  const ext = { '.go': 'go', '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js' };
  const walk = (d) => { for (const n of readdirSync(d)) { if (n === 'node_modules' || n === '.git' || n === 'vendor') continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else { const e = '.' + n.split('.').pop(); if (ext[e]) count[ext[e]]++; } } };
  if (existsSync(dir)) walk(dir);
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
}

// `arch init`: scaffold a starting invariant set (generic, no-tuning checks) + a baseline.
function init(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: arch init <dir> [--lang go|ts|js] [--out f]'); process.exit(64); }
  const li = argv.indexOf('--lang'); const lang = li >= 0 ? argv[li + 1] : detectLang(dir);
  const oi = argv.indexOf('--out'); const out = oi >= 0 ? argv[oi + 1] : join(dir, 'arch-invariants.json');
  const astLangs = { ts: 'ts', js: 'js', go: 'go' };
  const invs = [
    { id: 'no-god-files', intent: 'No source file over 800 lines (God file) — split it.', check: { kind: 'oversized_files', maxLines: 800 }, mode: 'ratchet', severity: 'block' },
    { id: 'no-god-functions', intent: 'No function over 60 lines (God function) — decompose it.', check: { kind: 'max_function_lines', maxLines: 60 }, mode: 'ratchet', severity: 'block', lang: astLangs[lang] || 'ts', engine: 'ast-grep' },
  ];
  if (lang !== 'go') invs.push({ id: 'no-god-module', intent: 'No module imported by more than 8 files (coupling hub / God module).', check: { kind: 'module_fanin', maxFanin: 8 }, mode: 'ratchet', severity: 'block' });
  writeFileSync(out, JSON.stringify(invs, null, 2) + '\n');
  console.log(`wrote ${out}  (lang=${lang}, ${invs.length} generic invariants — tune them, or add tenets from library/tenets.json)`);
  const blOut = out.replace(/\.json$/, '') + '.baseline.json';
  const r = spawnSync('node', [join(HERE, 'arch-gate.mjs'), dir, '--invariants', out, '--baseline', '--baseline-out', blOut], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(`wrote baseline ${blOut} (accepts current state).`);
    console.log('next:');
    console.log(`  arch check ${dir} --invariants ${out} --baseline-in ${blOut}`);
    console.log(`  arch install-hook <repo> <src-rel> ${out}`);
  }
  process.exit(r.status ?? 1);
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case 'check': run('node', [join(HERE, 'arch-gate.mjs'), ...rest]); break;
  case 'baseline': run('node', [join(HERE, 'arch-gate.mjs'), ...rest, '--baseline']); break;
  case 'trend': run('node', [join(HERE, 'arch-trend.mjs'), ...rest]); break;
  case 'loop': run('node', [join(HERE, 'arch-loop.mjs'), ...rest]); break;
  case 'install-hook': run('bash', [join(HERE, 'install-hook.sh'), ...rest]); break;
  case 'init': init(rest); break;
  default:
    console.error('usage: arch <check|baseline|trend|loop|install-hook|init> ...  (see header of arch.mjs)');
    process.exit(64);
}
