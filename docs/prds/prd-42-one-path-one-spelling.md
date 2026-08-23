# prd-42 — one path, one spelling: a path means the same thing everywhere it is written

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd42`. Drafted the same day from the reconciled audit
> at `03df141` (findings 3, 19, 20 — untracked artefact, `.gitignore`d; the sha is the anchor). Stands on `#217`/`#228`/`#299`/`#401`, whose lesson — *a duplicated path primitive gets
> hardened in one copy and keeps the hole in the other* — is this PRD's whole thesis.

## Problem

Three seams in this tree write a path twice and let the two spellings disagree.

A worktree path is encoded to a project slug by one character class and decoded by another. The
two differ by a single character — a space — and the consequence is total: for any repo whose
path contains a space, **every transcript is invisible, forever**, and the failure is
indistinguishable from an agent that never started. That is the exact failure mode prd-19 exists
to end, arriving through the door prd-19 did not check.

A tokenless route hand-rolls a containment check that the repo already has a hardened primitive
for — the primitive that exists *because* prefix comparison was found wrong three times.

And a session-moving route names a concurrency obligation and then documents that no caller
holds it.

## Evidence

- **The encoder omits a space; the decoder includes one.**
  `collectors/sessionlog/worktree-slug.ts:34` is `worktreePath.replace(/[/_.\\:]/g, '-')` — no
  space. `concierge/repos.ts:229` is `entry.replace(/[._ ]/g, '-')` — with one. Verified by
  reading both at `03df141`.
- **The direction was established by probe, not by argument.** A real `claude -p` session started
  from a directory whose name contains a space produced a slug in which the space had become a
  dash — so Claude Code's own slugger maps it, `repos.ts` is right, and the encoder is wrong.
  (Probe run by the second audit; artefacts removed.)
- **A test pins the wrong behaviour as correct.** `worktree-slug.test.ts:65-67` asserts the
  current, space-less class.
- **Eight call sites inherit it**, including `log/transcript-attribution.ts`,
  `collectors/sessionlog/collector.ts`, `concierge/paths.ts`, `lab/checkpoint.ts`,
  `lab/restore.ts` and `cli/doctor.ts` — every one of which then looks in a directory that does
  not exist.
- **A route hand-rolls containment.** `server/static.ts:119` compares
  `requested.startsWith(root + path.sep)` on a `path.resolve`d but **uncanonicalised** path, while
  `paths/containment.ts` exports `isInside`, which canonicalises both sides through
  `realpathSync.native` precisely because `#217`/`#228`/`#299` found prefix comparison wrong.
  `static.ts` does not import it.
- **`retargetSession` declares an obligation nobody holds.** `recorder/rotate.ts:245-249` states a
  second concurrent retarget is "the caller's own boundary", where `rotateSession` keeps a
  `WeakMap` in-flight guard at `:201`. `api/retarget.ts:144-237` snapshots `from`/`to` before
  `await ctx.pollLoop?.stop()` with no mutex.
- **Its reachability is low, and that is verified rather than assumed.** No caller exists in
  `packages/web`, `packages/app` or `scripts`.

## Success

1. A repo path with a space in it finds its transcripts. **Not met while** the encoder and the
   reverse walk disagree on any character, or a round trip through both is not proven by a law.
2. Containment is decided in one place. **Not met while** any route compares path prefixes
   directly instead of through `isInside`.
3. A route that moves a session refuses to overlap with itself. **Not met while** two concurrent
   retargets can both proceed, or a retarget can interleave with a rotation.
4. The slug change is stated, not slipped. **Not met while** an on-disk naming change lands
   without the PR saying so explicitly.

## Non-goals

- **Not the slug algorithm's design.** `#243` owns whether this encoding is the right one at all.
  This PRD makes the two existing halves agree; it does not redesign either.
- **No gating of `GET /*`.** `static.ts` is the tokenless bootstrap ADR-0012 depends on and
  prd-29 ruling 1 keeps tokenless forever. Fixing its containment check must not drift into
  gating its class — the temptation is real and this non-goal exists to name it.
- **Not a migration.** A spaced-path slug has never resolved, so there is nothing on disk under
  the old spelling to move.
- **Not rotation's own semantics.** prd-16 owns the recorder's session boundary; this PRD adds a
  guard around retarget, it does not change what a rotation means.

**Rejected alternatives.** *Widening the decoder to match the encoder* — it would make both sides
agree on the wrong answer, and the probe says which side is wrong. *Case-folding `isInside` on
case-insensitive filesystems* — a real question raised by the first audit and deliberately left
alone here: it changes the primitive's meaning on two platforms and deserves its own ruling rather
than riding along with a caller migration. *Queueing overlapping retargets* — a queued retarget
writes a session into a repo the operator has already moved away from; refusing is the honest
answer.

