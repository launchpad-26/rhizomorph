# 0020. Transcript migration is one create-only copy into the watched repo's slug directory

- **Status:** accepted
- **Date:** 2026-08-14

## Context and Problem Statement

> Written at decision time, from prd-20 ruling 6 and the spike that preceded it.
> Every empirical claim below is cited to `research/2026-08-14-cross-host-resume.md`,
> where the command and its raw output are reproduced verbatim.

ADR-0019 granted the concierge two powers: launch or relaunch a conductor
process, and clone a repo to disk. prd-20 ruling 3 binds the first of them to
honesty — the shop never claims to attach to a running process; it offers
**relaunch with continuity**, and names what continuity means and what is lost.

That promise has a hole in it that only shows up off the happy path. `claude
--continue` resumes the newest conversation *of the current working directory*,
because Claude Code stores session transcripts under
`~/.claude/projects/<cwd-with-separators-as-dashes>/<sessionId>.jsonl` and
resolves `--resume` strictly within the slug directory of the cwd it is
launched in — established by the spike's Q1 control, which failed to resume an
id that existed in two other slug directories. So the operator whose
conversation is the reason they came to the front door — the one they had in
another checkout, or on another machine — is offered continuity the instrument
cannot actually give them. Relaunching in the watched repo starts from nothing.

The mechanism that would close it is small enough to be suspicious: put the
file where the CLI will look. The spike tested whether that is the whole
mechanism, and the answer to all four questions was GO:

- Copying a transcript into another cwd's slug directory and resuming there
  **works**, same-host and cross-host — a Windows-authored transcript whose
  `cwd` fields read `C:\Users\operator\agenticlaunchpad` resumed cleanly on Linux,
  and historical `cwd` values are never rewritten by the resume (Q1, Q2).
- The resume **appends in place and preserves the sessionId** — no fork, no new
  file, and the source file is neither grown nor touched (Q3).
- OTLP telemetry from the resumed process **books under that same preserved
  sessionId** (Q4), so a migrated session keeps one identity across the
  transcript filename, the in-file `sessionId`, and the event log.

Two caveats came with the verdict and are load-bearing here. The behaviour is
undocumented and unversioned, verified on Claude Code **`2.1.232`**, whose
session-log format `CHANGELOG.md`'s own semver policy leaves free to change
release to release. And both transcripts exercised were tiny; large transcripts,
and tool *results* containing absolute Windows paths, were not tested.

So the question this record answers is not "does it work" — the spike settled
that — but **what write the fourth hand is granted in order to do it**, given
that the destination is the operator's own `~/.claude` and the source is a file
another live process may still be appending to.

## Considered Options

- **A — No migration power.** Keep ADR-0019's two powers. The front door offers
  `--continue` where the conversation already lives in the watched repo, and
  honest emptiness everywhere else.
- **B — Move the transcript, or symlink it into place.** One file, one place,
  no duplicate history to diverge.
- **C — A general grant: the concierge may write under `~/.claude`.** Copy,
  tidy, prune, fix up — a harness-state hand.
- **D — Copy exactly one attributed transcript to exactly one derived
  destination, create-only.**
- **E — Copy, and rewrite the transcript on the way in** — `cwd` fields
  retargeted to the watched repo, so the migrated file is internally
  consistent.

## Decision Outcome

Chosen: **D**, and it is an amendment to ADR-0001 in ADR-0019's own form: the
grant is one further write, named, fenced, and testable — *each grant is an
amendment, not a loosening*. A fifth power still costs a fifth argument.

The grant, in full:

1. **One write, named.** The concierge may COPY a session transcript into the
   harness state directory for the watched repo —
   `~/.claude/projects/<watched-repo-slug>/<sessionId>.jsonl` — and nothing
   else. It never overwrites, never deletes, never edits a line, and never
   writes anywhere else under `~/.claude`.
2. **The source is derived, not supplied.** It is one of the paths
   `candidateTranscriptPaths` derives from the event log's own attribution
   (`log/transcript-attribution.ts`) — the session id the log recorded, in the
   worktree the log recorded, under a projects root the operator named. There
   is no parameter through which a caller can name a file. That is why
   `assertMigrationPaths` returns its two paths rather than validating one: the
   only way to make an arbitrary source unrepresentable is to not accept one.
3. **Create-only, and the guarantee is the flag.** The fence refuses a
   destination that exists, a dangling symlink included — but that is a
   check-then-write and therefore a TOCTOU by construction. The actual
   guarantee is `COPYFILE_EXCL` on the `copyFile` itself, pinned as clause 6 of
   `concierge/namespace-law.test.ts` before the copy is written.
4. **Explicitly invoked, like the other three.** The copy runs only from the
   same human act that requests the resume — never from a collector, never
   from a poll, never on a timer. ADR-0019 grant 3, unchanged and unweakened.
