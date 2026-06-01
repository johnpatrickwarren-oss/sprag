# Architectural-invariant gate — P0 prototype

The first build of the direction in `design/architectural-invariant-gate.md`: enforce
**human-authored architectural invariants** as a **gate on every change**, ratcheted against a
baseline, so AI-built codebases don't silently rot (the k10s failure mode:
https://blog.k10s.dev/im-going-back-to-writing-code-by-hand/).

This is the architectural analog of the behavioral `prototypes/verification-harness/test-gate.mjs`.

## Run

```bash
node arch-gate.mjs sample --baseline   # record the clean sample's metrics as the accepted baseline
node arch-gate.mjs sample              # check -> PASS (exit 0)
node test-arch-gate.mjs                # self-contained proof: passes clean, blocks 3 rot diffs (exit 0)
```

Exit codes: `0` pass · `3` blocked (rot) · `64` usage.

## What it does

`invariants.json` declares human-authored invariants; `arch-gate.mjs` computes each metric over the
codebase and **blocks** on (a) an absolute `max` breach or (b) a `ratchet` regression vs
`baseline.json` (never-get-worse). Three invariants here map to the k10s tenets:

| Invariant | Check | k10s tenet |
|---|---|---|
| `model-not-god-object` | `Model` struct field count (max 8, ratchet) | god object (1 & 2) |
| `no-positional-rows` | magic integer-index access (`ra[3]`) count (max 0) | positional fragility (4) |
| `bounded-dispatch` | `switch m.view` case count (ratchet) | central per-view dispatch (2) |

The **ratchet is the key idea**: it blocks the *13th* Model field, not the 30th — catching the
*trend* as it's introduced, which is what would have flagged k10s at commit ~20 instead of at
collapse (commit 234). Demo: adding one `Model` field is blocked at 6→7, *before* the absolute max.

## Wiring it in (the gate stops rot before it lands)

Two integration points turn the checker into an enforcement gate:

**Pre-commit hook** — blocks a commit that makes architecture worse than HEAD (ratchet vs the last
commit), so rot can't land:
```bash
./install-hook.sh <repo-dir> <src-rel-path>     # writes <repo>/.git/hooks/pre-commit
node test-precommit.mjs                          # proof: rot commit blocked + doesn't land; clean allowed
```
The hook computes the baseline from HEAD on each commit (no manual baseline upkeep). Bypass
(discouraged) is `git commit --no-verify`.

**AI-loop feedback gate** — runs the gate; on a block, feeds the violation back to a pluggable
**fixer** and re-checks, until it passes or escalates:
```bash
node arch-loop.mjs <dir> --fixer "<cmd>" [--max-iters 3]
node test-arch-loop.mjs                          # proof: converges on a good fixer, escalates on a stuck one
```
The fixer is a stub in tests; in real use it's a claude session (cwd = the code dir, reads
`ARCH_GATE_FEEDBACK` / `.arch-feedback.md`) — reusing `prototypes/verification-harness`'s
watchdog-wrapped session runner. **On escalation the loop does NOT relax the invariant** — a fixer
that can't satisfy the gate means the change is genuinely incompatible with the architecture, which
is a human call (the inverse of the behavioral harness's phantom problem: here a stuck loop means
the *code* is wrong, not the invariant).

## Auditable suppressions (escape hatch that stays visible)

A per-occurrence check is suppressed on a line carrying `// anchor:allow <invariant-id>: <reason>`.
The instance is **not counted as a violation** but **is reported** in a "Suppressions" section — so
the escape hatch is visible and auditable, never silent. (A gate with no escape hatch gets disabled
wholesale; one with *untracked* suppression rots silently — this is the middle path.) Metric/ratchet
invariants are instead "suppressed" by deliberately re-recording the baseline.

```go
n := legacyRow[2] // anchor:allow no-positional-rows: legacy CSV import, tracked in #123
```

## Debt-trend report (the early warning k10s never had)

```bash
node arch-trend.mjs <repo> <src-rel> [--last N=20] [--json]
node test-arch-trend.mjs    # proof: surfaces a Model growing 6->10 over commits + flags the max breach
```

Walks git history, computes each invariant's metric at every commit, prints the trend, and flags
where each invariant first breaches its max. This makes accumulating rot **visible early** — the
article's author only discovered it at collapse because velocity hid the trend.

## Engines & multi-language

Checks are computed by a per-invariant **engine** (`engine` + `lang` fields):
- **`heuristic`** (default) — lightweight text/brace parsing of Go-flavored source, no deps.
- **`ast-grep`** — **real multi-language AST** via `@ast-grep/napi` (TypeScript/JS here).

So one setup gates multiple languages: the Go invariants run on the heuristic engine; the TS
invariants (`invariants.ts.json` against `sample-ts/`) run on a genuine TS AST.
```bash
npm install                                                  # @ast-grep/napi (for the ast-grep engine)
node test-arch-gate-ts.mjs                                   # proof: real-AST gate enforces the tenets on TypeScript
node arch-gate.mjs sample-ts --invariants invariants.ts.json --baseline   # then check vs it
```
Adding a language = a parser adapter in `arch-gate.mjs` (go/ast, more ast-grep langs, semgrep), not
new gate logic. Go also runs on real AST via `@ast-grep/lang-go` (incl. goroutine-mutation / T5); the heuristic engine remains a no-dep fallback.

## Starter tenet library

`library/tenets.json` ships the article's 5 tenets as ready-to-enable invariants (3 implemented, 2
planned). Copy the ones you want into your `invariants.json` and tune. See `library/README.md`.

## Honest scope

- Mechanical + deterministic (no model) → no "who-verifies-the-verifier" problem; invariants are
  human-authored (the article's Tenet 1).
- The heuristic (Go) engine is sample-grade text parsing; the ast-grep (TS) engine is real AST.
  Production would add go/ast + more ast-grep/semgrep rules behind the same adapter seam.
- Remaining (design §12): `forbid_pattern` (T5 goroutine-mutation) + `scope_diff` (T3) check kinds;
  Go-via-ast-grep; then point it at a real GROWING repo.

## Tests (all self-contained)

`test-arch-gate.mjs` (gate+ratchet) · `test-precommit.mjs` (hook) · `test-arch-loop.mjs` (AI-loop) ·
`test-arch-trend.mjs` (debt trend) · `test-arch-gate-ts.mjs` (real-AST multi-language).
