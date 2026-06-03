// ast-engine.mjs — the real-AST (ast-grep) engine + the AST-dependent metric walkers.
// Extracted from arch-gate.mjs so the gate stays under its OWN God-file limit (the tool dogfoods its
// own checks; metrics.mjs already split out the no-dep walkers for the same reason). Everything here
// needs the @ast-grep/napi parser: the engine loader, the author-rule `astgrepMetric`, and the
// recursive per-file God-function / cyclomatic-complexity counters.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';
import { isGeneratedFile, isSkippedDir, gitTrackedSet } from './metrics.mjs';

const require = createRequire(import.meta.url);

// ── engine load — FAIL CLOSED ───────────────────────────────────────────────────
// If the engine can't LOAD (module not installed, wrong-platform native binary, Node ABI mismatch)
// every ast-grep check would otherwise return 0 and the gate would silently PASS everything — a no-op
// gate is the worst possible failure for a gate (the "who watches the watcher" hole in the ratchet).
// So an engine-load/registration failure throws a tagged ENGINE_UNAVAILABLE that callers must NOT
// swallow; main() turns it into a loud exit 2. (A per-FILE parse error is a smaller, local problem —
// the caller reports it and skips that one file, never silently zeroing the whole metric.)
let _sg = null, _goRegistered = false, _pyRegistered = false, _engineErr = null;
function engineUnavailable(e) {
  const err = new Error(`ast-grep engine unavailable (${String(e && e.message || e).split('\n')[0]}). Run \`npm install\` in the gate's directory. The gate FAILS CLOSED (exit 2) rather than silently scoring 0 and passing every structural check.`);
  err.code = 'ENGINE_UNAVAILABLE';
  return err;
}
function loadSg() {
  if (_sg) return _sg;
  if (_engineErr) throw _engineErr;
  if (process.env.ARCH_ENGINE_UNAVAILABLE) throw (_engineErr = engineUnavailable(new Error('forced via ARCH_ENGINE_UNAVAILABLE')));
  try { return (_sg = require('@ast-grep/napi')); }
  catch (e) { throw (_engineErr = engineUnavailable(e)); }
}
export function sgRoot(src, lang) {
  const sg = loadSg();
  if (lang === 'go' && !_goRegistered) {
    try { sg.registerDynamicLanguage({ go: require('@ast-grep/lang-go') }); _goRegistered = true; }
    catch (e) { throw (_engineErr = engineUnavailable(e)); }
  }
  if ((lang === 'python' || lang === 'py') && !_pyRegistered) {
    try { sg.registerDynamicLanguage({ python: require('@ast-grep/lang-python') }); _pyRegistered = true; }
    catch (e) { throw (_engineErr = engineUnavailable(e)); }
  }
  const grammar = lang === 'go' ? 'go' : (lang === 'python' || lang === 'py') ? 'python' : 'Tsx';
  return sg.parse(grammar, src).root(); // a parse error here is per-file: it propagates to the caller
}

export function astgrepMetric(inv, src) {
  const c = inv.check;
  const root = sgRoot(src, inv.lang || 'ts');
  const lines = src.split('\n');
  const supRe = inv.id && new RegExp(`anchor:allow\\s+${inv.id}\\b`);
  const notSuppressed = (n) => !(supRe && supRe.test(lines[n.range().start.line] || ''));

  if (c.kind === 'magic_index_count') {
    return root.findAll('$A[$N]')
      .filter((n) => /^\d+$/.test(n.getMatch('N')?.text() ?? ''))
      .filter(notSuppressed).length;
  }
  if (c.kind === 'forbid_pattern') {
    // author-supplied structural rule: a `pattern`, optionally only when `inside` another node
    // (by `inside` pattern or `inside_kind` node kind, e.g. go_statement for "inside a goroutine").
    const rule = { pattern: c.pattern };
    if (c.inside_kind) rule.inside = { kind: c.inside_kind, stopBy: 'end' };
    else if (c.inside) rule.inside = { pattern: c.inside, stopBy: 'end' };
    return root.findAll({ rule }).filter(notSuppressed).length;
  }
  if (c.kind === 'ast_grep_rule') {
    // FULL extensibility: the invariant carries a raw ast-grep rule object (pattern / kind / inside /
    // has / all / any / not / regex / ...). Counts matches (suppression-aware). Lets a project encode
    // its OWN architectural rules in JSON with no code changes.
    return root.findAll({ rule: c.rule }).filter(notSuppressed).length;
  }
  if (c.kind === 'max_function_lines') {
    // generic God-function detector: count functions whose line span exceeds maxLines (lang-aware).
    const lang = inv.lang || 'ts';
    const kinds = FN_KINDS[lang] || FN_KINDS.ts;
    let over = 0;
    for (const k of kinds) {
      for (const f of root.findAll({ rule: { kind: k } })) {
        const r = f.range();
        if ((r.end.line - r.start.line + 1) > c.maxLines && notSuppressed(f)) over++;
      }
    }
    return over;
  }
  const isGo = (inv.lang || 'ts') === 'go';
  if (c.kind === 'struct_field_count') {
    if (isGo) {
      const st = root.find(`type ${c.struct} struct { $$$ }`);
      return st ? st.findAll({ rule: { kind: 'field_declaration' } }).length : 0;
    }
    const cls = root.find(`class ${c.struct} { $$$ }`) || root.find(`interface ${c.struct} { $$$ }`);
    if (!cls) return 0;
    return cls.findAll({ rule: { kind: 'public_field_definition' } }).length
      + cls.findAll({ rule: { kind: 'property_signature' } }).length;
  }
  if (c.kind === 'switch_case_count') {
    const sw = root.findAll({ rule: { kind: isGo ? 'expression_switch_statement' : 'switch_statement' } });
    if (!sw.length) return 0;
    return sw[0].findAll({ rule: { kind: isGo ? 'expression_case' : 'switch_case' } }).length;
  }
  throw new Error(`ast-grep: unknown check kind ${c.kind}`);
}

