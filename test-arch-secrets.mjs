// Self-contained test for secret_scan: detects committed credentials (provider key shapes,
// private-key blocks, guarded generic secret="..."), ignores env refs / placeholders / ALL_CAPS env
// consts, and honors suppression. Fixture secrets are built by concatenation so THIS source never
// holds a live secret (no self-flag / external-scanner trip); the WRITTEN fixture files do.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'arch-gate.mjs');
let failed = 0;
const expect = (n, c, d) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : '  -- ' + d}`); if (!c) failed++; };
const tmp = () => mkdtempSync(join(tmpdir(), 'arch-sec-'));
const INV = mkdtempSync(join(tmpdir(), 'arch-sec-inv-')) + '/inv.json';
writeFileSync(INV, JSON.stringify([{ id: 'rule', intent: 'no committed secrets', check: { kind: 'secret_scan', dirs: ['.'] }, max: 0, severity: 'block' }]));
const metric = (dir) => { const r = spawnSync('node', [GATE, dir, '--invariants', INV, '--json'], { encoding: 'utf8' }); try { return JSON.parse(r.stdout).metrics.rule; } catch { return `ERR ${r.status}: ${r.stdout}${r.stderr}`; } };
const file = (body) => { const d = tmp(); writeFileSync(join(d, 'a.ts'), body); return d; };

// split-secret fixtures (assembled at runtime so the literal never appears in this file)
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const PRIV = '-----BEGIN RSA PRIVATE ' + 'KEY-----';
const REAL = 'api_key = "' + 'aB3xK9zQ7mP2' + '"';

expect('AWS access key detected (=1)', metric(file(`const k = "${AWS}";\n`)) === 1, `got ${metric(file(`const k = "${AWS}";\n`))}`);
expect('private-key block detected (=1)', metric(file(`${PRIV}\nMIIxyz\n`)) === 1, `got ${metric(file(`${PRIV}\nMIIxyz\n`))}`);
expect('generic secret assignment detected (=1)', metric(file(`${REAL}\n`)) === 1, `got ${metric(file(`${REAL}\n`))}`);

// false-positive guards: env ref (${...}), unquoted process.env, ALL_CAPS env const, placeholder -> 0
{
  const benign = 'const a = "' + '${DB_PASS}' + '";\n'           // ${...} env interpolation
    + 'password = process.env.DB_PASS;\n'                          // unquoted env ref
    + 'token = "' + 'MY_SECRET_ENV' + '";\n'                       // ALL_CAPS constant reference
    + 'apikey = "' + 'your-api-key-here' + '";\n';                 // placeholder
  const d = file(benign);
  expect('env refs / placeholders / ALL_CAPS NOT flagged (=0)', metric(d) === 0, `got ${metric(d)}`);
}

// suppression: anchor:allow on the line drops the match
{
  const d = file(`const k = "${AWS}"; // anchor:allow rule: documented sample key\n`);
  expect('suppressed secret not counted (=0)', metric(d) === 0, `got ${metric(d)}`);
}

// gate blocks at max:0 on a real secret
{
  const d = file(`const k = "${AWS}";\n`);
  const r = spawnSync('node', [GATE, d, '--invariants', INV], { encoding: 'utf8' });
  expect('committed secret BLOCKS (exit 3)', r.status === 3 && /✗ \[rule\]/.test(r.stdout + r.stderr), `exit ${r.status}: ${r.stdout}${r.stderr}`);
}

console.log(failed === 0 ? '\nPASS: secret_scan flags real credentials, ignores env/placeholder noise, suppresses ✅' : `\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);
