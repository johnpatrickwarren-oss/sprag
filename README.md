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

## Honest scope (P0)

- Metric extraction is lightweight text/brace parsing of Go-flavored source — reliable on the small
  sample, **not** production-grade. Production delegates to real AST/pattern engines (go/ast,
  ts-morph, semgrep, ast-grep) behind per-language adapters (see the design doc §7). This P0 proves
  the **invariant model + ratchet + gate**, not the parser.
- Mechanical + deterministic (no model) → no "who-verifies-the-verifier" problem; invariants are
  human-authored (the article's Tenet 1).
- Next (design §12): wire as a pre-commit / AI-loop feedback gate; auditable suppressions; debt-trend
  report; starter tenet library; multi-language via semgrep.
