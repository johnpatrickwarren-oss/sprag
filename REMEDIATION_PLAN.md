# sprag — Code Review & Remediation Plan

**Date:** 2026-06-10
**Commit reviewed:** `24d335d` (default branch, fresh clone)
**Reviewer:** automated thorough review (all findings verified by reading the code and, where marked, by running a reproduction)

## Summary

sprag is a small, dependency-light Node CLI that enforces human-authored architectural invariants as a
ratcheted gate (heuristic + ast-grep engines), with a meta-ratchet that guards its own config and a
fail-closed engine loader. The codebase is well-commented and the test suite is healthy: **`npm test`
passes 36/36 suites** on this machine (Node 20+, `npm install` clean). The core gate (`arch-gate.mjs`),
meta-ratchet, and secret/dependency checks are solid. However, the review found one finding that
directly falsifies the project's central "fail-closed / can't die quietly" claim (the AI-loop entry
point reports success when the engine is dead), plus a correctness bug in a flagship check
(`switch_case_count` ignores its `on:` selector), scope/path bugs in `mutate`, a worktree-vs-index gap
in the pre-commit hook, an inert dogfooded supply-chain check (lockfile is gitignored), CLI
argument-parsing crashes, and several doc/code drifts. No committed secrets, no unsafe eval, and no
malicious patterns were found.

---

## Critical

### C1. `arch loop` fails OPEN on a dead engine — reports "CONVERGED", exit 0

- **File:** `arch-loop.mjs:35` (`blocked: r.status === 3`) and `arch-loop.mjs:59-62`
- **Problem:** `gate()` treats only exit code 3 as "blocked". The gate's own fail-closed path exits
  **2** when the ast-grep engine can't load (`arch-gate.mjs:214`, `ast-engine.mjs:21-32`). In the loop,
  exit 2 (and any other non-3 status: 64 usage error, an uncaught crash = exit 1) is treated as *pass*,
  so the loop prints `CONVERGED ... architecture passes the gate` and exits 0.
- **Evidence (reproduced):** copied the gate + loop to a temp dir without `node_modules`, with an
  ast-grep invariant and a violating file. Direct gate run: exit 2 with the loud fail-closed message.
  `node arch-loop.mjs code --fixer true`: `[arch-loop] CONVERGED in 0 iteration(s)`, exit 0.
- **Why it matters:** the README/THREAT-MODEL's headline claim is "it can't die quietly … a dead engine
  must be loud, not invisible." In one of the three documented enforcement integration points, a dead
  engine is a green gate.
- **Remediation:** in `gate()`, capture the status; treat `status === 0` as pass, `status === 3` as
  blocked, and anything else as a hard error that aborts the loop with a non-zero exit (propagate exit
  2 specially with the engine message). Add a fail-closed loop case to `test-arch-loop.mjs` /
  `test-arch-failclosed.mjs`.

---

## High

### H1. `arch loop` cannot use custom invariants — it silently gates the wrong ruleset

- **File:** `arch-loop.mjs:17-28` (arg parser), `arch-loop.mjs:30-36` (gate invocation); contrast
  `README.md` adopt flow (`arch init` → `arch loop <src-dir> --fixer …`).
- **Problem:** `arch-loop` accepts only `--fixer`, `--max-iters`, `--baseline-in`; `--invariants` exits
  64 ("unknown arg" — verified). `gate()` never passes `--invariants`, so the loop always gates with
  `arch-gate.mjs`'s defaults: in a dev clone that's the repo's *sample* `invariants.json`
  (Model-struct / `m.view` checks, meaningless for a user's repo → trivially green → instant
  "CONVERGED"); in a published install (where `invariants.json` is not in the `files` whitelist) it's
  `BUILTIN_DEFAULT`. The documented adopt flow — scaffold `arch-invariants.json`, then run the loop
  against it — is impossible.
- **Remediation:** add `--invariants` to `arch-loop.mjs`'s parser and forward it to the gate (and to
  the feedback report). Update `README.md`/usage strings and `test-arch-loop.mjs`.

### H2. ast-grep `switch_case_count` ignores `check.on` and counts only the *first* switch

