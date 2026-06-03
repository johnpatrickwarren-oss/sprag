# DRAFT for review — the authoring loop as an operator-question PRD

*Status: design draft, not committed. The deliverable is the QUESTION SET; the loop is plumbing around
it. Decisions for you at the end.*

## The insight

Phase A's missing input was *where the impl-blind spec comes from.* A property is only trustworthy if it
derives from **intent**, not from the code (code-derived properties encode the bug). But the operator
often can't write a spec — that's why we're adding AI authoring at all.

Resolution: **don't ask the operator to write a spec — ask them good questions; their answers are the
spec.** A question-driven PRD. One artifact, three jobs:

1. **Properties become spec-derived by construction** — the PRD precedes the code, so an invariant drawn
   from it cannot encode an implementation bug. (This is "spec-before-code" done as an *artifact*, not
   inferred from git precedence.)
2. **It is the coding spec** — the same answers are an excellent starting point for the implementation.
3. **Authoring collapses to answering** — someone who can't write `∀x. f(f(x))===f(x)` *can* answer "if
   you run it twice, should anything change?" The questions do the translation to invariants.

## The loop

```
operator answers the questions ─▶ PRD / behavioral spec ─▶ AI drafts:
                                                            • candidate properties (impl-blind)
                                                            • (optionally) the implementation
                                          │
                          each property ─▶ arch property  (holds? + kills mutants?)
                                          │   ACCEPT → shortlist        REJECT → drop / flag real bug
                                          ▼
                              human reviews the small shortlist ─▶ commit ─▶ enforced MODEL-FREE forever
```

The model enters at exactly one place — drafting, behind the deterministic `arch property` filter. It
never sits on the gate.

## The question set (the product)

Plain-language, non-expert-answerable. Each answer maps to one or more sound property shapes (see
`library/property-templates.md`). The operator writes no code and no assertions.

| # | Question to the operator | Spec section | Property shape it yields |
|---|---|---|---|
| 1 | In one sentence, what is the single promise this makes to its caller? | Contract | core postcondition |
| 2 | What is explicitly NOT its job — what should it refuse or ignore? | Scope | out-of-domain → defined refusal |
| 3 | What are the valid inputs, and the range/shape of each? | Domain | input generators; **totality** (no throw on valid domain) |
| 4 | What inputs are invalid, and *exactly* what should happen for each? | Error contract | invalid input → the specified defined behavior, never an undefined crash |
| 5 | What is always true of a correct output, regardless of input? (sorted? non-null? within a range? same length?) | Postcondition | **output-invariant** |
| 6 | How does the output relate to the input — is anything preserved (count, sum, the set of elements)? | Relation | **conservation / metamorphic** |
| 7 | If you run it twice on the same input, should the second run change anything? | Relation | **idempotence** |
| 8 | Does the order of the inputs (or call order) change the result — should it? | Relation | **commutativity / order-independence** |
| 9 | If an input gets larger / there's more of it, what should happen to the output? | Relation | **monotonicity** |
| 10 | Is there an operation that should undo this and get you back to the start? | Relation | **round-trip / inverse** |
| 11 | Is there a slow-but-obviously-correct way to get the same answer? An older version? A formula? | Oracle | **reference / differential equivalence** (strongest) |
| 12 | What must NEVER happen, no matter what? (data loss, negative balance, input mutated, X leaked) | Safety | **safety invariant** (often highest-value) |
| 13 | Give 1–3 input→output pairs you're certain of. Which case worries you most? | Examples | golden seeds + a targeted property |

A blank/"n/a" answer is fine and informative — it just means that shape doesn't apply. The set is a
superset; most functions light up 4–6 of them.

## The PRD artifact (what the answers compose into)

`PURPOSE` (Q1) · `SCOPE: in / out` (Q1–2) · `INPUTS & DOMAIN` (Q3) · `ERROR CONTRACT` (Q4) ·
`POSTCONDITIONS` (Q5) · `INVARIANTS & RELATIONS` (Q6–10) · `REFERENCE ORACLE` (Q11) · `SAFETY: must-never`
(Q12) · `EXAMPLES` (Q13). This doubles as the coding spec and the provenance for every property.

## Guardrails — what the deterministic filter does and does NOT guarantee (empirically tested)

An adversarial run (bad operator answers → junk properties → `arch property`) on a real function showed
exactly where the line is:

| Junk class | Caught by `arch property`? | Why |
|---|---|---|
| **Too weak / tautological** (e.g. "returns a boolean") | **YES — REJECT** | survives every mutant (0% kill) |
| **Wrong** (asserts something false) | **YES — REJECT** | fails on the current code (doesn't hold) |
| **Impl-restating** (copies the implementation as its "expected") | **NO — ACCEPT** | kills mutants *by construction* (its copy of the logic isn't mutated), yet asserts impl===impl-copy → catches no real bug |

So the filter is robust to **weakness and wrongness regardless of operator quality** — that's the
"trust the verifier, not the author" claim, and it holds. But it does **not** enforce impl-blindness.
Therefore impl-blind authoring is **load-bearing, not a nicety**:

- **Impl-blind authoring (rule 2)** is the primary defense against the restating class — if the model
  never receives the implementation body, it *cannot* copy it. Enforce by construction in the loop:
  feed signature + spec + catalog only.
- **Relations-over-restatement (rule 3) + human review** is the backstop — a reviewer flags a property
  whose "expected" side recomputes the function instead of stating a relation/constant/oracle.
- **Possible future mechanical check** (heuristic, not in scope now): reject a property file that
  duplicates the implementation's source or imports its internals — catches the lazy restatement, not
  the clever one.
- **Every drafted property still runs `arch property`** — holds + kills mutants — and the model proposes
  but never validates. No model on the gate.

## Decisions for you

1. **Artifact format:** a committed `*.spec.md` (or `.json`) per module, living next to the code as
   durable provenance — yes? (Enables a meta-ratchet over specs, and a "spec exists for each module"
   check à la `require_tests`.)
2. **Scope of the AI's output:** properties only, or properties **and** a scaffold implementation from the
   same PRD? (The latter makes sprag a spec-first *authoring* tool, not only a gate — bigger, and a
   positioning question.)
3. **Where it runs:** a new `arch propose <fn>` that conducts the Q&A and drafts candidates, vs. a
   prompt/template the operator runs in their own agent that emits into `arch property`?
4. **Question set v1:** ship all 13, or a lean core (1, 3, 5, 11, 12) first?
5. **Does authoring belong in sprag at all,** or in anchor? (sprag = the deterministic *gate*; an
   AI-driven *authoring* tool is a different product surface, even though it feeds sprag.)
