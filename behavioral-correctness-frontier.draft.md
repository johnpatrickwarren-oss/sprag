# DRAFT for review — the behavioral-correctness frontier

*Status: scoping doc, not committed. Decision points at the end. Nothing built yet.*

## Where we are

sprag's deterministic floor is complete. Every check answers some version of **"is the code
well-*formed*?"** — structure (god-objects, complexity, coupling), supply chain (dep surface, phantom
deps), types (`any`, `!`, `@ts-ignore`), secrets, test *discipline* (`require_tests` + `mutate`), and the
gate's own integrity (fail-closed + meta-ratchet).

None of them answer **"does the code do the *right thing*?"** — behavioral correctness. That's the last
frontier, and it is categorically different from everything we've built.

## Why it's been deferred: the oracle problem

sprag's entire edge is *no model, no "who-verifies-the-verifier."* Behavioral correctness needs an
**oracle** — something that declares what "correct" is. The oracle can be:

1. a human-written spec or example test,
2. a **property** (an invariant over all inputs),
3. a **reference implementation** (the old code, a golden snapshot),
4. or a **model**.

The moment the oracle is a model, we're back in the regime sprag was built to escape — *capped by oracle
quality* — which sprag's own history already hit (the ADR pivot away from behavioral oracles; generated
oracles that false-positive and false-negative). So the governing principle has to be:

> Push as far as possible with **human-authored or differential** oracles before touching a model
> oracle. If a model oracle is ever used, its output is a *candidate for judgment*, never a verdict —
> exactly how the structural checks already behave.

## The deterministic-first ladder

Ordered cheapest / most philosophy-aligned → most expensive / model-dependent. Each rung is a possible
build; we don't have to climb past where it pays.

- **Rung 0 — shipped.** `require_tests` (tests exist) + `mutate` (tests actually catch injected bugs).
  The deterministic *shadow* of behavior. Gap: it never checks the tests encode the right **intent**.

- **Rung 1 — Property-based invariants, authored by human OR AI, accepted deterministically. (BUILT:
  the acceptance gate + catalog.)** A property is a behavioral invariant over *all* inputs. The
  refinement (John): don't assume the human can author it — provide a framework where an **AI authors the
  invariant within correct limitations**, but the model is an *authoring assistant only*, **never the
  gate-time oracle**. The resolution to "who-verifies-the-verifier": a proposed property is trusted only
  if it (1) **holds** on the current code and (2) **catches bugs** — proven by `arch mutate`. You can't
  fake killing a mutant, so a deterministic verifier (not the model) accepts/rejects. Once accepted, the
  property is committed and enforced model-free forever.
  - **The "correct limitations":** black-box (public API only); spec-derived, **impl-blind** (so the
    property can't encode the bug); relations over restatement; must-hold; must-kill-mutants. The last
    two are enforced mechanically by `arch property`; see `library/property-templates.md`.
  - **Shipped:** `arch property` (property.mjs — holds + mutation-kill = ACCEPT/REJECT, reusing
    mutate.mjs) + the sound-shape catalog + AI-authoring contract.
  - **Not yet built:** the AI-authoring loop itself (Phase A — feed signature+spec+catalog to a model,
    emit candidates into `arch property`), and a ratcheted per-suite "properties still kill bugs" gate.

- **Rung 2 — Differential / golden / characterization testing.** Pin behavior against a reference: the
  *previous implementation* (catches "the AI refactor silently changed behavior" — a top real failure)
  or *approved golden outputs*. Deterministic; the oracle is "the old behavior" or "the signed
  snapshot," not a model. Check kind runs a differential harness and ratchets divergences. **Strong
  second rung; best coverage of the AI-rewrites-and-drifts case.**

- **Rung 3 — Metamorphic testing.** Where there's no full oracle, encode relations that must hold
  (`f(2x) == 2·f(x)`; results stable under input reordering). Human-authored relations, deterministic.
  Useful for data/ML code where ground truth is unknown.

- **Rung 4 — Spec-precedence (process-as-check).** Enforce that an acceptance test for a behavior
  *existed / was human-approved before* the implementation — via git-history precedence or a signed-spec
  manifest. Mechanically checkable; directly attacks the "AI authored both the code AND its blessing
  test in one breath" circularity. Cheap spike, novel, fits the meta-ratchet family.

- **Rung 5 — Model oracle (where tokens finally get spent).** Only for the residue rungs 1–4 can't
  reach: LLM-as-judge for spec conformance ("does this diff satisfy this English acceptance criterion?").
  Must be (a) used only *after* the deterministic rungs, (b) a candidate-for-judgment, not a verdict,
  (c) adversarial / multi-vote to manage the oracle-quality ceiling, (d) out-of-band (expensive), never
  per-commit.

## Recommendation

Build **Rung 1 (property-based gate)** and **Rung 2 (differential/golden gate)** first — deterministic,
human-authored, philosophy-pure, and between them they cover the two highest-value behavioral failures
of AI code: unconstrained logic, and silent refactor drift. **Rung 4 (spec-precedence)** is a cheap,
novel spike worth doing alongside. **Defer Rung 5** unless a concrete need survives 1–4.

## The strategic question (this is the real decision)

This session *sharpened* sprag's identity: the deterministic, model-free, **gate-the-gate** tool. Adding
behavioral correctness risks blurring exactly the edge we just honed — **especially Rung 5**, whose model
oracle reintroduces the "who-verifies-the-verifier" problem sprag's whole pitch disavows.

My recommendation: keep behavioral checks in sprag **only in their deterministic forms** (Rungs 1–4 —
they're still "human authors the invariant, machine enforces it, no model"). Put the model-oracle tier
(Rung 5) in the **anchor / architectural-oracle line of work**, not sprag. That grows sprag's coverage
without diluting "deterministic and unweakenable."

## Decision points for you

1. **Charter:** is behavioral correctness in sprag's scope at all, or a sibling tool? (Crisp positioning
   vs. broader coverage.)
2. **If in scope:** Rung 1 (property-based) or Rung 2 (differential/golden) first?
3. **Model oracle (Rung 5):** in sprag, in anchor, or nowhere for now? (I lean: not in sprag.)
4. **Integration shape:** new ratcheting check kinds that shell out to a test command (keeps the
   metric→ratchet model) vs. a separate `arch behavior` subcommand?
5. **Language scope:** property/differential harnesses are per-ecosystem (fast-check JS, Hypothesis Py).
   Start JS-only, or design the adapter seam up front?
