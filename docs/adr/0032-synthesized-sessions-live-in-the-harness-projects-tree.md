# 0032. A synthesized session lives in the harness's own projects tree, not the instrument's data root

- **Status:** accepted
- **Date:** 2026-09-03

## Context and Problem Statement

> **Reconstructed.** Written 2026-09-03. The decision was made 2026-08-04 in
> `c9d3643` (`packages/server/src/lab/checkpoint.ts` — the temp-index capture recipe), the same day
> prd-12 ruling 1 amended the read-only constitution, and the containment law was
> extended to cover it later that day in `57ecfe1`. Both options below are
> reconstructed from the code and from ADR-0005's own consequence list, not from
> a surviving research note. Which parts are inferred is marked.
>
> **Cited by sha, deliberately.** Those commit subjects name issues `#148` and
> `#153`, and ADR-0005 names `#243`. All three belong to the repository as it
> existed before it was recreated in 2026-08; the numbering restarted, so every
> reference below about that period resolves to nothing or, worse, to an
> unrelated live issue. `gh issue view 243` returns *"Could not resolve to an
> issue"*. The commits survived the recreation and the issues did not, so shas
> are the only durable citation for anything pre-recreation — including in this
> record, which exists to serve a PRD whose first ruling is that a cited path
> must be reachable.

prd-12 ruling 1 amended the read-only constitution to grant the laboratory a
write surface, enumerated exactly: refs under `refs/rhizomorph/`, the git objects
those refs require, worktrees the lab creates, and *"checkpoint /
synthesized-session artifacts OUTSIDE the watched repo (the same data-directory
posture as the event log)"*.

The parenthetical is the problem. The event log lives under
`~/.local/share/rhizomorph/` (ADR-0005), and ADR-0005's own consequences say
*"the lab's containment law compares paths against this root"*. Read together,
those put synthesized sessions beside the event log.

They are not there. `packages/server/src/lab/checkpoint.ts` writes them to
`~/.claude/projects/<slug>/`, where `<slug>` comes from
`worktreePathToProjectSlug` — `replace(/[^a-zA-Z0-9]/g, '-')`, a deliberate
mirror of Claude Code's own slugger. The containment law permits it explicitly
(`packages/server/src/lab/namespace-law.test.ts`, `isAllowedWrite`: `parts[0] === 'data' || parts[0]
=== 'claude-projects'`) and asserts it against a real `captureCheckpoint` +
`dispatchFork` run, so the permission is tested rather than incidental.

> **Amendment — the writer named is wrong, and so is the subject (2026-09-04).**
> The decision above is unchanged: a synthesized session belongs in the
> harness's own projects tree. But the paragraph above misnames both the module
> and the artifact. The write happens in `packages/server/src/lab/restore.ts`'s
> `synthesizeSession`, at `path.join(projectDir, sessionId + '.jsonl')` — not in
> `checkpoint.ts`. `checkpoint.ts`'s only contact with
> `~/.claude/projects/<slug>/` is `cutSession`, which opens the parent's active
> session file to hash it (`readFile` + a sha256 digest of the cut prefix) and
> never writes there; its one `copyFile` is the temp git index `snapshotWorkspace`
> uses for the checkpoint's own commit recipe, unrelated to this tree entirely.
> And a checkpoint's own artifacts — the git ref under
> `refs/rhizomorph/checkpoints/<checkpointId>` plus the `fork.checkpoint` event
> `captureCheckpoint` appends to the event log under the data root — never touch
> the harness tree at all; only a session *synthesized from* one, on restore,
> does. Found during #264's review. `README.md`'s Trust section describes the
> same two writes and was checked in the same pass: it already assigns them
> correctly, naming the checkpoint's ref and event-log entry beside the
> recording directory and only the synthesized session under
> `~/.claude/projects/<slug>/`. The error is confined to this record.

So the decision was made, is enforced, and was never written down. What forces
were at play:

- **A synthesized session exists to be resumed.** `lab fork` restores arms of a
  checkpoint so an operator can carry on from one, and the thing that resumes a
  session is Claude Code. ADR-0020 records the path it reads —
  `~/.claude/projects/<cwd-with-separators-as-dashes>/<sessionId>.jsonl` — and
  every consumer in this repo (`checkClaudeProjects`, the migration, the
  sessionlog collector) is built against it. **Stated as the constraint we
  actually rely on, not as a claim about the harness's whole API:** whether
  Claude Code can *also* be pointed at a session elsewhere is not something this
  repo has established, and no test here would notice if it could. What is
  established is that this is the only path anything in this codebase resolves.
- **The instrument does not own that layout.** The slug rule, the directory, and
  the file naming belong to another tool and can change without notice.
- **The constitution is a promise about writes**, so any second write root has to
  be nameable, bounded, and checkable — not a special case that grows.
- **Four documents already describe the other posture** — prd-12 ruling 1's
  parenthetical, ADR-0005's root claim, `README.md`'s Trust section (*the
  artifacts "live beside"* the lab worktrees dir), and the containment law's own
  docblock, which explains its `.git` clause *"out loud"* and says nothing about
  `claude-projects`.

## Considered Options

- **A — write into `~/.claude/projects/<slug>/`**, the harness's own tree, and
  widen the containment law by one named root.
