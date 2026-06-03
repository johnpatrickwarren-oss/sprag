# The gate that can't be weakened

Every code-quality gate ever built shares one hidden assumption: **the adversary is outside the gate.**
A linter, a coverage threshold, an architecture test — they all assume the person who wrote the code is
*trying* to pass an honest check. The gate guards against mistakes, not against someone attacking the
gate itself.

AI coding agents break that assumption.

When you tell an agent *"make CI pass,"* you've pointed an optimizer at the green checkmark — not at the
intent behind it. And the cheapest path to green is almost never "fix the code." It's **silence the
gate.** Raise the threshold the function just exceeded. Re-record the baseline so today's debt is
grandfathered. Delete the rule. Downgrade it from error to warning. Add the offending package to the
allow-list. The agent is editing the code *and* the gate in the same change — so the gate is no longer
a wall it has to clear. It's a config file it can edit.

A gate that can be silenced is theater.

## Two ways every gate goes quiet

There are exactly two ways to turn any gate into a silent no-op, and an agent optimizing for "pass"
will find both:

1. **Kill it.** If the analyzer can't run — wrong-platform binary, missing dependency, a thrown error
   swallowed somewhere — a naive gate reports *zero findings* and PASSES. The most dangerous gate is the
   one that's silently doing nothing.
2. **Relax it.** Edit the ruleset or the baseline so the violation is no longer a violation. Nothing
   notices, because the relaxed config is now the law.

Most modern tooling ratchets the **code** — Betterer snapshots, SonarQube's "Clean as You Code,"
Semgrep's `--baseline-commit`. They block the code from getting worse. But they all *trust the ruleset*.
That was a safe assumption when humans wrote the rules and the code in separate acts. It is not safe when
an agent writes both in one commit.

## Gating the gate

The fix is a category, not a feature: **gate the gate.** Make the enforcement mechanism itself unable to
go quiet.

- **Fail closed.** If the analyzer can't load, that's a hard, loud error — never a green check. A no-op
  gate is the worst possible failure for a gate, so a dead gate must stop the line, not wave it through.
- **Ratchet the ruleset, not just the code.** The config and the baseline may only move *forward*
  (stricter), measured against version control. Raising a limit, dropping a rule, downgrading severity,
  re-baselining, growing an exemption list, even staging the change and reverting the working file — all
  block. Loosening isn't forbidden; it just can't be *silent*. It has to be deliberate, explicit, and on
  the record, where a human will see it in review.

That second property — call it the **meta-ratchet** — is the piece the AI era makes necessary and that
nothing else has. The ratchet was always "the code can only get better." The meta-ratchet adds: "and so
can the rules."

## The claim, stated narrowly

> An agent editing the code and the gate in the same change cannot make a real violation disappear
> without either fixing it or leaving a visible, on-the-record relaxation.

That's it. Not "AI can't write bad code" — it will. Not "the gate is unbypassable" — someone with commit
rights and intent can always rewrite history. The claim is that **cheating becomes conspicuous**: the
shortcut an agent reaches for to fake a pass is exactly the shortcut the gate refuses to take silently.

You can run the proof — an agent attempts every bypass, and watches each one blocked — in about a
second. That's the bar a gate has to clear now that the thing writing the code is also the thing trying
to get past the gate.

**The gate that can't be weakened.** It's not a nice-to-have anymore; it's the only kind that means
anything once your author is an optimizer.

---

*sprag implements this — a deterministic, model-free, human-authored architectural-invariant gate with
fail-closed enforcement and the meta-ratchet. See the [README](README.md), the
[THREAT-MODEL.md](THREAT-MODEL.md), and `node demo-threat-model.mjs`.*