- **File:** `ast-engine.mjs:97-101`
- **Problem:** the heuristic engine targets the declared expression (`switch m.view {`,
  `arch-gate.mjs:81-86`), but the ast-grep engine finds *all* switch statements and returns the case
  count of `sw[0]` — the first switch in the concatenated top-level source (order = `readdirSync`
  alphabetical). The `on` field in `invariants.ts.json` / `invariants.go-ast.json` is silently unused.
- **Evidence (reproduced):** a Go file with a 2-case `switch k` above a 5-case `switch m.view` returns
  **2** for `{ kind: 'switch_case_count', on: 'm.view' }` — the bounded-dispatch ratchet would never
  see the `m.view` dispatch grow (false pass), or could false-block on an unrelated switch.
- **Remediation:** filter the found switches by matching the switch subject against `check.on` (e.g.
  via pattern `switch ${on} { $$$ }` per language, or compare the condition node's text), and sum/max
  over all matching switches rather than indexing `[0]`. Add a multi-switch fixture to
  `test-arch-gate-ts.mjs` / `test-arch-gate-go-ast.mjs`.

### H3. `arch mutate` dir scoping matches by raw string prefix — sibling dirs leak in

- **File:** `mutate.mjs:66-68` (`p.startsWith(dirAbs)`)
- **Problem:** scoping an incremental run to `<repo>/src` also includes `<repo>/src-other/…`,
  `<repo>/src.bak/…`, etc., because the prefix check lacks a path-separator boundary.
- **Evidence (reproduced):** repo with `src/a.mjs` and `src-other/b.mjs`, `node mutate.mjs
  <repo>/src --since HEAD --test true` mutated both files ("across 2 file(s)", survivors listed from
  `src-other/`).
- **Remediation:** use `p === dirAbs || p.startsWith(dirAbs + '/')`.

### H4. `arch mutate` silently no-ops (exit 0) when `<dir>` contains symlinks (e.g. macOS `/tmp`)

- **File:** `mutate.mjs:31-33` (`repoRoot` from `git rev-parse --show-toplevel`, which is realpathed)
  vs `mutate.mjs:66` (`dirAbs = resolve(dir)`, which does not resolve symlinks).
- **Problem:** changed-file paths are built as `join(repoRoot, f)` (realpath, e.g. `/private/tmp/…`)
  but filtered against the un-realpathed `dirAbs` (`/tmp/…`) — zero matches, and the tool prints
  "no changed source files … nothing to mutate" and **exits 0**. In a gating context that's a silent
  pass — exactly the no-op-gate failure mode the project warns about for the `--since` git error case
  (`mutate.mjs:63-65`).
- **Evidence (reproduced):** same repo as H3: invoking with `/tmp/mut-prefix/src` → "no changed source
  files", exit 0; with `/private/tmp/mut-prefix/src` → 6 mutants found.
- **Remediation:** `realpathSync` both `dir` and `repoRoot` before comparing. Consider distinguishing
  "no changed files" (exit 0 is fine) from "dir scope matched nothing although the diff was non-empty"
  (warn loudly).

---

## Medium

### M1. Pre-commit hook gates the working tree, not the index — stage-then-revert lands rot

- **File:** `install-hook.sh:44-46` (generated hook runs the gate on `"$repo/$d"`).
- **Problem:** the hook checks the *working tree*. (a) False negative: stage a violating file, revert
  the working copy → hook passes, the rot is committed. This is the exact "stage-a-relaxation-then-
  revert" trick the meta-ratchet closes for *config* (`from: "index"`, `meta-ratchet.mjs:68-71`) but
  the hook leaves open for *code*. (b) False positive: clean staged content + dirty working tree
  blocks a clean commit. THREAT-MODEL.md's "Honest limits" covers `--no-verify` and history rewrite
  but not this.
- **Remediation:** in the generated hook, materialize the index with
  `git checkout-index -a --prefix="$tmp/staged/"` (mirroring the HEAD `git archive` extraction) and
  gate that tree instead of `$repo/$d`. Extend `test-precommit.mjs` with a stage-then-revert case.

### M2. `package-lock.json` is gitignored — the dogfooded supply-chain check is inert and CI is non-reproducible

- **Files:** `.gitignore:3`; `invariants.harness.json` (`no-unlocked-deps`); `metrics.mjs:373`
  (`if (!existsSync(manifest) || !existsSync(lockPath)) return 0;`); `.github/workflows/ci.yml`,
  `mutate.yml`, `publish.yml` (`npm ci || npm install`).
- **Problem:** (a) `unlocked_dependencies` is documented as inert without a lockfile — since the repo
  ignores its own lockfile, the dogfooded S2 ("no hallucinated deps") invariant always scores 0 and
  verifies nothing, while README claims "sprag enforces all of the above on itself". (b) `npm ci`
  *always* fails without a lockfile, so every workflow silently falls back to `npm install` —
  unpinned, non-reproducible CI and publish builds, at odds with the project's supply-chain stance
  (and with npm provenance attestation in `publish.yml`).
- **Remediation:** commit `package-lock.json`, remove it from `.gitignore`, drop the
  `|| npm install` fallback in all three workflows. Optionally make `unlocked_dependencies` warn when
  the manifest exists but the lockfile doesn't (it currently abstains silently except for the
  unparseable case).

