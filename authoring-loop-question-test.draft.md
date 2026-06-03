# DRAFT — question-set field test on three real sprag functions

*Testing whether the 13-question PRD actually elicits good properties, and which questions earn their
place. Operator answers are written as a real (non-expert) operator would; properties are what an AI
would draft from those answers; every property would still pass through `arch property`.*

Legend per question: **GOLD** (yielded a strong property) · **ok** (useful) · **blank** (n/a here).

---

## Function A — `norm(s)` (golden.mjs): a pure string normalizer
`s.replace(/\r\n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\s+$/,'')` — CRLF→LF, strip trailing
spaces/tabs per line, strip trailing whitespace at end.

| Q | Operator's answer | Property drafted | Verdict |
|---|---|---|---|
| 1 Contract | "Clean up whitespace so two texts that only differ in line-endings/trailing spaces compare equal." | output compares equal for inputs differing only in CRLF/trailing ws | GOLD |
| 2 Not its job | "Don't touch interior spacing or indentation." | `norm(x)` preserves all non-trailing interior characters | ok |
| 3 Domain | "Any string, any length, any bytes." | generator: arbitrary strings incl. `\r\n`, tabs, unicode | ok (needed) |
| 4 Invalid input | "There isn't one — every string is valid." | **totality**: never throws on any string | ok |
| 5 Output postcondition | "Result has no `\r`, and no line ends in a space/tab, and no trailing whitespace." | `!/\r/.test(out) && !/[ \t]\n/.test(out) && out===out.replace(/\s+$/,'')` | GOLD |
| 6 Conservation | "Same visible content and order, just tidied." | stripping all whitespace from `norm(x)` === stripping all whitespace from `x` | GOLD |
| 7 Twice? | "Running it again does nothing." | **idempotence**: `norm(norm(x)) === norm(x)` | GOLD |
| 8 Order? | — single argument | — | blank |
| 9 Grows? | "Longer input → no specific rule." | — | blank |
| 10 Inverse? | "No — it loses information." | — | blank |
| 11 Oracle? | "A reference normalizer (split lines, trimEnd each, rejoin, trimEnd)." | `norm(x) === referenceNorm(x)` over random inputs | GOLD |
| 12 Must never | "Must never *add* characters or change a non-whitespace char." | `out.length <= in.length` and non-ws projection unchanged | GOLD |
| 13 Examples | `"a \r\nb \n" → "a\nb"`; worry: a string that's all whitespace → `""` | seeded cases + targeted all-whitespace property | GOLD |

**Lit up:** 1,5,6,7,11,12,13 strongly. Idempotence (7) and the must-never (12) are the standouts an
operator can answer without knowing what a property *is*.

---

## Function B — `globRe(g)` (mutate.mjs): a glob → anchored RegExp compiler
`*`→`[^/]*`, `**`→`.*`, every other char escaped, wrapped `^…$`.

| Q | Operator's answer | Property drafted | Verdict |
|---|---|---|---|
| 1 Contract | "Turn a path glob into a regex that matches the same paths." | (anchors everything below) | GOLD |
| 2 Not its job | "Doesn't validate that the glob is sensible; `***` is just allowed." | — (informs domain) | ok |
| 3 Domain | "Any string used as a glob." | generator: globs over `[a-z/*._-]` | ok (needed) |
| 4 Invalid input | "None rejected — even regex-special chars are escaped, not errored." | **totality**: `globRe(x)` never throws (always a valid RegExp) | GOLD |
| 5 Output postcondition | "Always a RegExp, anchored start-to-end." | result is a RegExp whose source starts `^` ends `$` | ok |
| 6 Conservation | "Each glob token becomes exactly one regex piece." | — (hard to state cleanly) | blank |
| 7 Twice? | — wrong type (string→RegExp), can't re-apply | — | blank |
| 8 Order? | — single argument | — | blank |
| 9 Grows? | — | — | blank |
| 10 Inverse? | "Not really." | — | blank |
| 11 Oracle? | "Yes — a reference glob matcher (or minimatch) should agree on which paths match." | for random glob+path pairs, `globRe(glob).test(path) === referenceGlobMatch(glob, path)` | GOLD |
| 12 Must never | "A single `*` must NEVER match across a `/`; a literal `.` must NEVER act as regex-any." | `globRe('a*b').test('a/b') === false`; `globRe('a.b').test('axb') === false` | GOLD |
| 13 Examples | `'*.mjs'` matches `'x.mjs'` not `'a/x.mjs'`; worry: `**` vs `*` boundary | seeded + the `**`/`*` distinction property | GOLD |

**Lit up:** 1,4,11,12,13. The **oracle (11)** is the single strongest property here and the operator
*had* a reference in mind once prompted. Idempotence/order/inverse/grows were all blank — and rightly so.

---

## Function C — `configRelaxations(dir, check)` (meta-ratchet.mjs): a relational diff op
Returns `{count, reasons[]}` — how many ways the current config/baseline is *weaker* than a git ref.

