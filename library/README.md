# Starter tenet library

The 5 tenets from the k10s post ("I'm Going Back to Writing Code by Hand") as ready-to-enable
architectural invariants. `tenets.json` is the catalog; copy the entries you want into your
project's `invariants.json` and **tune** them (the human still owns the architecture — the gate only
enforces it).

| Tenet | Invariant | Check | Status |
|---|---|---|---|
| T1 — thin coordinator (no God Object) | `model-not-god-object` | `struct_field_count` (ratchet) | **ready** |
| T2 — per-view isolation (no central dispatch growth) | `bounded-dispatch` | `switch_case_count` (ratchet) | **ready** |
| T4 — typed records (no positional arrays) | `no-positional-rows` | `magic_index_count` | **ready** |
| T5 — mutations on the main loop (no async-callback writes) | `no-async-mutation` | `forbid_pattern` | **ready** |
| T3 — explicit scope boundary (no scope creep) | `scope-boundary` | `scope_diff` | **ready** |

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
