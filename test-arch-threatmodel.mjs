// Runs the threat-model demo and asserts every bypass is blocked — so the THREAT-MODEL.md claim
// ("a gate that can't be weakened") is a CI-tested invariant, not a marketing promise. The demo is
// self-verifying (exit 1 if any bypass leaks); this wraps it into the suite.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const r = spawnSync('node', [join(HERE, 'demo-threat-model.mjs')], { encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
const ok = r.status === 0 && /Every bypass blocked/.test(out) && !/LEAKED/.test(out);
console.log(ok ? 'ok  ' : 'FAIL', 'threat-model demo: every bypass blocked, gate passes only honestly');
if (!ok) console.log(out.split('\n').slice(-8).join('\n'));
console.log(ok ? '\nPASS: the "gate that can\'t be weakened" claim holds — every bypass blocked ✅' : '\nFAIL');
process.exit(ok ? 0 : 1);