| Q | Operator's answer | Property drafted | Verdict |
|---|---|---|---|
| 1 Contract | "Count the ways the config got looser vs the reference; 0 if it only got stricter or stayed equal." | (anchors below) | GOLD |
| 2 Not its job | "Doesn't look at the *code*, only the config/baseline files." | — (scope) | ok |
| 3 Domain | "A repo dir + a check pointing at two JSON files." | generator: pairs of (old, new) invariant/baseline JSON | ok (needed) |
| 4 Invalid input | "Missing files / unparseable JSON → treat as nothing to compare, don't crash." | **totality**: never throws; missing/garbage ref → count 0 | GOLD |
| 5 Output postcondition | "`count` always equals `reasons.length`, always ≥ 0." | `out.count === out.reasons.length && out.count >= 0` | GOLD |
| 6 Conservation | "Every counted relaxation has a reason." | (same as 5) | ok (dup of 5) |
| 7 Twice? | — not that kind of function | — | blank |
| 8 Order? | "Order of rules in the file shouldn't change the count." | permuting the invariants array leaves `count` unchanged | ok |
| 9 Grows? | "A *stricter* change should never increase the count." | **monotonicity/safety**: tightening any threshold → count does not rise | GOLD |
| 10 Inverse? | — | — | blank |
| 11 Oracle? | "For tiny configs, a hand-written checker should agree." | `count === referenceCount(old,new)` on small fixtures | ok |
| 12 Must never | "A forward-only change must NEVER be flagged; a real relaxation must NEVER be missed." | `relax(old→stricter) ⟹ count===0`; `relax(old→looser) ⟹ count>=1` | GOLD |
| 13 Examples | raise max 20→50 → count 1; lower 20→10 → count 0; worry: a change that's both | seeded + the both-directions property | GOLD |

**Lit up:** 1,4,5,9,12,13. The **must-never (12)** *is* the meta-ratchet's whole contract — the
questionnaire reconstructed the spec we built by hand. Idempotence/inverse blank; order (8) was a real
but minor property.

---

## Verdict: which questions earned their place

Across N=norm, G=globRe, C=config:

| Q | N | G | C | Verdict |
|---|---|---|---|---|
| 1 Contract | ● | ● | ● | **CORE — universal anchor** |
| 3 Domain | ● | ● | ● | **CORE — needed for generators** |
| 5 Postcondition | ● | ○ | ● | **CORE — high value, universal** |
| 12 Must-never | ● | ● | ● | **CORE — surfaced the *single best* property every time, and the easiest for a non-expert to answer** |
| 13 Examples/worry | ● | ● | ● | **CORE — seeds + targets, universal** |
| 4 Invalid input | ○ | ● | ● | KEEP — yields totality/error contract; merge with domain (3) |
| 11 Oracle | ● | ● | ○ | KEEP — strongest property *when a reference exists*; must prompt with examples or operators forget it |
| 7 Idempotence | ● | – | – | KEEP but fold into a relations cluster |
| 9 Monotonicity | – | – | ● | KEEP but fold into a relations cluster |
| 6 Conservation | ● | – | dup | fold into cluster / overlaps 5 |
| 8 Commutativity | – | – | ○ | **WEAK — fold into cluster** |
| 10 Inverse/round-trip | – | – | – | **WEAK — fold into cluster (never stood alone here)** |
| 2 Not-its-job | ○ | ○ | ○ | **MERGE into domain (3) — only ever produced scope notes** |

### Findings
1. **Five questions are universal** (1, 3, 5, 12, 13) — they fired on all three, across totally
   different shapes. That's the lean core.
2. **"Must never" (Q12) is the MVP.** It surfaced the highest-value property for every function *and*
   it's the one an operator answers best — people know what would be a disaster even when they can't
   state an algebraic law. It probably deserves to be asked **first**, not twelfth.
3. **The algebraic questions (6–10) mostly came up blank individually** but occasionally struck gold
   (norm's idempotence, config's monotonicity). They don't justify 5 separate prompts. **Collapse them
   into ONE clustered question** with sub-bullets; the answer self-selects the shape.
4. **The oracle (Q11) is the strongest property when it applies**, but operators don't volunteer a
   reference unless prompted with an example. Keep it, and prompt it hard.
5. **Q2 never produced a property** — only scope notes. Merge into the domain question.

### Proposed v1 — 7 questions (from 13)
1. **Contract** — one sentence: the promise to the caller. *(Q1)*
2. **Must-never** — what must never happen, no matter the input? *(Q12 — moved up, it's the best)*
3. **Domain & refusal** — valid inputs + their ranges; invalid inputs + exactly what should happen.
   *(Q3+Q4+Q2)*
4. **Output is always…** — what's true of every correct output? *(Q5)*
5. **Relations** *(clustered — answer any that apply)* — run it twice: changes anything? · input order
   matter? · input grows: output does what? · an inverse that gets you back? · anything preserved
   (count/sum/elements)? *(Q6–Q10)*
6. **Reference** — a slow-but-obviously-correct way, an older version, or a formula that should agree?
   *(Q11, prompted with an example)*
7. **Examples & worry** — 1–3 certain input→output pairs; the case you worry about most. *(Q13)*

Net: the questionnaire *works* — on three unrelated real functions it reconstructed strong, testable
invariants (including, for the meta-ratchet, the exact contract we'd hand-built). The win is cutting 13
loosely-overlapping prompts to **7 tight ones**, led by "must never."
