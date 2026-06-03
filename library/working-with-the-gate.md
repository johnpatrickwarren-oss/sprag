# Working with the gate

How to *operate* sprag well. This is gate usage, not engineering methodology — sprag enforces the
**deterministic** half of quality. The **behavioral** half (the disciplines that fight a strong model's
defaults — cold-eye review, spec-first contract, …) lives in its companion, **Anchor**
(https://github.com/johnpatrickwarren-oss/anchor), whose `DISCIPLINES.md` is the pairing for this gate.

The gate-coupled habits, the ones tied to a check you can run:

- **Author the invariants first.** Decide the architectural rules — and any behavioral properties —
  *before* you build. The gate enforces them; it doesn't invent them. New rules go in
  `arch-invariants.json`; a behavioral invariant goes through `arch property` (it's accepted only if it
  holds *and* catches bugs).
- **Write the test with the code.** `require_tests` enforces the durable outcome: no module lands
  untested. `arch mutate` confirms the tests you have actually catch bugs, not just exist.
- **Run the gate before you call it done.** `sprag check <src> --invariants … --baseline-in …`, and fix
  every violation. The pre-commit hook blocks regressions — don't `--no-verify` past it. Loosen a rule
  only *on the record* (`ARCH_ALLOW_RELAX=1`, which still prints what it loosened), never silently.
