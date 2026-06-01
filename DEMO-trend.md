# Debt-trend demo — anchor's own 196-commit history

The k10s thesis: architectural debt doesn't arrive at "collapse"; it accumulates commit-by-commit
while velocity hides the trend. `arch trend` walks real git history and pinpoints the exact commit
each invariant first breaches — the early warning the article's author never had.

## Reproduce

```bash
node arch.mjs trend <repo-root> packages --invariants invariants.trend.json --last 196
```

Invariants (`invariants.trend.json`): no-god-files (>500 lines), no-god-functions (>80 lines, ast-grep TS),
no-god-module (fan-in >12). All `max: 0` so first-breach fires; all `ratchet` so a gate would block each regression.

## What the trend showed (anchor `packages/`, oldest→newest, 196 commits)

| Metric | Stayed 0 until | First breach commit | Today |
|---|---|---|---|
| God functions (>80 ln) | commit ~82 | `adbb14e` "accrual dedup + raise maxTurns + CLI --resume" | 4 |
| Coupling hub (fan-in >12) | commit ~118 | `d4bec24` "per-phase wall-clock timing" | 1 |
| God files (>500 ln) | commit ~155 | `b8a7645` "anchor project — dependency-aware decomposition + parallel stages" | 2 |

The God-function count crept **0→1→2→3→4** over dozens of commits — the slow boil, never a single
bad commit. A ratchet gate would have blocked each step at introduction (the 1st God function at
`adbb14e`, not at today's count of 4).

Pointed finding: the first God *file* entered at `b8a7645` — the `anchor project` feature, which is
exactly the subsystem currently flagged as flaky/experimental. Debt and instability co-located.
