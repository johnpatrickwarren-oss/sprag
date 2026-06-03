# Starter tenet library

Ready-to-enable architectural invariants: the **5 structural tenets** from the k10s post ("I'm Going
Back to Writing Code by Hand"), **2 layering/test-rot invariants** (L1–L2), **1 discipline-derived
check** (D1), and **1 quality-metric check** (Q1) — learned from adopting this gate on real repos + the
behavioral disciplines it pairs with (those live in [Anchor](https://github.com/johnpatrickwarren-oss/anchor),
not here). `tenets.json` is the catalog; copy the entries you want into your
project's `invariants.json` and **tune** them (the human still owns the architecture — the gate only enforces it).

| Tenet | Invariant | Check | Status |
|---|---|---|---|
| T1 — thin coordinator (no God Object) | `model-not-god-object` | `struct_field_count` (ratchet) | **ready** |
| T2 — per-view isolation (no central dispatch growth) | `bounded-dispatch` | `switch_case_count` (ratchet) | **ready** |
| T4 — typed records (no positional arrays) | `no-positional-rows` | `magic_index_count` | **ready** |
| T5 — mutations on the main loop (no async-callback writes) | `no-async-mutation` | `forbid_pattern` | **ready** |
| T3 — explicit scope boundary (no scope creep) | `scope-boundary` | `scope_diff` | **ready** |
| L1 — layering: product mustn't depend on process/working-state | `product-not-read-process` | `forbid_path` | **ready** |
| L2 — no time-bomb tests (tests that can only rot) | `no-time-bomb-tests` | `time_bomb_tests` | **ready** |
| D1 — test coverage floor (the TDD shadow) | `require-tests` | `require_tests` | **ready** |
| Q1 — bounded function complexity (principled god-function) | `no-complex-functions` | `max_complexity` | **ready** |

T1–T5 catch **structural** decay (size, coupling, dispatch, mutation, scope). L1–L2 catch
**layering / dependency-direction** decay; D1 catches **missing test coverage**; Q1 catches **over-complex
functions** — classes the size/coupling metrics are blind to:
- **L1** is *per-project* — only forbid a path that is genuinely a different layer (on the orchestrator
  repo that owns `coordination/`, you would NOT adopt it). Authored to each repo's architecture.
- **L2** is *universal* — no product should pin a test to a frozen git ref; round-scoped checks belong
  in a gate, not the permanent suite. Usually adopt as-is.
- **D1** is the deterministic half of test-driven-development (the behavioral half lives in Anchor) —
  ratchet it so legacy untested code is grandfathered and only NEW modules need a test.
- **Q1** is the *less-arbitrary* god-function check — cyclomatic complexity (branchiness) instead of raw
  line count, so a long-but-flat function passes and a short-but-branchy one is flagged. Same zero-token
  cost. Prefer it over (or run it alongside) a `max_function_lines` rule.

**ready** = implemented check kind (works today on Go via the heuristic engine and TypeScript via the
ast-grep AST engine). **planned** = the check kind is on the roadmap (design §4); the template shows
the intended shape so you can approximate it with a semgrep/ast-grep rule meanwhile.

## Adopt

```bash
# 1. copy the 'ready' tenet entries into invariants.json (or invariants.ts.json), tune thresholds.
# 2. record a baseline from your current (accepted) state:
node ../arch-gate.mjs <your-src> --baseline
# 3. gate it: pre-commit hook (../install-hook.sh) and/or the AI-loop (../arch-loop.mjs).
```

The ratchet means you don't need perfect thresholds up front — start from where you are and refuse
to get worse.
