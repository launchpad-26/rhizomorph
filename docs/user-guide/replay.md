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
`body`, where every `body` entry is one line of JSONL re-serialized from a
parsed, schema-validated event, not a byte copy of the log file. For a line
the current event schema wrote, the two are the same text; a field that
schema no longer declares can't ride an old log line into a new record.
Records already on disk are never rewritten — they keep, and verify against,
the lines they were built with. The chain proves nothing was altered after
export; it doesn't prove who produced it.

An unrecognized-but-well-formed event line from a future era — one whose
envelope reads but whose `type` this build has never heard of — is counted and
preserved byte-for-byte in the **session log** and on the **replay path**, and
replay says so in words:

> "N events from a newer era were preserved but not understood (...)"

It does **not** reach a record newly exported by this build. Both export paths
parse the log first, and a line the current schema can't parse is skipped
before the record is built — while `eventCount` still matches `body.length`,
so the short record reads complete and nothing names the gap. That is a known
follow-up, not the intended final behaviour: see
[follow-up-292.md](../follow-up-292.md).

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
- **No field the current event schema no longer declares — and nothing else
  is taken out.** Because a record's body is re-serialized from parsed
  events, a key the schema has dropped can't ride an old log line into a new
  record: that is how a legacy `pane.activity` `preview` (the last line of a
  tmux capture, removed by #292) is stripped out of a record built from a
  pre-#292 log. That is the whole of the filtering. A record is not scanned,
  scrubbed or anonymised, and it still carries pane and window titles,
  `agent.status.detail`, absolute paths including your home directory and
  username, commit subjects with the author's name and email address, branch
  and lane names, verbatim stderr from a failed git or tmux command, and
  symbol names lifted from your own diff. Read
  [SECURITY.md](../../SECURITY.md#what-a-shared-record-contains) for the full
  list before you hand a record to anyone. (The scrubbing described in
  [sessions.md](sessions.md#capture-redaction) is a different path: it
  applies to *captured transcripts*, not to the event log a record is built
  from.)
