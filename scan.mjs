#!/usr/bin/env node
// scan.mjs <dir> [--name N] — survey a repo for "God code": oversized files, God functions, and
// coupling hubs (modules imported by many files). Reporting mode (lists offenders), not a gate.
//   thresholds: file >FILE lines, function >FUNC lines, module fan-in >HUB.
import { parse, registerDynamicLanguage } from '@ast-grep/napi';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve as rsv } from 'node:path';
import { createRequire } from 'node:module';
import { gitTrackedSet, lineCount } from './metrics.mjs';
const require = createRequire(import.meta.url);

// generated/bundled code (not hand-written) — exclude so counts reflect real source.
function isGenerated(p) {
  if (/\.(min|bundle|browser)\.(js|mjs|cjs)$/.test(p)) return true;
  const m = p.match(/^(.*)\.(js|cjs|mjs|jsx)$/); // compiled sibling of a .ts/.tsx?
  return !!m && (existsSync(m[1] + '.ts') || existsSync(m[1] + '.tsx'));
}

const dir = process.argv[2];
const name = (process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : dir) || '?';
if (!dir) { console.error('usage: scan.mjs <dir> [--name N]'); process.exit(64); }
const FILE = 500, FUNC = 150, COMPLEX = 12, HUB = 12; // FUNC = length BACKSTOP (huge-but-flat); COMPLEX = primary McCabe gate
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'out', 'coverage', '.astro',
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.eggs']); // + *.egg-info (suffix, handled in walk)
const JSX = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const CODE = [...JSX, '.go', '.py'];

const files = [];
const tracked = gitTrackedSet(dir); // when dir is a git repo, survey only non-ignored files (match the gate)
(function walk(d) { for (const n of readdirSync(d)) { if (SKIP.has(n) || n.endsWith('.egg-info')) continue; const p = join(d, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) walk(p); else if (CODE.some((e) => n.endsWith(e)) && !/\.d\.ts$/.test(n) && !isGenerated(p) && !(tracked && !tracked.has(rsv(p)))) files.push(p); } })(dir);

const godFiles = [];
const godFns = [];
const complexFns = [];
const fanin = new Map();
const importRe = /(?:\bfrom|\brequire\(\s*|\bimport\(\s*)\s*['"]([^'"]+)['"]/g;
// God-function kinds per language — real AST for Go/Python too, not just JS/TS (mirrors arch-gate.mjs).
const FN_JS = ['function_declaration', 'arrow_function', 'method_definition', 'function_expression', 'generator_function_declaration'];
const FN_KINDS = { go: ['function_declaration', 'method_declaration', 'func_literal'], python: ['function_definition'], ts: FN_JS };
// Cyclomatic decision nodes per language (mirrors arch-gate.mjs) — complexity = 1 + decisions + short-circuits.
const DEC = {
  go: ['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case'],
  python: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
  ts: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
};
const BOOL = (lang) => (lang === 'python' ? ['$A and $B', '$A or $B'] : ['$A && $B', '$A || $B']);
let _goReg = false, _pyReg = false;
function sgRoot(src, lang) {
  if (lang === 'go') { if (!_goReg) { registerDynamicLanguage({ go: require('@ast-grep/lang-go') }); _goReg = true; } return parse('go', src).root(); }
  if (lang === 'python') { if (!_pyReg) { registerDynamicLanguage({ python: require('@ast-grep/lang-python') }); _pyReg = true; } return parse('python', src).root(); }
  return parse('Tsx', src).root();
}
const langOf = (f) => (f.endsWith('.go') ? 'go' : f.endsWith('.py') ? 'python' : 'ts');

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lines = lineCount(src);
  if (lines > FILE) godFiles.push({ f: relative(dir, f), lines });
  // God functions: real AST for JS/TS, Go, AND Python (was JS/TS-only -> silently 0 for py/go).
  const lang = langOf(f);
  try {
    const root = sgRoot(src, lang);
    for (const k of (FN_KINDS[lang] || FN_KINDS.ts)) for (const fn of root.findAll({ rule: { kind: k } })) {
      const r = fn.range(); const len = r.end.line - r.start.line + 1;
      if (len > FUNC) godFns.push({ f: relative(dir, f), line: r.start.line + 1, len });
      let cx = 1;
      for (const dk of (DEC[lang] || DEC.ts)) cx += fn.findAll({ rule: { kind: dk } }).length;
      for (const bp of BOOL(lang)) cx += fn.findAll({ rule: { pattern: bp } }).length;
      if (cx > COMPLEX) complexFns.push({ f: relative(dir, f), line: r.start.line + 1, cx });
    }
  } catch { /* parse error: skip */ }
  // Coupling fan-in is relative-import based -> JS/TS family only (Python/Go use different import models).
  if (JSX.some((e) => f.endsWith(e))) {
    let m; while ((m = importRe.exec(src))) { const s = m[1]; if (!s.startsWith('.')) continue; const key = rsv(dirname(f), s).replace(/\.(ts|tsx|js|mjs|cjs|jsx)$/, ''); (fanin.get(key) || fanin.set(key, new Set()).get(key)).add(f); } }
}
const hubs = [...fanin.entries()].map(([k, v]) => ({ mod: relative(dir, k), n: v.size })).filter((h) => h.n > HUB).sort((a, b) => b.n - a.n);
godFiles.sort((a, b) => b.lines - a.lines); godFns.sort((a, b) => b.len - a.len); complexFns.sort((a, b) => b.cx - a.cx);

const total = godFiles.length + complexFns.length + godFns.length + hubs.length;
console.log(`\n=== ${name} === (${files.length} source files; ${total} God-code findings)`);
console.log(`God files (>${FILE} lines): ${godFiles.length}`); godFiles.slice(0, 6).forEach((x) => console.log(`   ${x.lines}  ${x.f}`));
console.log(`Complex functions (McCabe >${COMPLEX}): ${complexFns.length}`); complexFns.slice(0, 6).forEach((x) => console.log(`   ${x.cx}  ${x.f}:${x.line}`));
console.log(`God functions (>${FUNC} lines, length backstop): ${godFns.length}`); godFns.slice(0, 6).forEach((x) => console.log(`   ${x.len}  ${x.f}:${x.line}`));
console.log(`Coupling hubs (fan-in >${HUB}, JS/TS imports): ${hubs.length}`); hubs.slice(0, 6).forEach((x) => console.log(`   ${x.n}  ${x.mod}`));
console.log(JSON.stringify({ scan: name, files: files.length, godFiles: godFiles.length, complexFns: complexFns.length, godFns: godFns.length, hubs: hubs.length }));