5. **The original is never touched and the original process is never stopped**,
   and the UI says both, every time. See the Consequences: this is the honest
   cost, not a footnote.
6. **Its own law clause**, appended to the hand's existing namespace law, live
   against real directories — the fence lands before the copy does, so it is
   never fitted around whatever got built.

**A lost to evidence, not to appetite.** It is the status quo, and it would be
the right answer if the mechanism were speculative — which is exactly why the
spike ran first (#513). Four GO verdicts with reproduced output make "we cannot
do this" false, and prd-20 ruling 3's whole posture is that the front door
names what is real. Declining a continuity the instrument demonstrably has is a
different kind of dishonesty from claiming one it does not.

**B lost on the one property that makes this safe.** The spike's Q3 proves the
source file is untouched by a resume, which is what makes the origin a valid
rollback — the operator can always go back to the process they already have.
A move destroys that, and worse: the origin process may still be running and
appending to that exact file. A symlink is the same hazard with an extra edge —
two live processes appending through one inode, and a `~/.claude` entry whose
meaning depends on a mount that may not survive a reboot. A copy is the only
form of this power where a mistake costs disk and not history.

**C lost for the reason ADR-0019 rejected its own Option A.** "May write under
`~/.claude`" is a configuration-shaped grant: nothing structural stops the next
feature adding a prune, and the published trust claim — four hands, each with
what it may write named — becomes untestable prose. The amendment has to name
the write or it is a loosening.

**E lost to the spike, and it is worth recording that it lost to a measurement
rather than to taste.** Rewriting `cwd` looks like the tidy thing to do, and
was the expected failure point going in. Q2 shows mixed `cwd` values within one
file are tolerated, Windows spellings included, and that the CLI writes new
lines with the live `cwd` while leaving historical ones alone. So a rewrite buys
nothing — and it would make this hand the only one that *edits* a conversation,
which is a far larger claim than copying one. The instrument does not get to
revise history it did not write.

## Consequences

**Good.** The operator's actual conversation reaches the instrumented process.
The session keeps one identity end to end — transcript filename, in-file
`sessionId`, and telemetry attribution all agree (Q3, Q4) — so the migrated
session is not a stranger in the event log.

**Good.** The fence is derivation, not validation. The clone fence
(`assertCloneTarget`) judges a path a caller composed, and its own doc admits
the refusal is not structural today: a lane could build the argv and never ask.
`assertMigrationPaths` cannot be walked round the same way, because there is no
path to hand it. The two fences share `concierge/paths.ts` and one containment
primitive deliberately — #401's lesson is that a security predicate with two
homes gets hardened in one of them.

**Bad — the old process keeps running, and that is a fork.** The copy stops
nothing. Whatever the operator types in the origin process after the copy
belongs to a conversation this instrument sees only through its transcript
tail, never through telemetry, and the two histories diverge from the moment of
the copy with no marker in either file saying so. The mitigation is honesty at
the moment of the act — the UI names it — not a mechanism, because the only
mechanisms available are killing someone else's process or refusing the feature.

**Bad — telemetry never back-fills, so continuity of conversation is not
continuity of measurement.** The resumed process is instrumented from its first
turn and no earlier. Every token, every dollar and every tool call the origin
already spent is outside this instrument's record permanently — `docs/telemetry.md`'s
"instrumentation attaches at launch" applied to the one case where the
conversation makes it look as though it did not. prd-20 ruling 3's bar is that
this is *said*, not that it is fixed.

**Bad — this rests on an undocumented format, pinned to one CLI version.**
Verified on `2.1.232`. The session-log format is explicitly free to change, so
the spike is a dated artefact and re-running it belongs to any harness upgrade.
The failure mode is not silent, at least: a slug directory or a transcript the
CLI no longer recognises produces `No conversation found with session ID`,
which is also what a missing file produces — so a caller cannot distinguish the
two from the exit status, and must validate before migrating rather than read
the resume's error text (spike item 4).

**Bad — the evidence has a hole where the real transcripts are.** Both
transcripts resumed were 2–15 lines. Large ones, and tool *results* carrying
absolute Windows paths, were not exercised, and the spike names those as the
most likely place for a latent problem. Wave 6 should not treat "no rewriting
needed" as settled for a real conductor transcript until one has been through.

**Neutral — the destination is slugged from the watched repo's *real* path.**
Claude Code slugs its own `process.cwd()`, which Node has already resolved, so
on macOS `/var/…` and `/private/var/…` produce two different slugs and only one
of them is ever read. The fence canonicalizes before slugging. This is the
#217/#228 shape in a new place, and the macOS CI leg is where it would surface.

**Neutral — one more file under the operator's `~/.claude`.** Migration leaves
a duplicate transcript behind by design (that is the rollback). Nothing prunes
it, and nothing should: pruning is a delete, and a delete is not in this grant.
