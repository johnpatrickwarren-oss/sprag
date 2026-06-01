#!/usr/bin/env node
// scan.mjs <dir> [--name N] — survey a repo for "God code": oversized files, God functions, and
// coupling hubs (modules imported by many files). Reporting mode (lists offenders), not a gate.
//   thresholds: file >FILE lines, function >FUNC lines, module fan-in >HUB.
import { parse } from '@ast-grep/napi';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve as rsv } from 'node:path';

// generated/bundled code (not hand-written) — exclude so counts reflect real source.
function isGenerated(p) {
  if (/\.(min|bundle|browser)\.(js|mjs|cjs)$/.test(p)) return true;
  const m = p.match(/^(.*)\.(js|cjs|mjs|jsx)$/); // compiled sibling of a .ts/.tsx?
  return !!m && (existsSync(m[1] + '.ts') || existsSync(m[1] + '.tsx'));
}

const dir = process.argv[2];
const name = (process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : dir) || '?';
if (!dir) { console.error('usage: scan.mjs <dir> [--name N]'); process.exit(64); }
const FILE = 500, FUNC = 80, HUB = 12;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'out', 'coverage', '.astro']);
const JSX = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const CODE = [...JSX, '.go', '.py'];

const files = [];
(function walk(d) { for (const n of readdirSync(d)) { if (SKIP.has(n)) continue; const p = join(d, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) walk(p); else if (CODE.some((e) => n.endsWith(e)) && !/\.d\.ts$/.test(n) && !isGenerated(p)) files.push(p); } })(dir);

const godFiles = [];
const godFns = [];
const fanin = new Map();
const importRe = /(?:\bfrom|\brequire\(\s*|\bimport\(\s*)\s*['"]([^'"]+)['"]/g;
const FN_KINDS = ['function_declaration', 'arrow_function', 'method_definition', 'function_expression', 'generator_function_declaration'];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n').length;
  if (lines > FILE) godFiles.push({ f: relative(dir, f), lines });
  // God functions + fan-in only for JS/TS (ast-grep Tsx)
  if (JSX.some((e) => f.endsWith(e))) {
    try {
      const root = parse('Tsx', src).root();
      for (const k of FN_KINDS) for (const fn of root.findAll({ rule: { kind: k } })) { const r = fn.range(); const len = r.end.line - r.start.line + 1; if (len > FUNC) godFns.push({ f: relative(dir, f), line: r.start.line + 1, len }); }
    } catch { /* parse error: skip */ }
    let m; while ((m = importRe.exec(src))) { const s = m[1]; if (!s.startsWith('.')) continue; const key = rsv(dirname(f), s).replace(/\.(ts|tsx|js|mjs|cjs|jsx)$/, ''); (fanin.get(key) || fanin.set(key, new Set()).get(key)).add(f); } }
}
const hubs = [...fanin.entries()].map(([k, v]) => ({ mod: relative(dir, k), n: v.size })).filter((h) => h.n > HUB).sort((a, b) => b.n - a.n);
godFiles.sort((a, b) => b.lines - a.lines); godFns.sort((a, b) => b.len - a.len);

const total = godFiles.length + godFns.length + hubs.length;
console.log(`\n=== ${name} === (${files.length} source files; ${total} God-code findings)`);
console.log(`God files (>${FILE} lines): ${godFiles.length}`); godFiles.slice(0, 6).forEach((x) => console.log(`   ${x.lines}  ${x.f}`));
console.log(`God functions (>${FUNC} lines): ${godFns.length}`); godFns.slice(0, 6).forEach((x) => console.log(`   ${x.len}  ${x.f}:${x.line}`));
console.log(`Coupling hubs (fan-in >${HUB}): ${hubs.length}`); hubs.slice(0, 6).forEach((x) => console.log(`   ${x.n}  ${x.mod}`));
console.log(JSON.stringify({ scan: name, files: files.length, godFiles: godFiles.length, godFns: godFns.length, hubs: hubs.length }));
