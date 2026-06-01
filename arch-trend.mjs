#!/usr/bin/env node
// arch-trend.mjs — architectural-debt trend over git history. Walks the last N commits, computes
// each invariant's metric at each commit, prints the trend, and flags where each invariant first
// breaches its absolute max. Makes accumulating rot VISIBLE EARLY — the thing the k10s author only
// discovered at collapse (velocity masks rot). Reuses arch-gate.mjs's extractors.
//
//   node arch-trend.mjs <repo> <src-rel> [--last N=20] [--json]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INVARIANTS, readSource, metricValue } from './arch-gate.mjs';

function parse(argv) {
  let repo = null, srcRel = null, last = 20, json = false;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') last = parseInt(argv[++i], 10);
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) pos.push(a);
    else { console.error(`arch-trend: unknown arg ${a}`); process.exit(64); }
  }
  [repo, srcRel] = pos;
  return { repo, srcRel, last, json };
}

const { repo, srcRel, last, json } = parse(process.argv.slice(2));
if (!repo || !srcRel) { console.error('usage: arch-trend.mjs <repo> <src-rel> [--last N] [--json]'); process.exit(64); }

const shas = spawnSync('git', ['-C', repo, 'rev-list', '--reverse', `--max-count=${last}`, 'HEAD'], { encoding: 'utf8' })
  .stdout.trim().split('\n').filter(Boolean);
if (!shas.length) { console.error('arch-trend: no commits'); process.exit(1); }

const rows = [];
for (const sha of shas) {
  const tmp = mkdtempSync(join(tmpdir(), 'arch-trend-'));
  try {
    spawnSync('bash', ['-c', `git -C "${repo}" archive ${sha} | tar -x -C "${tmp}"`]);
    const srcDir = join(tmp, srcRel);
    const subj = spawnSync('git', ['-C', repo, 'log', '-1', '--format=%s', sha], { encoding: 'utf8' }).stdout.trim();
    const metrics = {};
    for (const inv of INVARIANTS) metrics[inv.id] = metricValue(inv, readSource(srcDir, inv.lang || 'go'), srcDir);
    rows.push({ sha: sha.slice(0, 7), subj, metrics });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (json) { process.stdout.write(JSON.stringify({ invariants: INVARIANTS.map((i) => i.id), rows }, null, 2) + '\n'); process.exit(0); }

// table
const ids = INVARIANTS.map((i) => i.id);
console.log('architectural-debt trend (oldest -> newest):\n');
console.log(['commit '.padEnd(9), ...ids.map((id) => id.slice(0, 20).padStart(22))].join(''));
for (const r of rows) {
  console.log([r.sha.padEnd(9), ...ids.map((id) => String(r.metrics[id]).padStart(22))].join(''));
}
// first-breach flags
console.log('\nfirst breach of absolute max:');
for (const inv of INVARIANTS) {
  if (typeof inv.max !== 'number') { console.log(`  ${inv.id}: (ratchet-only, no absolute max)`); continue; }
  const hit = rows.find((r) => r.metrics[inv.id] > inv.max);
  console.log(`  ${inv.id} (max ${inv.max}): ${hit ? `BREACHED at ${hit.sha} "${hit.subj}"` : 'never breached'}`);
}
const first = rows[0].metrics, lastM = rows[rows.length - 1].metrics;
const grown = ids.filter((id) => lastM[id] > first[id]);
if (grown.length) console.log(`\n⚠ trending worse over ${rows.length} commits: ${grown.map((id) => `${id} ${first[id]}->${lastM[id]}`).join(', ')}`);
