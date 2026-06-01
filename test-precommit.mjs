// Self-contained test for the pre-commit gate: in a throwaway git repo, a rot-introducing commit
// is BLOCKED (ratchet vs HEAD) and never lands; clean commits are allowed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, 'install-hook.sh');
const CLEAN = readFileSync(join(HERE, 'sample', 'ui.go'), 'utf8');
const sh = (cmd, cwd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const repo = mkdtempSync(join(tmpdir(), 'arch-repo-'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'ui.go'), CLEAN);
sh('git init -q && git config user.email t@t && git config user.name t', repo);
spawnSync('bash', [INSTALL, repo, 'src'], { encoding: 'utf8' });

// 1. clean initial commit allowed (no HEAD baseline yet -> only absolute checks; clean is under max)
let r = sh('git add -A && git commit -q -m init', repo);
expect('clean initial commit ALLOWED', r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);

// 2. commit adding a Model field is BLOCKED (ratchet vs HEAD) and does NOT land
writeFileSync(join(repo, 'src', 'ui.go'), CLEAN.replace('\tquitting bool\n', '\tquitting bool\n\tselected int\n'));
r = sh('git add -A && git commit -q -m rot', repo);
const out2 = r.stdout + r.stderr;
expect('rot commit (+Model field) BLOCKED', r.status !== 0 && /model-not-god-object/.test(out2), `exit ${r.status}: ${out2}`);
const log = sh('git log --oneline', repo).stdout.trim().split('\n').filter(Boolean);
expect('rot commit did NOT land (still 1 commit)', log.length === 1, `commits=${log.length}`);

// 3. a clean change commits fine
writeFileSync(join(repo, 'src', 'ui.go'), CLEAN + '\n// touched, no architectural change\n');
r = sh('git add -A && git commit -q -m clean-change', repo);
expect('clean change ALLOWED', r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);

console.log(failed === 0 ? '\nPASS: pre-commit gate blocks rot, lets clean code through ✅' : `\nFAIL: ${failed} case(s)`);
process.exit(failed ? 1 : 0);
