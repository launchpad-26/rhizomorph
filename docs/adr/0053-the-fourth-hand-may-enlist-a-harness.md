# 0053. The fourth hand may enlist a harness's user-level configuration, reversibly — amends ADR-0019

- **Status:** proposed (prd-57 ruling 4)
- **Date:** 2026-09-15
- **Amends:** [ADR-0019](0019-the-fourth-hand.md). Its grant clause 1 names two powers — launch or
  relaunch a conductor, and clone a repo to disk — and says in as many words that *"a power not on
  this list costs another amendment."* This is that amendment: the concierge gains **(c) enlist or
  unenlist a detected harness's user-level configuration**, idempotently and reversibly, on an
  explicit human act.

## Context and Problem Statement

Telemetry today is a block of environment variables the operator pastes per lane. That shape was
inherited from launching every agent through one lane manager: if a lane manager starts every
agent, a per-lane envelope reaches every agent. It does not survive contact with a developer who
opens a terminal and types `claude`.

A harness's user-level configuration file is the one place a setting applies to every future
session, in every terminal, in every repo. For Claude Code that is `~/.claude/settings.json`, whose
`env` block takes exactly what `packages/server/src/concierge/harness/claude.ts` already renders
through `packages/server/src/cli/telemetry-env.ts`, and whose `hooks` block is how a harness is told
to announce its own lifecycle.

Writing that file is a write **outside the watched repo, on the operator's own machine, at the
operator's request**. That is the concierge's class of act — ADR-0019 already grants it a clone,
which is a larger write to a directory the operator names. What it is not is a power ADR-0019
listed, and the list is closed by its own terms.

There is a second problem this record has to answer, and it is the reason the bound is written the
way it is: the file belongs to another program. The instrument did not create it, does not own its
schema, and must be able to put it back.

## Considered Options

- **A — A third grant on the fourth hand**, bounded: explicit per harness, diff before write,
  backup beside, exact declared keys, merge never clobber, byte-identical restore.
- **B — A new hand**, a sixth, for configuration writes.
- **C — Instructions only.** The instrument shows the diff and the operator edits the file.
- **D — Ship a wrapper binary** the operator puts on `PATH` in place of the harness.

## Decision Outcome

Chosen: **A**, with the bound below. Each clause is a law that lands before the module it governs,
which is ADR-0019's own clause 7 applied to the new power.

- **Explicit, per harness, from a human act.** A gated-mutation route and its CLI twin. No
  collector, no poll and no boot reaches either. ADR-0019 clause 3 — *"the hand has no clock"* —
  holds unchanged.
- **The CLI reaches the hand through the route, not by import.**
  `packages/server/src/concierge/namespace-law.test.ts` declares exactly one importer, and a
  declared importer is a terminus: everything above it inherits the grant. This record widens that
  set by nothing. The precedent is `packages/server/src/harness-roster.ts`, which exists precisely
  because a CLI surface could not reach into the hand and the repo's answer was to move the data
  out rather than widen the fence.
- **Diff first, then write; backup beside.** The first act returns the exact diff and writes
  nothing. The second writes, after copying the original beside itself. The file is re-read
  immediately before the write and the write refuses if it changed since the diff was shown —
  because two programs writing one file is a race, not a hypothetical.
- **Exact declared keys, and a byte-identical restore of everything else.** The adapter declares the
  key set it owns. A law asserts, against a fixture carrying unrelated content, that enlist changes
  exactly those keys and that unenlist restores the file byte-for-byte except them.
- **Merge, never clobber.** Existing hook entries and environment variables survive. A pre-existing
  foreign OTLP endpoint is **refused by name** rather than overwritten — the operator already
  exports somewhere and this hand will not hijack it — and the refusal is recorded as an event, with
  a hooks-only enlist offered instead.
- **No secret, no clock.** What is written is a loopback URL and an installation id. ADR-0019
  clauses 3 and 5 hold as written, which is the test this record had to pass to be an amendment
  rather than a new constitution.

A harness with no captured configuration format gets a member that throws with the reason *"no
capture"*. Detection continues to work for it, because knowing a harness is installed is true and
useful even when instrumenting it is not built.

**B lost** for the reason ADR-0019 rejected the same shape: the concierge already exists for
"getting set up at all", and a sixth hand for one file write is ceremony without a boundary. The
public trust claim enumerates hands, and lengthening that list for a power that fits an existing
one makes the list harder to read, not more honest.

**C lost** as the "project to install" friction this whole direction exists to remove. It is
preserved as a capability rather than a design: the diff-first step means the operator can always
read what would be written and make the edit themselves.

**D lost** because a wrapper on `PATH` intercepts every invocation of the harness forever, including
ones the instrument is not watching, and it breaks the moment the harness updates. It is a larger
and more permanent intrusion than writing a documented configuration key.

## Consequences

**Good.** Full telemetry becomes one act, once, for every future session in every repo — rather
than a paste per lane that is forgotten exactly when it matters.

**Good.** `unenlist` is a real undo and is tested as one. A power that can be withdrawn is a
different kind of grant from one that cannot, and the byte-identical restore is what makes the
difference checkable rather than promised.

**Bad.** The instrument now edits a file another program owns. If Claude Code changes its settings
schema, enlist breaks — so the adapter's fixture is that harness's real file, and the capture rule
applies here exactly as it does to a platform leg.

**Bad.** Two programs writing one file can race. The re-read-before-write narrows the window; it
does not close it. A harness that rewrites its own settings between the diff and the write gets a
refusal, which is the correct outcome and is still a failure the operator has to understand.

**Bad.** A backup file accumulates beside the original, one per enlist. Nothing prunes it, and this
record does not grant a power to delete the operator's files.

**Neutral.** ADR-0019 clauses 3 and 5 are unchanged and remain true of this hand. Clause 4 — *"never
inside the watched repo"* — is satisfied by construction: a user-level configuration file is not in
the repo. Worth stating because several source comments use "clause 4" to mean the namespace law's
fourth clause, which is a different rule about reaching a shell.