## What already exists (do not rebuild)

- `paths/containment.ts`'s `canonicalize` and `isInside` — the sanctioned primitive, with
  `#217`/`#228`/`#299`'s hardening already in it. Nothing new is written; ruling 2 adds a caller.
  Its four existing importers are `collectors/pi/collector.ts`,
  `collectors/sessionlog/process-probe.ts`, `concierge/paths.ts` and `concierge/migrate.ts` —
  **`static.ts` is not among them**, which is the defect at `:119` and not a worked example.
  (An earlier draft of this line said `static.ts` imports it, contradicting this PRD's own
  evidence four sections up.)
- `rotateSession`'s `WeakMap` in-flight guard at `recorder/rotate.ts:201` — the shape ruling 3
  copies. Both routes should share it rather than growing two.
- `worktree-slug.test.ts` — the test exists; ruling 1 corrects its expectation and adds the round
  trip it was missing.

## Rulings

## Ruling 1 — the encoder and the reverse walk are one fact, proven by round trip

`worktree-slug.ts:34`'s character class gains the space: `/[/_.\\: ]/g`.
`worktree-slug.test.ts:65-67`'s expectations move in the same edit — a path and its encoding are
one fact written twice, and changing one without the other leaves a test that passes while no
longer testing the encoding (`AGENTS.md`'s `#649` lesson, verbatim).

The law that keeps it closed is a **round trip**, not a second table: for a generated set of paths
including spaces, dots, underscores and colons, encoding then walking back must return the
original. A law asserting the class's literal contents would pass at any wrong-but-matching pair —
which is how this survived.

## Ruling 2 — containment has one implementation, and callers import it

`static.ts:119` uses `canonicalize` + `isInside`. Its test gains a symlink inside a temp `dist`
pointing outside it, expected to be refused.

This ruling extends to any future caller: a path-containment comparison written outside
`paths/containment.ts` is a defect regardless of whether it is currently exploitable. `#401`'s
lesson is that the second copy is where the next hole lives, and low exploitability today is not
the same as correctness.

## Ruling 3 — a route that moves a session holds its own boundary

The retarget route takes the same in-flight guard `rotateSession` holds, shared rather than
duplicated. An overlapping call is refused with **409** — refuse, never queue (see the rejected
alternative).

`retargetSession`'s doc comment is corrected in the same commit: it currently names an obligation
and assigns it to a caller that does not exist, which reads as a decision and is actually a gap.

## Sequencing (waves, each gated as ever)

`collectors/sessionlog/worktree-slug.ts`, `server/static.ts`, `recorder/rotate.ts` and
`api/retarget.ts` are this PRD's territory. `paths/containment.ts` is consumed, never edited.
`api/index.ts`'s route classes are prd-29's — no wave changes one. Every wave follows prd-39
wave 1.

**Wave 1 — the Keystone.** `prd42 w1: the slug round trip is a law` — the law first, red against
today's tree. Zero-claimant; it is what proves wave 2 and it is the thing that was missing when
this shipped.

**Wave 2 — parallel, fenced apart:** `prd42 w2: a path with a space finds its transcripts`
(`worktree-slug.ts` + its test) · `prd42 w2: the served page decides containment with the shared
primitive` (`server/static.ts`) · `prd42 w2: a retarget refuses to overlap itself`
(`recorder/rotate.ts` + `api/retarget.ts`). Three lanes, no shared file.

**Wave 3 — the sweep, last.** `prd42 w3: no path prefix comparison survives outside
containment.ts` — a grep law over `packages/server/src`, run after wave 2 so it does not re-lay
ground wave 2 is digging. Sweeps come last by the corpus's own rule.

**Unfiled work implied, described not numbered:** `isInside`'s behaviour on case-insensitive
filesystems is a real open question (first audit, finding B3) and is deliberately not in scope
here. The eight call sites downstream of the slug encoder were counted, not individually tested;
if any of them caches a slug across the change, it is its own issue.

## Open questions

- **Does any tracked fixture encode a slug by hand?** If one does, ruling 1's edit must move it in
  the same commit, and a fixture whose expected bytes no longer match has stopped being evidence
  (`AGENTS.md`). Not yet enumerated. Open, not ruled.
- **Should `isInside` case-fold on macOS and Windows?** It changes the primitive's meaning on two
  platforms and interacts with prd-25's Windows leg. Open, not ruled.
- **Is 409 the right refusal for an overlapping retarget, or 423?** 409 matches the repo's
  existing vocabulary; nobody has ruled on it. Open, not ruled.
