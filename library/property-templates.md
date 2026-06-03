# Property templates — sound invariant shapes (human- or AI-authored)

A property is a behavioral invariant that must hold for **all** inputs, not one example. Properties are
the behavioral analogue of sprag's architectural invariants: a human *or an AI* authors them, and the
machine enforces them. This catalog exists so that authoring stays **sound** — you instantiate a known
good *shape* rather than inventing freeform assertions that can quietly be tautologies.

Whoever writes a property, it is only trusted once `arch property` proves it **holds on the current code
AND catches bugs** (kills mutants). That deterministic check — not faith in the author — is what makes an
**AI-authored** property safe.

```bash
arch property <dir> --prop "node prop-foo.mjs" --target <impl-dir> --min-kill 50 --all
#   ✓ ACCEPT  → holds AND kills mutants → commit it; enforced model-free from here
#   ✗ REJECT  → too weak (survived mutants) OR doesn't hold (wrong / found a real bug)
```

## The sound shapes

Pick the shape that fits the function; instantiate it against the public API.

| Shape | Holds when | Example (pseudo) |
|---|---|---|
| **Round-trip / inverse** | `decode∘encode` is identity | `decode(encode(x)) === x` |
| **Idempotence** | applying twice == once | `f(f(x)) === f(x)` (normalize, dedupe, clamp) |
| **Invariance / metamorphic** | a transform of the input relates predictably to the output | `sort(shuffle(xs))` deep-equals `sort(xs)`; `abs(-x) === abs(x)` |
| **Commutativity / order-independence** | order of operations doesn't matter | `merge(a,b)` deep-equals `merge(b,a)` |
| **Monotonicity** | order is preserved | `x <= y ⟹ f(x) <= f(y)` |
| **Conservation** | a quantity is preserved | `sum(split(xs)) === sum(xs)`; `parse(s).length` accounting |
| **Reference / oracle equivalence** | matches a trusted oracle or the *previous* version | `f(x) === slowButObviouslyCorrect(x)`; `f(x) === f_old(x)` (differential) |
| **Postcondition / output invariant** | the result always satisfies a structural rule | `isSorted(sort(xs))`; `0 <= pct(x) <= 100` |
| **Totality / no-throw** | never throws on the valid domain | `for all valid x: f(x) does not throw` |

Use a generator library (fast-check / Hypothesis / gopter) to feed many inputs; the property asserts the
relation, the library shrinks failures to a minimal counterexample.

## The correct limitations (especially for an AI author)

These are the rails that keep an authored property honest. `arch property` enforces the last two
mechanically; the first three are authoring discipline (and are why the AI is given the *spec*, not the
*code*).

1. **Black-box.** Use only the public API. Never read or assert on internals — a property coupled to the
   implementation breaks on every honest refactor and proves nothing about behavior.
2. **Spec-derived, not impl-derived.** Author from the name, signature, and spec/docstring — **blind to
   the implementation body.** A property written by reading the code can encode the *bug* (it asserts
   what the code does, not what it should do) and will pass by construction.
3. **Relations over restatement.** Prefer a relation between calls (`f(f(x))===f(x)`, `f(x)===f_old(x)`)
   over re-stating the computation — restating just re-implements the function, and re-introduces its
   bugs as the "expected" value.
4. **Must hold.** It passes on the current code. If it fails, it's wrong *or* it found a real bug — a
   human decides; you never weaken it to make it pass.
5. **Must catch bugs.** It kills mutants at or above the threshold. A property that survives every mutant
   is a tautology and is rejected — it would pass even if the code were wrong.

## The AI-authoring contract

When a human can author the invariant, great. When they can't, an AI can — *within* the rails above:

1. **Input to the model:** the function's name, signature, and spec/docstring + this catalog. **Not the
   implementation body** (rule 2).
2. **Output:** N candidate properties, each instantiating a shape above against the public API.
3. **Filter (deterministic, no model):** run every candidate through `arch property`. Keep only the ones
   that **ACCEPT** (hold + kill mutants). The model proposes; the mutation tester disposes — and you
   cannot fake killing a mutant, so a weak or tautological suggestion cannot slip through.
4. **Human review:** a person reads the accepted properties before they're committed (they're small and
   in the approved shapes, so review is cheap).
5. **Enforce:** committed properties run as ordinary tests forever after — **no model on the gate**. Guard
   the property files with a meta-ratchet so they can't be silently weakened later.

The model lowers the cost of *writing* an invariant. It never decides whether one is *valid* — that stays
deterministic, which is the whole point.
