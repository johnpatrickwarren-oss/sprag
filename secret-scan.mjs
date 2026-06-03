// secret-scan.mjs — secret_scan: count likely-committed credentials. Deterministic, no model, no
// ast-grep (a text/regex walk). The credential a behavioral test and the structural metrics are both
// blind to — an API key / token / private key inlined into source (a thing AI codegen does when wiring
// up an integration). Use an absolute `max: 0`. HIGH-PRECISION by design (a max:0 gate can't tolerate
// false positives): specific provider key shapes + private-key blocks, plus ONE guarded generic
// `secret = "..."` rule that excludes env refs / placeholders / low-entropy values. Only TRACKED
// (committable) files are scanned — a gitignored .env is correctly invisible. Suppression-aware
// (`anchor:allow <id>` on the line). Kept in its own module so metrics.mjs stays under its God-file limit.
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { isSkippedDir, isGeneratedFile, gitTrackedSet } from './metrics.mjs';

const SECRET_RES = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['gcp-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['stripe-key', /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/],
  ['google-oauth', /\bya29\.[A-Za-z0-9_-]{20,}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
];
// generic `secret/password/api_key/token = "value"` — the high-false-positive case, so the captured
// value is filtered: env refs (${X} / process.env / ALL_CAPS const), placeholders (<...>, xxxx, your-,
// example), and low-entropy fillers (≤2 distinct chars) are NOT secrets.
const ASSIGN_RE = /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|token)["']?\s*[:=]\s*["']([^"']{8,})["']/gi;
function looksLikePlaceholder(v) {
  return /\$\{|process\.env|import\.meta|os\.environ|getenv|<[^>]*>|x{4,}|example|placeholder|changeme|your[_-]|dummy|sample|redacted/i.test(v)
    || /^[A-Z0-9_]{8,}$/.test(v) // ENV-style constant reference, e.g. MY_TOKEN_VAR
    || new Set(v).size <= 2;      // 'aaaaaaaa', '00000000'
}
const SECRET_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.go', '.py', '.rb', '.java', '.rs', '.php', '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.properties', '.txt', '.md'];
const scanName = (name) => SECRET_EXTS.some((e) => name.endsWith(e)) || /^\.env(\.|$)/.test(name) || name === 'Dockerfile';
function secretsInLine(line) {
  let n = 0;
  for (const [, re] of SECRET_RES) if (re.test(line)) n++;
  for (const m of line.matchAll(ASSIGN_RE)) if (!looksLikePlaceholder(m[1])) n++;
  return n;
}
export function secretScanCount(dir, check, invId) {
  if (!dir || !existsSync(dir)) return 0;
  const roots = (check.dirs || ['.']).map((d) => join(dir, d)).filter((p) => existsSync(p));
  const supRe = invId && new RegExp(`anchor:allow\\s+${invId}\\b`);
  const tracked = gitTrackedSet(dir);
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (isSkippedDir(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!scanName(name) || isGeneratedFile(p)) continue;
      if (tracked && !tracked.has(pathResolve(p))) continue;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (supRe && supRe.test(line)) continue;
        n += secretsInLine(line);
      }
    }
  };
  for (const r of roots) walk(r);
  return n;
}