### M3. Positional-argument parsing breaks when options precede the directory (`init`, `mutate`, `property`)

- **Files:** `arch.mjs:31` (`init`), `mutate.mjs:24`, `property.mjs:27` — all use
  `argv.find((a) => !a.startsWith('--'))`.
- **Problem:** the first non-`--` token may be an option *value*. `arch init --lang ts <dir>` takes
  `ts` as the directory and crashes (`ENOENT … open 'ts/arch-invariants.json'` — reproduced).
  `node mutate.mjs --since main <dir>` would take `main` as the dir; `property.mjs` likewise.
- **Remediation:** parse argv positionally, skipping each known flag *and its value* (the
  `parseArgs`-style loop already used in `arch-gate.mjs:153-166` does this correctly — reuse it).

### M4. `severity` is never enforced by the gate — `warn` blocks identically to `block`

- **Files:** `arch-gate.mjs:168-184` (`computeViolations` ignores `inv.severity`; every violation sets
  exit 3 via `arch-gate.mjs:229`); contrast `meta-ratchet.mjs:51-53` and THREAT-MODEL.md's bypass
  table, which treat a `block → warn` downgrade as a meaningful weakening.
- **Problem:** the field is decorative. Today this errs strict (a `warn` invariant still blocks), but
  it's an internal inconsistency: the meta-ratchet defends against a downgrade that wouldn't actually
  change gate behavior, and a user authoring `severity: "warn"` gets blocking behavior they didn't ask
  for.
- **Remediation:** either implement `warn` (report the violation, exclude it from the blocking
  decision: `blocked = violations.some(v => v.severity !== 'warn')`) — the meta-ratchet already
  prevents abusive downgrades — or remove the field from scaffolds/docs and document that everything
  blocks.

---

## Low

### L1. Off-by-one in file line counting — a file with exactly `maxLines` lines is flagged

- **Files:** `metrics.mjs:79` (`readFileSync(p,'utf8').split('\n').length > maxLines`), same idiom in
  `scan.mjs:57`.
- **Evidence (reproduced):** a 10-line newline-terminated file with `maxLines: 10` →
  `oversizedFilesCount` returns 1. `split('\n')` counts the trailing newline as an extra line.
- **Remediation:** count lines as `src.split('\n').length - (src.endsWith('\n') ? 1 : 0)` (ratchet
  baselines self-correct since both sides use the same counter).

### L2. Stale docs: suite count, extraction notes, library README

- **Files:** `README.md` ("Tests" section: "**`npm test` → 14 self-contained suites**" — there are
  **36**, all passing); `EXTRACTING.md` ("14/14 suites"); `library/README.md` (table lists 9
  invariants while `library/tenets.json` ships 18, including S1/S2, TS1–TS3, SEC1, M1 that the root
  README advertises).
- **Remediation:** update the three docs (or make the README count non-literal).

### L3. `arch trend` builds a `bash -c` string from CLI args and ignores extraction failures

- **File:** `arch-trend.mjs:42` — `` spawnSync('bash', ['-c', `git -C "${repo}" archive ${sha} | tar -x -C "${tmp}"`]) ``.
- **Problem:** `repo` is interpolated into a shell string (quote-injection if the path contains `"`,
  backticks, `$(`…); the command's exit status is never checked, so a failed archive yields an empty
  tree and silently-zero metrics for that commit row.
- **Remediation:** use two `spawnSync` calls with arg arrays (`git archive` piped to `tar` via
  `input:`), and check `status` on both.

