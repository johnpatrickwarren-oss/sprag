// Dogfood: sprag gates its OWN source with its OWN committed self-gate (invariants.harness.json +
// baseline-harness.json), run over the WHOLE repo on every `npm test`. This is the real thing the
// tool exists to do — enforce invariants as a gate on every change — applied to the tool itself, so a
// new module or a new check can't land un-gated. The self-gate enforces, beyond God-file/-function:
// the dependency surface (S1) + no hallucinated deps (S2), no committed secrets (SEC1), no `any` or
// ts-ignore directives (TS1/TS3), and — guarding itself — no silent relaxation of this config (M1).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };

const INV = join(HERE, 'invariants.harness.json');
const BASE = join(HERE, 'baseline-harness.json');

// the committed self-gate must PASS on the repo as it stands
const r = spawnSync('node', [GATE, HERE, '--invariants', INV, '--baseline-in', BASE], { encoding: 'utf8' });
expect('sprag passes its OWN full self-gate over the whole repo', r.status === 0 && /PASS/.test(r.stdout), `exit ${r.status}: ${r.stdout}${r.stderr}`);

// sanity: the self-gate actually enforces the session's new axes (so it can't be silently hollowed out
// to a couple of structural checks). The meta-ratchet (M1) guards removals at commit time; this guards
// the committed file right here in the suite.
const ids = new Set(JSON.parse(readFileSync(INV, 'utf8')).map((i) => i.id));
for (const id of ['dep-surface', 'no-unlocked-deps', 'no-committed-secrets', 'no-new-any', 'no-ts-ignore', 'no-config-relaxation']) {
  expect(`self-gate still enforces ${id}`, ids.has(id), 'missing from invariants.harness.json');
}

console.log(failed === 0 ? '\nPASS: the tool eats its own dog food — full self-gate, whole repo ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