// Shared per-language function-node kinds (used by the recursive God-function + complexity walkers
// AND by astgrepMetric's max_function_lines branch).
const FN_JS_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const FN_EXTS = { go: ['.go'], python: ['.py'], py: ['.py'], ts: FN_JS_EXTS, js: FN_JS_EXTS };
const FN_KINDS = {
  go: ['function_declaration', 'method_declaration', 'func_literal'],
  python: ['function_definition'], py: ['function_definition'],
  ts: ['function_declaration', 'arrow_function', 'method_definition', 'function_expression', 'generator_function_declaration'],
};

// Parse one file, failing CLOSED on an engine-load error (rethrow) and LOUD-but-local on a per-file
// parse error (warn + skip). Returns the AST root, or null when the file should be skipped.
function parseFileOrSkip(p, src, lang) {
  try { return sgRoot(src, lang); }
  catch (e) {
    if (e && e.code === 'ENGINE_UNAVAILABLE') throw e; // fail closed: abort the whole run, never score 0
    console.error(`arch-gate: WARN unparseable, not analyzed: ${p}`); return null; // per-file: loud, not silent
  }
}

// Walk `dir` (git-tracked, non-generated source for `lang`), parse each file on its own (the correct
// unit — concatenating mixed files into one parse is fragile), and call `onRoot(root, src, p)` so the
// God-function and complexity counters share one tree walk. readSource() concatenates only the
// top-level dir, so this recursive per-file walk is what makes the checks correct on a nested tree.
function walkParsed(dir, lang, onRoot) {
  if (!dir || !existsSync(dir)) return;
  const exts = FN_EXTS[lang] || FN_EXTS.ts;
  const tracked = gitTrackedSet(dir);
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (isSkippedDir(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!exts.some((e) => n.endsWith(e)) || isGeneratedFile(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
      const src = readFileSync(p, 'utf8');
      const root = parseFileOrSkip(p, src, lang);
      if (root) onRoot(root, src, p);
    }
  };
  walk(dir);
}

// God-function detector (recursive, per file): count functions whose line span exceeds maxLines.
// Suppression-aware via `anchor:allow <id>`.
export function godFunctionCount(dir, maxLines, lang, invId) {
  const kinds = FN_KINDS[lang] || FN_KINDS.ts;
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let over = 0;
  walkParsed(dir, lang, (root, src) => {
    const lines = src.split('\n');
    for (const k of kinds) {
      for (const f of root.findAll({ rule: { kind: k } })) {
        const r = f.range();
        if ((r.end.line - r.start.line + 1) <= maxLines) continue;
        if (supRe && supRe.test(lines[r.start.line] || '')) continue;
        over++;
      }
    }
  });
  return over;
}

// Recursive author-rule counter: count matches of an arbitrary ast-grep `rule` across the WHOLE tree,
// per file. This is the tree-walking sibling of astgrepMetric's `ast_grep_rule` (which only sees the
// concatenated top-level dir) — so a project rule actually covers a nested src/ tree. Suppression-aware
// via `anchor:allow <id>` on the match's start line. Powers the type-strictness tenets (count `any` /
// non-null `!` / `@ts-ignore`) as pure config, and any other project-specific rule.
export function astgrepTreeCount(dir, rule, lang, invId) {
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let n = 0;
  walkParsed(dir, lang || 'ts', (root, src) => {
    const lines = src.split('\n');
    for (const node of root.findAll({ rule })) {
      if (supRe && supRe.test(lines[node.range().start.line] || '')) continue;
      n++;
    }
  });
  return n;
}

// Cyclomatic-complexity decision nodes per language (control-flow branch points). A function's
// complexity ≈ 1 + (decision nodes) + (short-circuit && / || / and / or) within it — a LESS-ARBITRARY
// signal than raw line count: it flags BRANCHY functions (hard to follow + test; cyclomatic > ~10 is
// the McCabe/NIST anchor), not merely long-but-flat ones. Reuses the same parse as the god-function
// check, so it is deterministic and adds no model cost. Conservative: a function's count includes
// branches inside nested closures — fine for a ratcheted floor; suppress legit cases.
const DECISION_KINDS = {
  go: ['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case'],
  python: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
  py: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'conditional_expression', 'case_clause'],
  ts: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
};
DECISION_KINDS.js = DECISION_KINDS.ts;
const boolPatterns = (lang) => ((lang === 'python' || lang === 'py') ? ['$A and $B', '$A or $B'] : ['$A && $B', '$A || $B']);
export function complexFunctionCount(dir, maxComplexity, lang, invId) {
  const fnKinds = FN_KINDS[lang] || FN_KINDS.ts;
  const decisionKinds = DECISION_KINDS[lang] || DECISION_KINDS.ts;
  const bools = boolPatterns(lang);
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  let over = 0;
  walkParsed(dir, lang, (root, src) => {
    const lines = src.split('\n');
    for (const fk of fnKinds) {
      for (const fn of root.findAll({ rule: { kind: fk } })) {
        let cx = 1;
        for (const dk of decisionKinds) cx += fn.findAll({ rule: { kind: dk } }).length;
        for (const bp of bools) cx += fn.findAll({ rule: { pattern: bp } }).length;
        if (cx <= maxComplexity) continue;
        const sl = fn.range().start.line; // suppression on the function line OR the line directly above
        if (supRe && (supRe.test(lines[sl] || '') || supRe.test(lines[sl - 1] || ''))) continue;
        over++;
      }
    }
  });
  return over;
}
