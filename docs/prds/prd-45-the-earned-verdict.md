# prd-45 — the earned verdict: a check that could not run says so

> **Status:** **BLESSED** — operator (gabriel-canaan), 2026-08-24, in session. Drafted the
> same day from the prd-39 verify pass (findings on #1, PR #40, merged `51e971c`) and from
> prd-24's closing amendment, which retired to `done/` with two residuals "described for the
> next groom" and no owner. Milestone `prd45`. Sequencing amended at the same session's
> grooming — see the closing amendment.

## Problem

prd-39 made two of `scripts/gate.sh`'s checks honour themselves, and its Success criterion 2 —
*"a guard cannot report success when it could not run"* — is still **unmet**, because the
criterion is broader than the ruling that served it. Ruling 2 named the NUL guard's two
remedies; both shipped. The same defect shape survives in seven other places in the same file,
and the file is the landing tool: it merges to local `main` and pushes to `origin/main`.

The shape is always one thing. **A check's "I could not run" path and its "I ran and found
nothing" path produce the same output**, so the landing proceeds on a verdict nobody earned.
Every instance is latent rather than firing — which is exactly why they survived a PRD written
about them.

## Evidence

All executed at `51e971c` against fixtures, never against the real remote; the gate itself was
never run, because running it is the landing.

- **An invalid fence regex lands off-fence work.** `gate.sh:59` — `FENCE='['` makes `grep -vE`
  error, `|| true` converts it to an empty violation set, and `:61` prints `fence OK` while a
  file no fence allows proceeds to merge and push. Reachable by a typo in an argument the
  operator hand-types on every landing. `|| true` cannot simply be deleted: `grep -v` exits 1
  on the clean no-match path.
- **A failed `git status` reports a clean worktree.** `gate.sh:69` — the pipeline's status is
  discarded into `wc -l`, so a failure yields `dirty=0` and the stranded-work check passes.
- **The NUL guard skips any path git quotes, then says clean.** `gate.sh:77`+`:83-84` — a file
  named `café.ts` **containing two NUL bytes** is emitted as `"caf\303\251.ts"` under default
  `core.quotePath`, `[ -f ]` fails on the literal quotes, and the loop prints `no NUL bytes`,
  exit 0. Exactly what the guard exists to catch.
- **A failed manifest prune prints success.** `gate.sh:172-181` — `try { … } catch {}`
  swallows everything, node exits 0, and `&& echo "lane manifest pruned"` fires regardless.
  Malformed and unwritable `lanes.json` both produce byte-identical output to the success
  case. The comment above it records the bug this reproduces: *"three landed lanes read
  OFF-FENCE in a live UI."*
- **Branch absence is not proof of a merge.** `gate.sh:166` — in a detached worktree
  `BRANCH=HEAD`, `refs/heads/HEAD` does not exist, so the postcondition passes while
  `merge-base --is-ancestor` shows the commit is not in `main`.
- **Three more of the same shape, lower reachability, all executed.** `gate.sh:83` — a
  process substitution does not propagate its producer's status and `pipefail` does not
  apply, so a failed `git diff` gives the clean verdict (an unresolvable `main` dies at
  `:70` first). `gate.sh:49` — on the `|| echo "$W/.git"` fallback, `.git` in a linked
  worktree is a *file*, so `[ -d "$GD/rebase-merge" ]` can never be true; verified
  against a real in-progress rebase, correct resolution DETECTED, fallback MISSED.
  `gate.sh:127-129` — a garbage `timing-count` becomes `PREV=0`, making the shrink check
  unfireable.
- **Nothing in the suite asserts this script's behaviour.** `grep -rln "gate.sh" packages`
  finds only `// @gate-timing` marker comments. Every fix above, and prd-39's, is held by
  review alone.
- **prd-24 residual 2: a red leg is four unrun gates.** `ci.yml:66,69,72,97` — Typecheck, Lint,
  the packaging guard and the boot smoke carry no `if:` at all, so a failed Test skips them
  silently. Already stated in `AGENTS.md`; still true.
- **prd-24 residual 1: the last flat law walk, latent.** `recordings/no-live-fleet-law.test.ts:31`
  walks one directory level and `:39`'s floor is a hardcoded `toBeGreaterThan(3)`. Measured:
  the directory has **zero subdirectories**, so the walk currently sees all 13 source files
  and the floor has enormous headroom — this hides nothing today and cannot newly redden
  anything. It is a defect under prd-24 ruling 3 (walked scope must *equal* claimed scope, a
  floor derived not hardcoded), and it fires the day someone adds a subdirectory, which is
  exactly how the `lab/` sibling hid `lab/branching/geometry.ts:1`.

## Success

1. Every check in `gate.sh` produces output that distinguishes "could not run" from "ran and
   found nothing". **Not met while** any check's failure path and its clean path emit the same
   line.
2. No postcondition in `gate.sh` proves a proxy for the fact it claims. **Not met while**
   branch absence stands in for the lane commit being in `main`.
3. The class cannot regress unnoticed. **Not met while** no executable check asserts
   `gate.sh`'s own behaviour.
4. A red CI leg still reports every gate that could have run. **Not met while** any step after
   `Test` lacks `if: always()`.

## Non-goals

- **Not a rewrite of the gate.** Its structure, fence semantics, load batches and timing pass
  are untouched. This PRD changes which branches can lie, and nothing else.
- **Not new checks.** No check joins `gate.sh` here. Coverage is prd-24's retired subject.
- **Not the operator's own tooling.** Session-start freshness and dispatch preflight live in
  the operator's dotfiles by the standing rule, and no wave here touches them.
- **Not prd-29's read-side contracts**, which prd-24's amendment assigned to prd-29 wave 3.

**Rejected alternatives.** *Bare `set -e`* — makes every deliberately tolerant line fatal at
once, including the push exemption prd-39 ruling 1 protects. *Auditing every guard in the repo
for vacuity* — prd-24 tried the general version and retired; this PRD is scoped to the landing
tool plus two named residuals precisely because that scope is finishable. *A `shellcheck` job
instead of a law* — worth having, and filed as unfiled work below, but it cannot see a guard
whose two paths are both syntactically valid, which is the whole defect.

## What already exists (do not rebuild)

- `fail()` at `gate.sh:33`, and the `MERGED` flag beside it (prd-39) — every fix routes through
  the existing helper; the flag is the pattern for state-aware messages.
- `walkSourceFiles` in the recordings law's own sibling laws — the fix pattern for the flat
  walk, named by prd-24 ruling 3.
- **prd-24 ruling 3 still governs** a law's walked scope and its derived floor. This PRD carries
  its last unfinished walk as wave work; it does not re-rule it.

## Rulings

## Ruling 1 — a guard in the landing tool may not print a verdict it did not earn

Every check enumerated in Evidence gets a failure path distinguishable from its clean path. The
producer's status is checked separately from the consumer's normal exit — `grep -v` exiting 1 on
no-match and `git diff` exiting 128 on a bad ref are different facts and must be handled as
such. `-z` output with `read -r -d ''` replaces line-delimited parsing wherever a path is read,
since quoting is not the only hostile filename.

This extends to every branch in the file, not the eight found. prd-39 closed two and left seven;
a fix that closes the enumerated set and not the class earns this PRD a successor.

## Ruling 2 — a postcondition asserts the fact it claims

`gate.sh:166` proves the lane commit is contained in `main`, not that a ref is absent. Branch
deletion is `workmux merge`'s side effect, not the landing's meaning.

## Ruling 3 — the landing tool is covered by an executable check

A law asserts that no branch in `gate.sh` prints a fault or a verdict without honouring it. It
lands **shown red against the pre-fix tree**, per prd-24 ruling 4's still-standing discipline.
The push exemption and any successor tolerance are declared data in that law, not exceptions
buried in a regex — a tolerance nobody can enumerate is how prd-39's class survived.

## Ruling 4 — a red leg still produces the evidence of its remaining gates

Every step after `Test` in `ci.yml` carries `if: always()`. This discharges prd-24's residual 2;
prd-25's leg design already prices it in and benefits directly.

## Sequencing (waves, each gated as ever)

`scripts/gate.sh` is this PRD's centre. `packages/contract/` and the read-side contract policy
are **prd-29 wave 3's territory**; no wave here enters them. `docs/adr/` is untouched — nothing
here changes a boundary.

**Wave 0 — operator act, booked not skipped.** Wave 1 is landed by hand, without `gate.sh`,
because the gate still cannot be trusted to land its own fix. Not dispatchable. prd-39 booked
the same wave for the same reason and it held.

**Wave 1 — the whole of it, three issues, one PR.** Parallel, fenced apart:
`prd45 w1: a gate check that cannot run says so`
(`scripts/gate.sh` + `packages/server/src/gate-honesty-law.test.ts`, rulings 1–3) ·
`prd45 w1: a red leg reports its remaining gates` (`.github/workflows/ci.yml`, ruling 4) ·
`prd45 w1: the recordings law walks what it claims` (`packages/web/src/recordings/`,
prd-24 ruling 3).

The three fences are pairwise disjoint, none depends on another, and none adds a
dependency — so they are one wave and one PR, paying the queue's fixed per-PR toll once.

Rulings 1–3 are **one issue, not two**, and that is the correction this PRD's grooming
made to its own first draft. The law asserting `gate.sh`'s honesty can only be green after
the fix exists: that is a stack, not a bundle, and the wave contract allows a stack in a
wave only as a single issue. One lane writes both, and lands the law **shown red against
the pre-fix tree** — an ordering discipline inside one lane's commits rather than a
dependency between two issues.

**Unfiled work implied, described not numbered:** a `shellcheck` job over `scripts/` — prd-39
already named its absence, and the nine tracked shell scripts have had reading and `bash -n`
only. The two vacuously-correct walks prd-24 named (`interaction/no-model-call-law.test.ts`,
`connect/index.test.tsx`) are deliberately NOT in wave 1 — they are prd-24 ruling 3's tail,
not this PRD's centre, and folding them in would widen the recordings fence to the whole web
package. prd-24's `geometry.ts` carve-out is still a decision owed to whoever takes them.

## Open questions

- **Should `gate.sh:49`'s fallback be removed rather than made fatal?** `:41` already proves git
  works in the worktree, so the fallback may be dead code rather than a dead path. Removing it
  is smaller than guarding it, and one less branch is one less thing to lie. Open, not ruled.
- **Does ruling 3's law belong in the suite or in CI?** A vitest law runs in every lane's
  `npm test`, which is where a lane would notice breaking it; a CI-only check keeps shell
  concerns out of the web suite. The repo has precedent for both. Open, not ruled.
