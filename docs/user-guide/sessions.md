# Sessions

A session is a bounded, operator-bounded episode — recording is always on
from the moment the server starts (no opt-in flag, no way to run it without
recording), but *what decides when one recording ends and the next begins is
your own explicit act*, never a collector, a lane, or a clock.

## What bounds a session

- **`--fresh`** forces a new session on boot instead of resuming.
- **`--resume-window <ms>`** sets how long a gap may be before the previous
  session counts as over — default 4 hours (`14400000`ms); `--resume-window
  0` behaves exactly like `--fresh`.
- The **default** resumes whatever session is still inside that window —
  same file, same collector offsets, no duplicated history.

Every recorded session lives at
`~/.local/share/rhizomorph/<repo-slug>/session-<id>.jsonl` — the exact path
is printed at boot. Nothing here ever touches the repo you're watching.

## The session lock

Two instances can't race onto the same log. Each boot claims a
pid+heartbeat lock beside the session file
(`session-<id>.lock.json`), refreshed every 5 seconds. A lock is
considered stale (abandoned) once its heartbeat is more than 20 seconds old
*or* its pid is confirmed dead — whichever is caught first. What happens
next depends on which:

- **A live lock** (fresh heartbeat, pid alive) — the new boot refuses to
  resume and starts a fresh session instead, both at the boot line and in
  `rhizomorph doctor`:
  > `session <id> is being written by a live instance (pid <pid>) —
  > starting a fresh session <newId> instead; use --fresh to silence, or
  > stop the other instance`
- **A stale lock** — treated exactly as if there had been no lock at all;
  the boot proceeds to resume normally.

See [troubleshooting.md](troubleshooting.md#stale-session-lock) for what to
do if this fires when you didn't expect it to.

## Ending a session on purpose

`rhizomorph rotate` (a thin HTTP client to the *running* instrument — never
a second process touching the log file directly) asks it to close the
current log and open the next one:

```
closed session <id> — <n> events, flushed to <path>
opened session <id> — recording to <path>
```

The dashboard has the same action as a two-step button, to avoid an accidental
click: **end session · start fresh** → click → **confirm: end session** →
click → **ending session…**.

On close, each lane's live transcript is copied into that session's own
artefact directory
(`~/.local/share/rhizomorph/<repo-slug>/transcripts/<session-id>/`), so a
recording replayed later — on any machine — still shows real conversations.
If any lane's transcript couldn't be found and copied, the recording says so
precisely rather than pretending nothing happened:

> `TRANSCRIPT NOT CAPTURED for "<lane>" — none of the paths the sessionlog
> collector tails (<paths>) had this lane's transcript at session close, so
> nothing could be copied — the conversation for this lane is not in this
> recording`

and the whole session's `manifest.complete` is `false` the moment any
attributed lane didn't make it in.

## Capture redaction

Every captured transcript line is redacted *on the way in*, before a byte
ever reaches disk — the same rule the live event log already follows
(privacy allowlisting happens before an event is built, so the recording is
never a second copy with more in it):

- **Structural redaction** — any JSON key matching an identity field
  (`userId`, `userUuid`, `accountId`, `accountUuid`, `organizationId`,
  `organizationUuid`, `orgId`, `orgUuid`, `email`, `userEmail`, `hostname`,
  `machineId`, case-insensitive) has its value replaced with `[redacted]`.
- **Text scrubbing** — email addresses become `[redacted-email]`; any
  `/home/...` or `/Users/...` path becomes `/redacted-path`; NUL bytes are
  stripped.

A redacted capture still replays exactly like the original — redaction never
changes the shape of the transcript, only the identifying values in it.

## `rhizomorph sessions` and `/recordings`

```sh
npm start -- sessions .
```

`[Ran]` against this repo:

```
ID             TITLE                                                WHEN                 DURATION  LANES  LANDED  OUTPUT  COST          SIZE
-------------  ---------------------------------------------------  -------------------  --------  -----  ------  ------  ------------  ------
1785975801972  2026-08-06 · 9 lanes · 0 landed · #205 #209 #214 +6  2026-08-06 00:23:21  36s       9      0       7.9K    $0.34 (est.)  47.5KB
```

Lists every recorded session, newest first, each with a title *derived from
its own events* (or `no recorded sessions yet` when there are none). The same
rows, plus rename-in-place and export, live in the dashboard's own
**`/recordings`** page (direct URL — see [watching.md](watching.md#navigating-away)
for why there's no nav link to it yet). Its own subtitle states the job
plainly: *"what this instrument recorded — rename it, open it in replay, or
export the portable record."* It renders only what was recorded, never the
live fleet — a law its own source-grep test holds it to.

- **Rename** — click the title, edit in place, save. Writes a sidecar file
  next to the log (`session-<id>.label.json`) — the append-only log itself
  is never mutated. Equivalent CLI: `rhizomorph label <sessionId> "<text>"`.
- **Open in replay** — jumps straight into scrubbing that session; see
  [replay.md](replay.md).
- **Export** — downloads the portable record (manifest + hash-chained log,
  captured transcripts included when the recording has them). Equivalent
  CLI: `rhizomorph export-record [--session <id>] [--out <path>]` — see
  [`docs/record-format.md`](../record-format.md) for the file format, and
  note it refuses to write inside the watched repo.
