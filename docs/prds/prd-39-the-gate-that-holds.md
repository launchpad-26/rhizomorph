# prd-39 — the gate that holds: the landing tool's own checks are checks

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd39`. Drafted the
> same day from the reconciled audit at `03df141` (findings 1 and 45, both re-verified there —
> untracked artefact, `.gitignore`d; the sha is the anchor, and the Evidence below restates what
> it found rather than deferring to it). Wave 1 is the only work in this repo that should land
> before anything else, because everything else lands *through* the thing it fixes.

## Problem

`scripts/gate.sh` is not a pre-push check — running it **is** the landing (`AGENTS.md`:
*"the operator runs it. A lane never does"*). It rebases, audits the fence, runs the suite,
merges into local `main`, rebuilds, and pushes to `origin/main`. Its header promises
*"every check exiting non-zero on failure."*

Two of its checks do not. A merge that breaks the build is pushed to `origin/main` with a
warning in the log, and a guard that cannot run reports success. The operator's only landing
tool is the one place in this repo where a red check is advisory — and because it publishes,
every other lane's work inherits that.

## Evidence

- **`set -uo pipefail` carries no `-e`.** `scripts/gate.sh:10` — a failing command does not
  abort the script, so every later line runs regardless.
- **The build check cannot fail the gate.** `scripts/gate.sh:170-175`: the `else` branch
  prints `!! BUILD BROKEN ON MAIN after merging $H — fix forward immediately` and falls
  through. `fail()` exists at `:25` and is used at **15 other sites** in the same file.
- **The push is unconditional.** `scripts/gate.sh:181` runs `git push origin main` after that
  fall-through. Its comment — *"Loud but non-fatal — an offline push must not hold a green
  landing hostage"* — is a deliberate ruling about the **push**, silently inherited by the
  **build** one line above it.
- **`npm install` after merge is advisory too.** `scripts/gate.sh:169` ends
  `|| echo "  ! npm install after merge reported an issue"`, so a stale-lockfile merge
  proceeds to build and push.
- **The NUL-byte guard reports success without checking.** `scripts/gate.sh:62`
  `c=$(python3 -c "…" "$W/$f" 2>/dev/null || echo 0)` — a missing `python3` or an unreadable
  file yields `c=0`, indistinguishable from "zero NUL bytes", and `:65` prints the clean
  verdict anyway. A vacuous **positive** assertion inside the landing tool.
- **Verified read-only.** The script was read end-to-end at `03df141` and deliberately not
  fired: firing it pushes.

## Success

1. Every check in `gate.sh` that prints a failure also exits non-zero. **Not met while** any
   branch in the script reports a fault and reaches `git push origin main`.
2. A guard cannot report success when it could not run. **Not met while** any check's failure
   path and its "nothing found" path produce the same output.
3. The push stays deliberately non-fatal, and says so where it is decided. **Not met while**
   the offline-push ruling is stated only as a comment on the line it protects, leaving the
   next reader to infer its scope.

## Non-goals

- **Not a rewrite of the gate.** Its structure, its fence audit, its load batches and its
  timing pass are untouched. This PRD changes which branches are fatal, and nothing else.
- **Not a change to what the gate checks.** No new check joins it here — `#244`'s coverage
  meter and the doc-truth laws belong to prd-24 and prd-43 respectively.
- **Not CI.** `.github/workflows/ci.yml`'s own step-ordering defect is prd-24's territory
  (its Success already names *"a red leg is four unrun gates"*); no wave of this PRD edits a
  workflow file.
- **Not the operator's habit.** Nothing here makes the gate safe to run from a lane. The
  runbook's division stands: the operator runs it, a lane never does.

**Rejected alternatives.** *Adding `set -e`* — it would make every advisory line in a
200-line script fatal at once, including the deliberately tolerant ones, and the failure
would land in whichever check the operator happened to be near. *Reordering so the push comes
first* — the push is what must be last; the problem is not order but which faults are fatal.
*Reimplementing the NUL probe in pure bash* — `LC_ALL=C grep -qU` is available and is a
legitimate second option, but it trades a proven probe for an untested one inside the landing
tool; probing the dependency is the smaller change and Ruling 2 takes it.

## What already exists (do not rebuild)

- `fail()` at `scripts/gate.sh:25` — prints `GATE FAILED`, prints `>>> HOLDING $H`, exits 1.
  Both fixes route through it. Nothing new is needed.
- `scripts/fence-lint.sh` — the fence audit's own tool, already exiting non-zero. It is the
  in-repo example of the shape the two broken checks should match.

