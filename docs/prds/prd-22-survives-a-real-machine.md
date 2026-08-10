# prd-22 — collector resilience: the instrument survives a real machine

> **Status:** proposed

## Problem

A stranger runs rhizomorph on a machine the author has never seen: spaces in filenames,
a dot in a directory name, a tmux server that died with the last pane, a worktree removed
by hand. It does not fall over in any way they would notice — it goes quiet, or it keeps
drawing a calm dashboard that is no longer true, and nothing says which. Restart-and-hope
is the only recovery and looks identical either way. The cost lands on the cohort members
the handover is for, who must tell "nothing is happening in my fleet" from "I can no
longer see my fleet".

## Evidence

- The six-strategy review of `1bed433` (`docs/review/README.md` §3–4) filed #236, #237,
  #239, #240, #241, #242, #243; two of §4's findings were never filed at all.
- `timeoutMs` has exactly **two** non-test occurrences (`core/src/collector.ts:15`,
  `server/exec.ts:16`) and no caller sets either, so one wedged child stalls every
  collector via the in-flight gate `stop()` awaits too (`poll-loop.ts:121-127`, `:143`) (#236).
- The catch that *reports* a failure awaits `record()` unguarded (`poll-loop.ts:106-115`),
  so a rejected append kills the process; the rotation seal is taken before its write
  (`session-recorder.ts:94-102`), hanging every later `record()` on a throw (#239).
- `createSessionlogCollector` is built outside `loadCollectors` (`cli/run.ts:125-133`), so
  it never gets the wrap `collector-loader.ts:57` gives the rest; one failed `stat`
  latches it forever (`sessionlog/collector.ts:551`) (#240).
- `parse-status.ts:15` takes the rest of the line, but git C-quotes any path with a space
  or non-ASCII byte, so escapes reach the collision matrix (#237), while
  `list-panes.ts:35` (a tab in a pane path) and `parse-log.ts:70` (a malformed `--raw`
  line) throw, aborting the whole poll, every tick (#242).
- `git-collector.ts:262-267` carries the last dirty set forward on any failure, so a
  deleted worktree renders healthy indefinitely (#241); three identity joins miss silently
  — workmux's key/lookup mismatch (`workmux/collector.ts:92`, `:110`), the slug's unmapped
  `.` (`worktree-slug.ts:9`), a detached main HEAD (#243).

## Success

With each source made to misbehave by a stub: a hung child is abandoned within its budget
while other collectors keep polling and `stop()` returns; a failing collector reads
`degraded-retrying`, then `disabled` **with a reason**, and re-enables on the next success
with no restart — sessionlog included; a gone entity leaves the dashboard within two polls
with an event saying so, and an unparseable record is the only thing missing, counted.
**Not met while** any collector is built outside the resilience wrapper, any subprocess
runs untimed, or the `git status` fixtures contain no quoted path.

## Non-goals

- **Not a collector rewrite, and no new signals.** Same collectors, same `poll` contract,
  same snapshots; this names absences, it does not add facts.
- Not #192 (WAITING vocabulary) or #223 (staleness voice) — related, not superseded, both
  stay open: this PRD names a source's failure, those decide how it is spoken.
- Not #213 (bounded resources), #234/#235 (auth, the Host check), or #245 (the lab's
  boundary) — adjacent in the review; no ruling here depends on them.

## Rulings

*All six are **proposed**. None has been put to an operator and none should be read as
decided; where a ruling needs a human call, its own text says so.*

## Ruling 1 — no unbounded subprocess, no unabandonable tick, no unstoppable shutdown

`exec` gets a default `timeoutMs`, the loop a per-collector budget so an overrunning tick
is dropped rather than awaited, and `stop()` abandons it and returns — all three or none,
since what cannot be stopped cannot be restarted. *Rejected:* `execFile`'s `timeout`
alone, blind to a child that ignores SIGTERM.

## Ruling 2 — a failing collector reads as a named absence, never as silence

`collectors/resilience.ts` is already the right policy; what fails is its **reach** —
applied by hand at one seam (`collector-loader.ts:57`), and the fifth collector was added
outside it. So the wrap becomes unavoidable: the loop accepts only wrapped collectors.
`degraded-retrying` is likewise folded (`core/src/state.ts:136`) but voiceless, since only
`disabled` builds a gap (`web/src/fleet/gaps.ts:66-70`) — a retrying source must say so,
though **where and how loudly is the leads' call**. *Rejected: per-collector retry logic*,
which #110 removed.

## Ruling 3 — the fold distinguishes "gone" from "unchanged", in both directions

ENOENT on a worktree's `cwd` is not a transient. An entity proven absent is dropped and its
removal is an event; carry-forward survives genuine transients only, and is **bounded**.
Mirrored: a non-ENOENT workmux failure yields an empty parse (`workmux/collector.ts:88-90`)
and every agent vanishes unannounced. *Rejected: dropping carry-forward*, which flaps on a
real `git worktree remove`. **Needs the leads' call** — the honest form is likely a new
event type, touching prd17 ruling 3.2's golden-corpus law.

## Ruling 4 — a parse failure quarantines one record, never the collector

prd17 ruling 3.1 is already law for the record format: an unrecognized line is COUNTED and
VOICED, never dropped silently or fatally. Collector parsers throw instead, taking the
whole poll with them. The rule now binds them too. *Rejected: total parsers* — accepting
any field count hides a real format change from a git or tmux upgrade; a skip does not.

## Ruling 5 — path and identity handling is byte-honest, decided per command

`-z`/NUL where a command offers it, unquote-on-parse where it does not, chosen **per
command**: `git worktree list --porcelain` quotes neither spaces nor unicode (#237
verified), so `parse-worktrees.ts` must not be "fixed". The same honesty covers rename
splitting on the first ` -> `, the slug transform, and the workmux join key, so #243
belongs here. *Rejected: a display-safe normal form* — the matrix compares paths across
lanes, so lossy is wrong.

## Ruling 6 — the reporting path is never the crash path, and a seal always releases

Reporting a failure degrades to a log line and never propagates; the seal releases in a
`finally`, or is taken only after the write succeeds. An instrument whose error path is
its crash cannot report what it exists to report, and a recorder that seals itself looks
exactly like health. What the operator *sees* then is not ruled here.

## Sequencing (waves, each gated as ever)

1. **Keystone:** #236 (subprocess budget, loop watchdog, bounded shutdown) and #239 (the
   report path cannot crash; the seal releases). Nothing below is demonstrable while one
   hung child can freeze the loop.
2. Parallel, fenced apart: #240 (the wrap becomes unavoidable, sessionlog inside it) ·
   #242 (counted-and-voiced parse skips) · #237 (byte-honest paths) · #243 (the three
   identity gaps).
3. #241 (gone vs unchanged), after ruling 3's event shape is settled — plus **two issues
   that do not yet exist**, described not numbered: *the honest middle's voice* (ruling 2's
   second half has none), and *the two §4 findings never filed* — a truncated or rotated
   session log is never re-read (`sessionlog/tail.ts:26` returns the stale offset when
   `size <= offset`), and ruling 3's workmux mirror case.

## Open questions

- Where "I can no longer record" renders. Ruling 6 keeps the process alive but says nothing
  about what the operator sees. Open, not ruled.
- Ruling 1's budget against the disable threshold: three failures at a 30s re-probe is ~90s
  of calm dashboard before a name appears. Honest, or too slow? The leads'.
- Whether the carry-forward window is ticks or a duration, whether a timed-out tick counts
  toward consecutive failures, and where a byte-carrying fixture beats a stub.