### L4. `detectLang` can't detect Python (or anything but go/ts/js)

- **File:** `arch.mjs:21-27` (`ext` map has no `.py`); `arch.mjs:32` usage `--lang go|ts|js`.
- **Problem:** README advertises real-AST Python support, but `arch init` on a pure-Python repo
  detects `go` (all counts 0, first key wins) and scaffolds Go-flavored invariants.
- **Remediation:** add `.py → py` to the map (and `py` to `astLangs`/usage), or print the detection
  result with a hint when nothing matched.

### L5. Published package's `npm test` is broken (`run-tests.mjs` not shipped)

- **File:** `package.json:24-43` (`files` whitelist omits `run-tests.mjs` and all `test-*.mjs`) vs
  `package.json:61` (`"test": "node run-tests.mjs"`).
- **Problem:** inside an installed copy, `npm test` fails with MODULE_NOT_FOUND. Harmless for
  consumers but confusing; also `npm run mutate` in the published package references the same file via
  `--test "node run-tests.mjs"`.
- **Remediation:** either ship `run-tests.mjs` + tests, or change the published scripts to a no-op
  with a pointer to the repo.

### L6. `mutate --threshold <garbage>` silently disables the gate

- **File:** `mutate.mjs:29` (`parseFloat`), `mutate.mjs:145` (`score < threshold` is false for NaN).
- **Remediation:** validate with `Number.isFinite(threshold)` and exit 64 otherwise.

### L7. `time_bomb_tests` only sees JS-family test files

- **File:** `metrics.mjs:168` (`TEST_EXTS` lacks `_test.go`, `test_*.py`), though `require_tests`
  recognizes those conventions (`metrics.mjs:203-210`) and the README presents the check as generic.
- **Remediation:** extend `TEST_EXTS`/detection to the Go/Python test-name conventions or scope the
  README claim.

---

## Prioritized remediation checklist

- [x] **C1** — `arch-loop.mjs`: treat any gate exit other than 0/3 as a hard error (fail closed); add a dead-engine loop test.
- [x] **H1** — `arch-loop.mjs`: support `--invariants` (and forward it); fix README loop examples; cover in `test-arch-loop.mjs`.
- [x] **H2** — `ast-engine.mjs`: make `switch_case_count` honor `check.on` and stop indexing `sw[0]`; add multi-switch fixtures.
- [x] **H3** — `mutate.mjs`: dir scope must match on a path-separator boundary (`dirAbs + '/'`).
- [x] **H4** — `mutate.mjs`: realpath `dir`/`repoRoot` before comparison; warn when scope filters out a non-empty diff.
- [x] **M1** — `install-hook.sh`: gate the staged index (`git checkout-index --prefix`) instead of the working tree; add stage-then-revert test.
- [x] **M2** — commit `package-lock.json`, un-ignore it, drop `|| npm install` from the three workflows (makes the dogfooded `no-unlocked-deps` check real).
- [x] **M3** — fix positional-arg parsing in `arch.mjs init`, `mutate.mjs`, `property.mjs` (skip flag values).
- [x] **M4** — implement or remove `severity: "warn"` semantics; align THREAT-MODEL/README wording. [implemented: warn reports without blocking]
- [ ] **L1** — fix trailing-newline off-by-one in line counting (`metrics.mjs`, `scan.mjs`).
- [ ] **L2** — update suite counts in `README.md`/`EXTRACTING.md`; refresh `library/README.md` table.
- [ ] **L3** — `arch-trend.mjs`: no shell-string interpolation; check archive/tar exit status.
- [ ] **L4** — `detectLang`: add Python; extend `arch init --lang`.
- [ ] **L5** — ship `run-tests.mjs` (or adjust published `scripts`).
- [ ] **L6** — validate `--threshold` in `mutate.mjs`.
- [ ] **L7** — extend `time_bomb_tests` to Go/Python test-file conventions (or document the limit).

## Test-suite results

`npm install` (Node 20+) then `npm test` at `24d335d`: **36/36 suites passed** (one suite,
`test-arch-real-repos.mjs`, self-skips without `ANCHOR_CORPUS_DIR`). All findings above were confirmed
against the passing suite — they live in paths the suite doesn't exercise (loop fail-open, `on:`
selector, mutate scoping, hook index gap, option-order parsing).
