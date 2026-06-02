# Architectural-invariant gate

Enforce **human-authored architectural invariants** as a **gate on every change**, ratcheted against
a baseline, so AI-built codebases don't silently rot (the k10s failure mode:
https://blog.k10s.dev/im-going-back-to-writing-code-by-hand/). Mechanical + deterministic (no model),
so no oracle-quality ceiling and no "who-verifies-the-verifier" problem.

## Install

```bash
# Install straight from GitHub (works today — no build step):
npm i -g github:johnpatrickwarren-oss/arch-gate     # provides the `arch-gate` command

# Once published to npm:
#   npm i -g @johnpatrickwarren-oss/arch-gate
#   npx @johnpatrickwarren-oss/arch-gate init <src-dir>
```

Or clone and run directly: `git clone https://github.com/johnpatrickwarren-oss/arch-gate && cd arch-gate && npm install && node arch.mjs <cmd>`.

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

## Engines, languages & extensibility

Checks are computed by a per-invariant **engine** (`engine` + `lang` fields):
- **`ast-grep`** — **real AST** via `@ast-grep/napi` (+ `@ast-grep/lang-go`, `@ast-grep/lang-python`):
  **Go, TypeScript/JS, and Python**. Adding a language is a small parser adapter, not new gate logic.
- **`heuristic`** (default) — lightweight text/brace parsing of Go-flavored source, no deps (fallback).

Built-in check kinds: `struct_field_count`, `switch_case_count`, `magic_index_count`, `forbid_pattern`,
`oversized_files`, `max_function_lines`, `max_complexity`, `module_fanin`, `scope_diff`, `forbid_path`,
`time_bomb_tests`, `require_tests`. For anything bespoke, the **`ast_grep_rule`** kind takes a raw
ast-grep rule object, so a project can encode its *own* architectural rules in JSON with no code changes.

### On line counts vs. complexity

Raw line count (`max_function_lines`, `oversized_files`) is a *cheap proxy*, and the specific number is a
convention, not a law — a long-but-flat function is fine; a short, deeply-branched one is not. **`max_complexity`**
is the less-arbitrary signal: it approximates **cyclomatic complexity** (1 + decision points + short-circuit
`&&`/`||`) per function from the same AST parse — flagging *branchy* functions (the ones that are genuinely
hard to follow and test; >~10 is the McCabe/NIST anchor), not merely long ones. Same zero-token, deterministic
cost as `max_function_lines`. What keeps *any* threshold from being tyrannical is the design, not the number:
**you** author the limit for your codebase, the **ratchet** enforces "never worse" rather than a magic absolute,
and a legitimate overrun is recorded with an **auditable suppression** (`// anchor:allow <id>: <reason>`) — visible,
not silent. The gate surfaces *candidates for judgment*, not verdicts.

The checks below go beyond size — **layering / dependency-direction** and **test discipline** — classes
the metric checks are blind to (learned by refactoring real repos where the rot lived there):

- **`require_tests`** `{ dirs:[...] }` — the deterministic **shadow of TDD**: flags source modules under
  `dirs` with no corresponding test (base-name match, layout-agnostic: `foo.ts` ↔ `foo.test.ts` /
  `foo_test.go` / `test_foo.py`). Can't prove test-*first*, but enforces TDD's durable outcome — "no
  untested code ships" — as a ratchet (grandfather today's untested, block NEW). Excludes barrel
  `index.*` (override via `exclude`). Suppression-aware.

- **`forbid_path`** `{ dirs:[...], path:'<regex>' }` — flags files under `dirs` that *reference* a
  forbidden path **in code** (imports / fs reads, not comment citations). Encodes a dependency-direction
  invariant, e.g. "product (`test/`, `src/`) must not read process state (`coordination/`)". Catches the
  product-depends-on-process smell.
