// Self-contained test for the MULTI-DIR pre-commit gate: install-hook.sh accepts a comma-separated
// list of source dirs, each gated against its own HEAD baseline. Proves the SECOND dir is gated too
// (rot introduced only in the second listed dir is blocked), and a clean change is allowed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, 'install-hook.sh');
const sh = (cmd, cwd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

// generic God-file ratchet (no ast-grep deps): no file over 20 lines, ratchet vs HEAD.
const INV = mkdtempSync(join(tmpdir(), 'arch-md-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'no-god-files', intent: 'no file over 20 lines', check: { kind: 'oversized_files', maxLines: 20 }, mode: 'ratchet', severity: 'block' }]));
const small = (tag) => `// ${tag}\nexport const x = 1;\n`;
const big = (tag) => `// ${tag}\n` + Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

const repo = mkdtempSync(join(tmpdir(), 'arch-md-repo-'));
mkdirSync(join(repo, 'engineA')); mkdirSync(join(repo, 'toolsB'));
writeFileSync(join(repo, 'engineA', 'a.mjs'), small('a'));
writeFileSync(join(repo, 'toolsB', 'b.mjs'), small('b'));
sh('git init -q && git config user.email t@t && git config user.name t', repo);
spawnSync('bash', [INSTALL, repo, 'engineA,toolsB', INV], { encoding: 'utf8' });

// 1. clean initial commit allowed
let r = sh('git add -A && git commit -q -m init', repo);
expect('clean initial commit ALLOWED', r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);

// 2. rot in the SECOND listed dir (toolsB) is BLOCKED — proves the loop gates beyond the first dir
writeFileSync(join(repo, 'toolsB', 'huge.mjs'), big('huge'));
r = sh('git add -A && git commit -q -m rot-in-second-dir', repo);
const out2 = r.stdout + r.stderr;
expect('rot in 2nd dir (toolsB) BLOCKED', r.status !== 0 && /no-god-files/.test(out2), `exit ${r.status}: ${out2}`);
const log = sh('git log --oneline', repo).stdout.trim().split('\n').filter(Boolean);
expect('rot commit did NOT land', log.length === 1, `commits=${log.length}`);

// 3. with the rot reverted, a clean change (small file in engineA) commits fine
sh('rm -f toolsB/huge.mjs', repo); // revert the blocked rot so the tree is clean again
writeFileSync(join(repo, 'engineA', 'c.mjs'), small('c'));
r = sh('git add -A && git commit -q -m clean-change', repo);
expect('clean change ALLOWED', r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);

console.log(failed === 0 ? '\nPASS: multi-dir pre-commit gate gates every listed dir independently ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
