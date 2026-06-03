# Threat model: the gate that can't be weakened

Most quality gates assume the adversary is *outside* the gate — a careless commit, a regression to
catch. When the author of the code is an **AI agent told "make the gate pass,"** that assumption
breaks: the agent can edit the gate itself. The fastest way to make a failing gate green is not to fix
the code — it's to **silence the gate**. A gate that can be silenced is theater.

sprag is built for that adversary. Two failure modes turn any gate into a silent no-op, and an agent
optimizing for "make it pass" will find both. sprag closes them.

## The two silent-failure modes

1. **The gate dies quietly.** If the analyzer can't run (engine not installed, wrong-platform binary,
   ABI mismatch), a naive gate scores 0 findings and reports PASS. sprag **fails closed**: an
   unavailable engine is a hard error (exit 2), never a green check. A no-op gate is the worst possible
   failure for a gate, so it must be loud.

2. **The gate gets relaxed.** Raise a threshold, drop a rule, downgrade severity, re-baseline upward,
   exempt the offending item, or stage the relaxation and revert the working file. sprag's
   **meta-ratchet** gates its *own* config + baseline against git: the ruleset may only move **forward**
   (stricter). Any loosening blocks — unless it's done **on purpose and on the record**
   (`ARCH_ALLOW_RELAX=1`), which still prints exactly what was loosened.

## The bypass catalogue

Every shortcut an agent reaches for, and the mechanism that stops it:

| The cheat | sprag's response | Mechanism |
|---|---|---|
| Raise a threshold (`maxLines`, `maxComplexity`, `max`…) | **BLOCKED** | meta-ratchet: raised ceiling vs git ref |
| Re-baseline upward (grandfather the new debt) | **BLOCKED** | meta-ratchet: raised baseline |
| Delete the rule | **BLOCKED** | meta-ratchet: invariant removed (it guards itself) |
| Downgrade `block` → `warn` | **BLOCKED** | meta-ratchet: severity downgrade |
| Remove a baseline floor for a still-active rule | **BLOCKED** | meta-ratchet: floor removal |
| Exempt the item (grow `allow` / `allowed` / `exclude`) | **BLOCKED** | meta-ratchet: exemption-list growth |
| Stage the relaxation, revert the working file | **BLOCKED** | meta-ratchet `from: "index"` (checks the staged config) |
| Kill the analysis engine so checks score 0 | **BLOCKED** (exit 2) | fail-closed engine |
| **Actually fix the code** | **PASS** | — |
| Loosen deliberately, `ARCH_ALLOW_RELAX=1` | **PASS**, relaxation printed | the auditable escape hatch |

## Run it yourself

```bash
node demo-threat-model.mjs
```

It builds a throwaway git repo, lets an "agent" introduce a real violation, then attempts each bypass
above and shows sprag blocking it — ending with the only two honest ways to green: fix the code, or
loosen it on the record. The demo is **self-verifying** (exit 1 if any bypass leaks), and runs in CI as
`test-arch-threatmodel.mjs`, so this document's claims are a tested invariant, not a promise.

```
  green baseline ........................ PASS ✅
  agent adds a 32-line god function ..... BLOCKED ✅ (the honest signal)

  told "make the gate pass", the agent tries to silence the gate instead of fixing it:

  🛡  BLOCKED  raise the limit (maxLines 20 → 50)
  🛡  BLOCKED  re-baseline (0 → 1, grandfather the debt)
  🛡  BLOCKED  delete the rule
  🛡  BLOCKED  downgrade severity (block → warn)
  🛡  BLOCKED  stage-then-revert the relaxed config
  🛡  BLOCKED  kill the analysis engine

  Every bypass blocked; the gate can only be passed honestly. ✅
```

## Honest limits

The meta-ratchet is strong but not magic — it's worth being precise about what it does *not* cover:

- **`git commit --no-verify` skips local hooks.** Local enforcement is a convenience; the *durable*
  enforcement is the self-gate running in CI (`npm test` runs it on every push), where `--no-verify`
  has no effect. Run sprag in CI, not only as a hook.
- **It trusts git history.** An attacker who can rewrite `HEAD` or force-push the baseline can move the
  reference the ratchet compares against. That edit is visible in history and in review — the meta-ratchet
  makes loosening *conspicuous*, it doesn't make it *impossible* for someone with write access and intent.
- **The secret and dependency checks are high-precision floors, not exhaustive scanners.** They favor
  misses over false alarms (so they're safe at `max: 0`); pair them with a dedicated scanner
  (gitleaks / Socket / Snyk) for depth.

The claim is narrow and true: **an agent editing the code and the gate in the same change cannot make a
real violation disappear without either fixing it or leaving a visible, on-the-record relaxation.**
