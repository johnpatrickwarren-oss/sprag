# Architectural-invariant gate

Enforce **human-authored architectural invariants** as a **gate on every change**, ratcheted against
a baseline, so AI-built codebases don't silently rot (the k10s failure mode:
https://blog.k10s.dev/im-going-back-to-writing-code-by-hand/). Mechanical + deterministic (no model),
so no oracle-quality ceiling and no "who-verifies-the-verifier" problem. Design:
`design/architectural-invariant-gate.md`. The architectural analog of the behavioral
`prototypes/verification-harness/`.

## Adopt on your repo (ratchet from where you are)

One unified CLI (`arch`, or `node arch.mjs <cmd>`):

```bash
npm install                                              # ast-grep engines
node arch.mjs init <src-dir>                             # scaffold generic invariants + baseline (lang auto-detected)
node arch.mjs check <src-dir> --invariants arch-invariants.json --baseline-in arch-invariants.baseline.json
node arch.mjs install-hook <repo-dir> <src-rel> arch-invariants.json   # pre-commit gate (blocks new debt vs HEAD)
node arch.mjs loop  <src-dir> --fixer "<your builder cmd>"             # AI-loop feedback gate
node arch.mjs trend <repo> <src-rel> --invariants arch-invariants.json # debt trend over history
```

`init` scaffolds the generic, no-tuning checks (god-files, god-functions, coupling fan-in); add
project-specific tenets from `library/tenets.json` or any raw ast-grep rule via the `ast_grep_rule`
check kind. The ratchet means you don't need perfect thresholds up front: start from your current
state, and the gate refuses to make it worse.

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

`library/tenets.json` ships the article's **all 5 tenets** as ready-to-enable invariants (T1–T5, all
implemented). Copy the ones you want into your `invariants.json` and tune. See `library/README.md`.

## Honest scope

- Mechanical + deterministic (no model) → no "who-verifies-the-verifier" problem; invariants are
  human-authored (the article's Tenet 1).
- Real AST on **Go and TypeScript** via ast-grep (`@ast-grep/napi` + `@ast-grep/lang-go`); the
  heuristic Go engine remains a no-dep fallback. More languages = a parser adapter, not new gate logic.
- Generic, no-tuning checks (work on any repo): `oversized_files` (God file), `max_function_lines`
  (God function), `module_fanin` (a module imported by too many files — the k10s "everything depends
  on the God object" coupling smell).
- Remaining (design §12): more generic metrics; richer `scope_diff`; broader real-repo trials.

## Tests (all self-contained)

`test-arch-gate.mjs` (gate+ratchet+scope) · `test-precommit.mjs` (hook) · `test-arch-loop.mjs`
(AI-loop) · `test-arch-trend.mjs` (debt trend) · `test-arch-gate-ts.mjs` (real-AST TypeScript) ·
`test-arch-gate-go-ast.mjs` (real-AST Go incl. goroutine-mutation).
