# Fable review — 2026-08-06

Five independent Fable reviewers, one per dimension, run in parallel against `1bed433`.
Each seat read the code directly; no seat saw another seat's findings.

| Seat | Report | Headline |
|---|---|---|
| Product / docs / vision | [product.md](./product.md) | Real problem, narrow user, docs apparatus outrunning the userbase |
| Architecture | [architecture.md](./architecture.md) | Boundaries are real and enforced; `lab` is a second product held by convention |
| Security | [security.md](./security.md) | MODERATE — one unauthenticated mutating route, otherwise careful |
| Code quality | [code-quality.md](./code-quality.md) | Lint/typecheck clean, 1 real test failure, not over-engineered |
| Implementation | [implementation.md](./implementation.md) | No subprocess timeouts — one hung `git` freezes everything |

---

## Verification record

Reviewer claims were spot-checked against the tree before being acted on. Verified
independently:

- `timeoutMs` is declared at `packages/core/src/collector.ts:15` and plumbed into
  `execFile` at `packages/server/src/server/exec.ts:16` — and those are its **only**
  two non-test occurrences in the repo. No caller sets it. Confirmed.
- `poll-loop.ts:121-128` single in-flight gate and `stop()` awaiting `inFlightTick`.
  Confirmed.
- `git-collector.ts:73-81` sets `disabled: true` with an unconditional early return at
  `:66-68` and no retry path. Confirmed.
- No `-z` flag and no `quotePath` handling anywhere under
  `packages/server/src/collectors/git/`; zero non-ASCII bytes in any git fixture.
  Confirmed.
- `requireCapabilityToken` appears exactly once across `packages/server/src/api/` — on
  `/api/label` at `label.ts:38`. `lab.ts:532` registers `POST /api/lab/launch` with no
  `preHandler`. Confirmed.
- `namespace-law.test.ts` failure reproduced directly. Confirmed failing — but **both**
  reviewers misdiagnosed the cause; see below.
- `git-collector.ts:260-267` silently carries forward stale dirty state with no event
  emitted, comment and all. Confirmed verbatim.
- `tmux/collector.ts:77-88` disables permanently on first failure, same shape as the git
  collector. Confirmed — it is a pattern across two collectors.
- `session-recorder.ts:36,115,129` unbounded buffer, reset only by rotation, returned by
  a full copy. Confirmed — and worse than reported: `eventsSoFar()` has **9 non-test call
  sites**, two of which (`api/meta.ts:107`, `cli/run.ts:184`) fold the whole array through
  `reduceAll`. An `/api/meta` request is O(n) against an unbounded n.

Not independently verified (reported with line references, high confidence, unchecked
here): `static.ts:29-34` prefix bypass, `tail.ts:26` truncation stall, the `spend.ts`
selector duplication estimate, the `stream.ts` dangling-drain promise.

## Correction — the failing test

Both the code-quality and implementation seats reported
`packages/server/src/lab/namespace-law.test.ts:657` as failing. Both diagnosed it wrong,
in different ways, and their reports carry a note pointing here.

- Code quality called it environment-dependent and suggested a git-version skip guard.
- Implementation called it a `dataRoot` canonicalization gap companion to `7a9219d`.

The actual cause: line 655 asserts `worktree.startsWith(realDataRoot)`, where
`realDataRoot` holds the raw `/var/folders/…` spelling while `git worktree list` returns
the already-canonical `/private/var/folders/…`. The test's own evidence block prints both
spellings and shows git *did* canonicalize — all three arms landed correctly under
`…/real-data/lab/worktrees/fork-…-arm-{1,2,3}`. The prefix match fails only because one
side of the comparison was never resolved.

The tell is the next assertion at `:659`, whose comment reads "same canonicalization as
above" while correctly wrapping both sides in `realpathSync.native` — which is exactly
what `:655` does not do. Same bug class as `1612a14` and `7a9219d`; this site was missed.

**Fix:** resolve `realDataRoot` through `realpathSync.native` at line 655. Do **not**
skip the test behind a version guard — it is proving worktree containment, and the app
behaviour it covers is correct.

## Convergent finding

All five seats independently flagged `lab`, from different directions:

- **Product** — an unearned second product, built before the first has one user who isn't the builder.
- **Architecture** — "read-only except lab" is enforced by a grep-based test and a runtime assert *inside the same process*; a convention, not a wall.
- **Security** — the one unauthenticated mutating route is `POST /api/lab/launch`.
- **Quality / implementation** — the only failing test in the repo is lab's containment law.

That is one problem seen four ways: a mutation-capable actor grafted onto a read-only
observer, held in place by discipline rather than structure, already showing stress at
exactly the seams you would predict.

## Recommended order of work

1. **Subprocess timeouts + poll-loop watchdog.** Highest likelihood, total functional loss, no recovery but a kill.
2. **`preHandler: requireCapabilityToken(...)` on `/api/lab/launch` and `/api/rotate`**, and correct SECURITY.md's "never from the server or the UI" claim, which is currently false.
3. **Fix `namespace-law.test.ts:655`** per the correction above.
4. Then decide `lab`'s boundary — give it a structural wall (separate process or package tier) or move it out. Retrofitting gets more expensive with every feature added.

5. **A deleted worktree keeps rendering as healthy** (`git-collector.ts:260-267`) — stale
   dirty state carried forward with no event emitted at all. Silent wrong data on a
   dashboard whose entire job is telling you the truth about your worktrees; arguably
   belongs above item 4.

Lower priority, real: collector retry/recovery (the permanent-disable pattern spans both
git and tmux), `SessionRecorder.buffer` growth and the O(n) `eventsSoFar()` callers,
`core.quotePath` decoding plus a unicode git fixture, `spend.ts` selector consolidation
(~150-200 lines), moving the README's 347-line Dashboard section to its own doc.
