// Unit tests for the CLI front end (arch.mjs): language auto-detection and the `init` scaffolder.
// The integration suites drive the underlying engines directly (arch-gate.mjs etc.) and never go
// through `arch <sub>`, so arch.mjs scored 0% under mutate — every branch unasserted. detectLang is
// tested directly (pure); init is tested via subprocess (it spawns + process.exit's, so in-process
// is the wrong harness) by asserting the scaffolded invariants reflect the requested language.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectLang } from './arch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCH = join(HERE, 'arch.mjs');
let failed = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : `  -- got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) failed++; };
const ok = (n, cond, d) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${n}${cond ? '' : `  -- ${d}`}`); if (!cond) failed++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'arch-cli-'));
const mk = (d, rel, body = 'x\n') => { const p = join(d, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
const files = (d, n, ext) => { for (let i = 0; i < n; i++) mk(d, `f${i}${ext}`); };

// ── detectLang: dominant top-level language ──────────────────────────────────────
{ const d = tmp(); files(d, 3, '.go'); files(d, 1, '.ts');
  eq('detectLang: a mostly-Go dir is go', detectLang(d), 'go');
  const j = tmp(); files(j, 3, '.mjs'); files(j, 1, '.ts');
  eq('detectLang: a mostly-.mjs dir is js', detectLang(j), 'js'); }

// ── detectLang skip-list: node_modules / .git / vendor must NOT be counted ────────
// Top level is dominantly .ts (so the answer is 'ts'); each skipped dir is stuffed with a DIFFERENT
// language in greater volume. If any skip-comparison breaks (a dir gets walked), the dominant flips
// off 'ts' — and a mutant that skips EVERYTHING falls back to 'go' (first key) — so 'ts' pins all of
// the `n === 'node_modules' || n === '.git' || n === 'vendor'` comparisons at once.
{ const d = tmp();
  files(d, 4, '.ts');                 // top-level dominant
  files(join(d, 'node_modules'), 10, '.js');
  files(join(d, 'vendor'), 10, '.go');
  files(join(d, '.git'), 10, '.js');
  eq('detectLang: node_modules / vendor / .git are skipped (dominant stays ts)', detectLang(d), 'ts'); }

// ── init scaffolder (subprocess): the scaffolded invariants reflect --lang ────────
const runInit = (lang) => {
  const d = tmp(); files(d, 1, '.ts');
  const r = spawnSync('node', [ARCH, 'init', d, '--lang', lang], { encoding: 'utf8' });
  const invs = JSON.parse(readFileSync(join(d, 'arch-invariants.json'), 'utf8'));
  const by = (id) => invs.find((i) => i.id === id);
  return { r, invs, by };
};
{ const { r, by } = runInit('go');
  ok('init --lang go: exits 0', r.status === 0, `exit ${r.status}: ${r.stderr}`);
  ok('init --lang go: prints the "next:" guidance (status===0 branch)', /next:/.test(r.stdout), r.stdout);
  eq('init --lang go: god-functions invariant carries lang go (not the ts fallback)', by('no-god-functions')?.lang, 'go');
  eq('init --lang go: complex-functions invariant carries lang go', by('no-complex-functions')?.lang, 'go');
  ok('init --lang go: no module-fanin invariant (Go path skips it)', by('no-god-module') === undefined, JSON.stringify(by('no-god-module'))); }
{ const { by } = runInit('ts');
  eq('init --lang ts: god-functions invariant carries lang ts', by('no-god-functions')?.lang, 'ts');
  ok('init --lang ts: DOES add the module-fanin invariant (non-Go path)', by('no-god-module') !== undefined, 'expected no-god-module present'); }

console.log(failed === 0 ? '\nPASS: CLI language detection + init scaffolder asserted (arch.mjs) ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
