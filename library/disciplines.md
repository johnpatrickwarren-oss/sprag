# Engineering disciplines (paired with the architectural gate)

Apply these on every change. They're the cheap, high-leverage *behavioral* half of code quality; the
architectural gate (arch-gate) enforces the *structural* half deterministically. Run the gate before
you call work done. (These four are the disciplines that still beat a strong base model — planning,
worktrees, and parallel-agent orchestration are now handled natively, so they're intentionally omitted.)

## 1. Test-driven — write the test first
Before implementing a feature or fixing a bug, write a *failing* test that captures the intended
behavior, then implement until it passes. New code ships with a test (the `require_tests` gate enforces
the durable outcome: no untested module lands).

## 2. Systematic debugging — root-cause before patch
On any bug, test failure, or surprise: reproduce it, form a hypothesis, find the **root** cause, *then*
fix. Don't patch symptoms or guess-and-check. Add a regression test for the cause you found.

## 3. Receive review with rigor — verify, don't perform
When given feedback (human or tool): verify each point technically before acting. Push back on what's
wrong, unclear, or unjustified — don't implement suggestions you can't defend. Agreement is earned.

## 4. Brainstorm before building — intent before code
For any new feature/component/behavior change, first explore intent, requirements, and design options
*with the human*. Don't jump to implementation on ambiguous or greenfield work. (This is also where you
author or update the architectural invariants the gate will enforce.)

## Before you call it done
- **Tests green, with evidence** — run the suite and show the result; never assert "passing" without it.
- **Gate clean** — run `arch-gate check <src> --invariants arch-invariants.json --baseline-in <baseline>`
  and fix every violation. The pre-commit hook blocks architecture-violating commits; don't `--no-verify`.
- **Report faithfully** — state what was done and verified; if a step was skipped or a test failed, say so.