- **B — write under `~/.local/share/rhizomorph/lab/`**, one containment root, as
  ruling 1's parenthetical and ADR-0005 imply.
- **C — write under the instrument's root as the source of truth, and copy into
  the harness tree on an explicit act.**

## Decision Outcome

Chosen: **Option A**, because it is the only one where the feature works.

A synthesized session that Claude Code cannot load is not a resumable session,
and resuming is the entire purpose of `lab fork`. **B** produces a correct,
contained, useless artefact. That is not a trade-off between containment and
convenience; it is a trade-off between containment and the feature existing, and
ruling 1 granted the write surface precisely so the feature could exist.

**C loses on a subtler point, and it is the one worth recording.** It looks like
the principled answer — keep one root, make the outside write an explicit,
invocable act, which matches ruling 1's "never without a human's explicit
command" posture. But it does not shrink the checkable write surface, it moves
it: the law must still permit a write into the harness tree, so `claude-projects`
appears in the allowlist either way. What C adds is a second copy of evidence
that can drift from the first, and this repo already has an ADR about how fiddly
that is — ADR-0020 settled transcript migration as *one create-only copy*
precisely to avoid two mutable copies of the same transcript. C would re-derive
that problem inside the lab.

Not chosen and not padding: **doing nothing** was the status quo for a month, and
it is what this record ends. The decision was already load-bearing; what was
missing was the reason.

**Inferred, not cited:** that A was chosen *deliberately* on 2026-08-04 rather
than arrived at. `c9d3643` writes to the projects tree with no comment defending
it, and no research note survives. What is cited is that the law was extended to
bless it the same day (`57ecfe1`), which is hard to read as an accident.

## Consequences

- **Good — the feature works.** A forked arm is resumable by the harness that
  produced its parent, with no migration step and no second copy.
- **Good — the write surface is still enumerated and tested.** One extra root,
  named in `isAllowedWrite` and asserted against a real fork's writes, so
  deleting the permission reddens the law rather than silently widening it.
- **Good — it composes with what already reads that tree.** ADR-0020's migration
  and ADR-0023's `checkClaudeProjects` probe both already treat
  `~/.claude/projects` as a real location the instrument knows about.
- **Bad — the instrument writes into a directory it does not own.** A user
  clearing `~/.claude/projects`, or a harness that changes its layout, destroys
  or orphans lab output. Nothing warns them, because nothing there is labelled as
  lab output.
- **Bad — the slug is a compatibility surface, and it has already broken.**
  ADR-0005 flagged this as *"Neutral"* at the time. It has since been a real
  defect twice, and both fixes narrowed the same gap: `4fc97f3` (2026-08-24) so a
  repo path containing a space finds its transcripts, and `9ae3705` (2026-08-27)
  which replaced a six-character substitution with the whole non-alphanumeric
  class — the shape ADR-0005 predicted when it noted the `.` → `-` mapping was
  missing. The Windows `\` and `:` half was added from an *observed* slug
  directory rather than assumed. Every future divergence in Claude Code's slugger
  is a silent read of the wrong directory.
- **Bad — one document is WRONG, and it is the trust document.** Four describe
  the other posture, but they are not equally at fault and an earlier draft of
  this record said "four documents are now wrong", which its own Neutral entries
  below contradict. The honest breakdown: prd-12 ruling 1's parenthetical and
  ADR-0005's root claim are **superseded and narrowed** respectively — recorded
  below, not defects; the containment law's docblock is **silent**, which is a
  gap rather than a falsehood. `README.md`'s Trust section is simply **wrong**:
  it says these artifacts *"live beside"* the lab worktrees dir. prd-12 ruling 1
  invokes the honesty bar for exactly this — *"The Trust section documents both
  hands separately — what the laboratory writes, exactly where"* — so the one
  document telling a reader the wrong location for their own data is the one
  whose entire purpose is to be trusted. That correction is downstream of this
  record and is the reason to write it.
- **Neutral — prd-12 ruling 1's parenthetical is superseded, not violated.** The
  binding clause is "OUTSIDE the watched repo", and `~/.claude/projects` is
  outside it. What diverges is "the same data-directory posture as the event log",
  which was guidance about where, not a boundary. A shipped PRD cannot be edited,
  so this record is where that divergence lives.
- **Neutral — ADR-0005's "compares paths against this root" is narrowed.** It
  remains true of the event log and of `data/`; it was never true of the
  synthesized sessions, from the day they were implemented.

## Confirmation

How to verify this decision is actually being followed, rather than assumed:

- `packages/server/src/lab/namespace-law.test.ts` drives a real `captureCheckpoint` + `dispatchFork`
  and filters every added path through `isAllowedWrite`. A lab write outside the
  two named roots plus the `.git` administrivia fails the build.
- The allowlist entry cannot be removed as tidy-up: the same test's real-fork
  writes land in `claude-projects`, so deleting the clause reddens it.
- What is **not** covered, and should be said plainly: nothing asserts that the
  instrument's slug still matches the harness's. That correspondence is checked
  by neither side, and `4fc97f3` / `9ae3705` are what it looks like when it
  drifts — found by a user hitting it, not by a test.