- **`time_bomb_tests`** `{ dirs:['test'] }` — flags tests that invoke git against a **frozen reference**
  (a pinned commit SHA, `git diff <ref>..HEAD`, `--name-only` anti-scope diffs, `git show <sha>`
  byte-identity). These can *only* rot — once HEAD moves past the round they fail regardless of product
  correctness — so the discipline belongs in a round-aware **gate** (see `anti-scope-gate.sh`), not the
  permanent suite. The signal requires *both* a git invocation and a frozen-ref marker, so a product
  SHA-256 hash test that never touches git is not falsely flagged.

## Starter tenet library

`library/tenets.json` ships the k10s **5 tenets** (T1–T5) plus **2 layering/test-rot invariants**
(L1–L2) as ready-to-enable invariants. Copy the ones you want into your `invariants.json` and tune. See
`library/README.md`.

## Engineering disciplines (the behavioral half)

The gate enforces the *structural* half of quality deterministically. The *behavioral* half — the few
disciplines that still beat a strong base model — ships as `library/disciplines.md`: **test-driven**,
**systematic debugging**, **rigorous review-receipt**, and **brainstorm-before-building**, plus the
"tests green + gate clean before done" habit. `arch init` drops it into the repo as `arch-disciplines.md`;
reference it from your `CLAUDE.md` (`@arch-disciplines.md`) so the agent applies them in-context — the
whole quality stack (mechanical floor + behavioral disciplines) with no orchestration harness.

## Test efficacy, not test count (`arch mutate`)

Requiring tests can devolve into *test theater* — more tests that don't catch more bugs (the classic "2× tests, no better results"). The count-independent answer is **mutation testing**: flip an operator (`&&`→`||`, `>=`→`>`, `true`→`false`…), re-run your suite, and see if a test *fails*. A mutant that survives is a bug your tests can't catch — a real gap that line-count and even line-coverage are blind to.

```bash
arch mutate <dir> --test "npm test" --since main      # mutate only files changed vs main (incremental)
arch mutate <dir> --test "node --test test/*.test.mjs" --all --threshold 70   # full baseline run
```

It mutates **changed source files only by default** (git diff), runs your test command per mutant, and gates on the kill rate. It is **deterministic — zero model tokens** — but heavy (mutants × suite runtime, *not* offset by having fewer tests). So it's **opt-in and out-of-band**: run it in CI / nightly / pre-merge, *not* as the per-commit gate. The cheap AST checks (complexity, `require_tests`, god-files) stay on the hot path; `mutate` is the periodic *audit* that the tests you do have are worth keeping.

**Rightsizing tests:** don't gate on count or a coverage-% target (both reward theater). The amount of testing a function needs is bounded by its cyclomatic complexity (`max_complexity` caps it → caps the tests needed); `require_tests` ensures presence; `arch mutate` confirms the tests that exist actually catch bugs. More tests is never the goal — *bug-catching* tests are.

## Honest scope

- Mechanical + deterministic (no model) → no "who-verifies-the-verifier" problem; invariants are
  human-authored (the article's Tenet 1).
- Real AST on **Go, TypeScript/JS, and Python** via ast-grep (`@ast-grep/napi` + `@ast-grep/lang-go` + `@ast-grep/lang-python`); the
  heuristic Go engine remains a no-dep fallback. More languages = a parser adapter, not new gate logic.
- Generic, no-tuning checks (work on any repo): `oversized_files` (God file), `max_function_lines`
  (God function), `module_fanin` (a module imported by too many files — the k10s "everything depends
  on the God object" coupling smell).
- Remaining (design §12): more generic metrics; richer `scope_diff`; broader real-repo trials.

## Tests

**`npm test` → 14 self-contained suites**, covering: gate+ratchet+scope, pre-commit hook, AI-loop
(converge/escalate), debt-trend, the generic God-file/God-function/fan-in checks, the custom
`ast_grep_rule` DSL, `init` scaffolding, real-AST on TypeScript / Go (incl. goroutine-mutation) /
Python, scope-dirs, and a **dogfood** suite that runs the gate on its own source (the tool has no God
files/functions/hubs by its own checks).
