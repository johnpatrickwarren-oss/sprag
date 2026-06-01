// Runs every test-*.mjs in this dir and prints a one-line summary. `npm test` runs this.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(HERE).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
let failed = 0;
for (const t of tests) {
  const r = spawnSync('node', [t], { cwd: HERE, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '(no output)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.padEnd(26)} ${last.replace(/^PASS:\s*/, '').slice(0, 80)}`);
  if (!ok && r.stderr) console.log(r.stderr.trim().split('\n').slice(-3).join('\n'));
}
console.log(`\n${tests.length - failed}/${tests.length} suites passed.`);
process.exit(failed ? 1 : 0);
