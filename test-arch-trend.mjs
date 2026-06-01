// Self-contained test for the debt-trend report. Builds a synthetic repo whose architecture rots
// commit by commit (a Model field added each step), then asserts the trend surfaces the growth and
// flags the first absolute-max breach — the early warning the k10s author lacked.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREND = join(HERE, 'arch-trend.mjs');
const CLEAN = readFileSync(join(HERE, 'sample', 'ui.go'), 'utf8');
const sh = (cmd, cwd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const repo = mkdtempSync(join(tmpdir(), 'arch-trend-repo-'));
mkdirSync(join(repo, 'src'));
sh('git init -q && git config user.email t@t && git config user.name t', repo);

// commit 0: clean (Model = 6 fields)
let go = CLEAN;
writeFileSync(join(repo, 'src', 'ui.go'), go);
sh('git add -A && git commit -q --no-verify -m "init (clean)"', repo);

// commits 1..4: add one Model field each (god-object grows 6 -> 10, crossing max 8 at field 9)
for (let k = 1; k <= 4; k++) {
  go = go.replace(/\tquitting bool\n/, `\tquitting bool\n\tf${k} int\n`).replace(`\tf${k} int\n`, `\tf${k} int\n`);
  // simpler: insert before the closing of the struct via the quitting anchor each time
  writeFileSync(join(repo, 'src', 'ui.go'), go);
  sh(`git add -A && git commit -q --no-verify -m "feat: add field f${k}"`, repo);
}

const r = spawnSync('node', [TREND, repo, 'src', '--json'], { encoding: 'utf8' });
let data = {};
try { data = JSON.parse(r.stdout); } catch { /* */ }
const series = (data.rows || []).map((row) => row.metrics['model-not-god-object']);
expect('trend captured all commits', (data.rows || []).length === 5, `rows=${(data.rows || []).length}`);
expect('god-object metric grows over history', series.length === 5 && series[0] === 6 && series[4] === 10,
  `series=${JSON.stringify(series)}`);
expect('strictly increasing (rot accumulates)', series.every((v, i) => i === 0 || v >= series[i - 1]),
  `series=${JSON.stringify(series)}`);

// human report flags the first max breach
const human = spawnSync('node', [TREND, repo, 'src'], { encoding: 'utf8' }).stdout;
expect('report flags first absolute-max breach', /model-not-god-object.*BREACHED/.test(human),
  human.split('\n').filter((l) => /BREACHED|never breached/.test(l)).join(' | '));
expect('report shows trending-worse warning', /trending worse/.test(human), '(no warning line)');

console.log(failed === 0 ? '\nPASS: trend surfaces accumulating rot + first breach early ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
