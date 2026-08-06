# Replay

Replay is a full mode shift, not a tinted live view: the attention strip is
replaced outright by a REPLAY banner (timestamp, session identity, an "Exit
to live" button) in an ice-register frame — never a ladder hue, so a
recording can never be mistaken for a live summons. Live and replay share one
reducer, so every panel freezes to the scrubbed instant exactly as it would
live.

## Getting into a recording

The replay bar has a one-click button that jumps straight into playback of
the recorded session with the most history — its exact label:

> **Replay this session's birth**

(If no sessions are recorded yet, the same button reads **No recorded
sessions yet** and is disabled.) Beside it: a session dropdown — named by an
operator label if one was set, else the auto-title `rhizomorph sessions`
also shows, never a bare timestamp — and a speed control with three exact
steps: **1x**, **4x**, **16x**.

## The dock

Underneath the transport sits the dock: a sparse chapter-mark lane above the
scrubber, one mark per lane-born/landed/gate-held/summons/session-boundary
moment, coalescing into a `×N` count under density the same way everything
else in this app coalesces rather than invents.

- **Hover** a mark (or a cluster) for a card naming who/what/when for every
  member — mounted straight to `document.body` rather than nested in place,
  so no ancestor's clipping or stacking context can bury or cut it off.
- **`Shift`+wheel** zooms the mark lane about the *cursor's own timestamp* —
  never the whole scrubbable range, which stays full-width always.
- **`[` / `]`** step to the previous/next chapter mark.
- The **scrubber** itself is a real range input with a genuine step value (not
  the browser's 1ms default); dragging it shows the nearest chapter's label
  above the thumb, plus elapsed/remaining labels below.

What prd13 shipped and then walked back: a per-lane density band (a state-fill
strip, one row per lane) was cut outright on 2026-08-06 — *"get rid of the
working green strips entirely"* — because it still read as noise to the one
person using it after three rounds of fixes. What's left today is exactly the
marks, the axis, and the transport; nothing else.

## What a recording contains

A session record is one append-only, hash-chained event log — `manifest` +
`body`, where every `body` entry is the *exact, verbatim* line from the event
log, not re-serialized. The chain proves nothing was altered after export; it
doesn't prove who produced it. An unrecognized-but-well-formed event line
from a future era is never silently dropped — it's counted and preserved
byte-for-byte, and replay says so in words:

> "N events from a newer era were preserved but not understood (...)"

Replay reads a lane's *captured* transcript copy first (written when a
session closes) and falls back to live resolution only for the still-open
session — so a recording replayed in a year, on any machine, still shows
conversations that happened. If a session's transcripts couldn't be fully
captured, it says so precisely (`manifest.complete: false`) rather than
silently producing a conversation-less recording. See
[sessions.md](sessions.md) for how that capture actually happens.

## What a recording does NOT contain

- **No thinking blocks.** Never emitted, at any point.
- **Truncated tool results, declared, not hidden.** A tool result is
  truncated at 400 characters and *declares* the cut (`dropped`) rather than
  silently trimming — you're told the tool said more than you're shown, not
  left thinking it said less.
- **No live process state, no re-execution.** Read-only in both directions:
  exporting a record never touches the watched repo, and replaying one never
  executes anything — no collector runs, nothing is written back into the
  record file itself.
- **Nothing auto-transmits.** No push, no server-to-server exchange, no
  background sync — a record only ever moves because you handed the file to
  someone (`rhizomorph export-record`, see [`docs/record-format.md`](../record-format.md)).
- **Nothing beyond what was already redacted going in.** A record contains
  exactly what the log contains — whatever privacy allowlisting a collector
  applied before a line ever reached the log is what ships. See
  [sessions.md](sessions.md#capture-redaction) for exactly what gets scrubbed.