## Rulings

## Ruling 1 — a check that prints a fault exits through `fail()`

Both post-merge checks route through the existing `fail()`: `npm install` loses its
`|| echo` and becomes `|| fail "npm install after merge broke — see /tmp/gate-install-$H.log"`;
the build's `else` branch calls `fail` after its `tail -6`.

This extends to **every** branch in the script that prints a fault, not only these two — the
defect is a class, and a fix that closes only the two found leaves the next one open. That is
the sibling-case shape `AGENTS.md` names first, and this ruling refuses it explicitly.

The push at `:181` is the one deliberate exception, and it stays: an offline operator must be
able to land. But the exception moves out of an inline comment and into a named block, so the
next reader can see that it is *one* line's exemption and not the script's posture.

## Ruling 2 — a guard probes its own dependency before it claims to have run

The NUL check asserts `python3` exists once, up front, and `fail`s if it does not — the same
posture the timing pass takes toward its own file count at `:104`. The `|| echo 0` fallback is
deleted, so an unreadable file is a failure rather than a clean verdict.

This is narrower than "audit every guard for vacuity": that is prd-24's subject. Here the rule
is only that a guard **in the landing tool** may not print a positive verdict it did not earn.

## Sequencing (waves, each gated as ever)

`scripts/gate.sh` is this PRD's whole territory. `.github/workflows/` is prd-24's; no wave
here enters it. `docs/` corrections implied by the gate's own header wording are this PRD's,
confined to `AGENTS.md`'s landing section.

**Wave 0 — operator act, booked not skipped.** The operator lands wave 1 by hand, once, without
using `gate.sh` for it — the gate cannot be trusted to land its own fix. Not dispatchable.

**Wave 1 — the Keystone.** `prd39 w1: a gate check that prints a fault holds the landing`
(ruling 1). Additive to `fail()`, zero-claimant, and every later landing in the repo consumes
it.

**Wave 2 — sequential, not parallel.** `prd39 w2: the NUL guard fails when it cannot run`
(ruling 2). It touches the same file as wave 1, so it is a stack rather than a bundle and must
follow — the working agreement's own rule against bundling across a live fence.

**Wave 3 — the paper follows the code.** `prd39 w3: the landing section names which single
check is non-fatal, and why`. `AGENTS.md` only.

**Unfiled work implied, described not numbered:** `shellcheck` is not installed on the audited
host, so the nine tracked shell scripts have had syntax checking and reading only. A pass with
a real linter would likely find more of this class, and is worth its own issue once someone
has the tool.

## Open questions

- **Should `gate.sh` refuse to run at all when `python3` is absent, or skip the NUL check
  loudly and continue?** Ruling 2 takes the first, on the grounds that a landing tool with a
  missing dependency is a tool in an unknown state. The second is defensible if the check is
  judged advisory. Open, not ruled.
- **Does the offline-push exemption still earn its place?** It was ruled 2026-08-04 against a
  named operator need. Nobody has asked whether that need survived the concierge and the
  desktop shell. Open, not ruled.

## Amendment — the waves collapse to one (grooming, 2026-08-22)

Sequencing above named three dispatchable waves. Grooming collapsed them to **one wave, two
issues, one PR**, on two findings that only surfaced once the fences were drawn:

- **Waves 1 and 2 both edit `scripts/gate.sh`.** A stack in one file has exactly one lawful
  bundling under the wave contract — *same wave as one issue* — so rulings 1 and 2 ship as a
  single issue. Three PRs for fifteen lines of shell pays the queue's fixed per-PR toll three
  times; the working agreement exists to refuse that.
- **Wave 3 only looked dependent.** It appeared to need wave 1's final line numbers because
  `AGENTS.md:279-280` cites `gate.sh:172` and `gate.sh:177`. **Those citations are already
  wrong** — `:172` is now `else` and the push is at `:181` — so the fix is not to sequence
  around the dependency but to delete it: the runbook cites behaviour and section, never line
  numbers, and stops rotting each time the script moves. That makes wave 3 fence-disjoint from
  wave 1 and puts both in the same PR.

The rulings are unchanged and unrenumbered. Only the wave shape moved.

**Discovered at the same grooming and recorded in `.swarm/coupling.txt`:** `scripts/gate.sh`
greps `packages/web/src/scene/perf.test.ts` and `SceneView.test.tsx` for the `@gate-timing`
marker and `fail`s on a zero count (`gate.sh:104`), so renaming either file breaks the landing
tool from a directory no lane entered.
