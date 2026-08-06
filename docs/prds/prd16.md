# prd16 — the session is a thing you can hold: rotation, capture, and a library

**STATUS: BLESSED** — operator, 2026-08-06: *"there is still the question of
what defines a session, and what defines what is recorded and what is part of a
'session'. There should be some kind of control for this… of note, the session
logs should keep the conversation transcripts, trace, etc accessible if it's
replayed."* Ruled the last work before the laboratory, because prd12's
checkpoints bind to session positions and prd14's experiments ARE sessions —
session identity has to be solid before either.

This prd closes #182's reserved ruling rather than deferring it into prd14.

## What already exists (do not rebuild)

- **Boot-time session identity** — `decideSessionBoot` + `RESUME_WINDOW_MS`,
  made self-explaining and controllable by #180 (`--resume-window`, boot
  reason, resumed count, doctor line) and made collision-safe by #187 (the
  pid+heartbeat lock: two instances can no longer share one log).
- **Labels** — `log/label.ts`, an operator label in a SIDECAR beside the log,
  never inside it, because labelling a recording must never mutate an
  append-only event log. `rhizomorph label` writes it.
- **Listings** — `log/listing.ts` `SessionListing` (title, label, lanes,
  landed, durationMs, outputTokens, costUsd, costIsAuthoritative) behind
  `GET /api/sessions`, already feeding the replay picker.
- **The portable record** — `packages/core/src/record/` (build, hash, merge,
  verify, schema): manifest + the event log's lines verbatim under a hash
  chain, prd11's federation wire format.

## Ruling 1 — a session is a bounded episode of watching, and the operator bounds it

A session is one continuous stretch of the instrument watching one repo,
identified by the id minted at its start. Its boundary is decided three ways,
in this order of authority: **the operator's explicit act** (ruling 2), then
`--fresh` / `--resume-window` at boot, then the resume-window default. Nothing
else may split or splice a session — in particular no collector, no lane, and
no clock.

**What belongs to a session:** every event its collectors recorded between its
start and its close, and — new in ruling 3 — the transcripts those events
refer to. Nothing else. A session is not "everything on this machine in that
window"; it is what this instrument witnessed.

## Ruling 2 — THE OBSERVER GAINS A THIRD HAND: rotation (constitutional amendment)

prd12 amended the read-only constitution into two hands (the observer, absolutely
read-only; the laboratory, an explicitly-invoked second actor). This prd adds a
third, narrower than either:

- **The recorder's hand** may close the current session log and open a new one,
  on an explicit operator command, writing ONLY inside rhizomorph's own data
  directory (`~/.local/share/rhizomorph/<repo>/`). It never touches the watched
  repo, never a ref, never a worktree, never `~/.claude`.
- **It is exposed as a UI button** ("end session · start fresh"), which is an
  explicit human invocation — the same logic prd12 used to permit the lab's
  button. No background process of the observer may invoke it.
- **The observer's read-only law over the WATCHED REPO is untouched and
  absolute.** The distinction the Trust section must make plainly: the observer
  has always written its own recording; what changes is *who decides when a
  recording ends*. That is not new authority, it is an existing authority made
  operable.
- **The amendment ships with its law tests**: the existing readonly greps stay
  green untouched; a new rotation-namespace test asserts every write path of
  this hand lands under the data directory and nowhere else — the same shape as
  `lab/namespace-law.test.ts`.

## Ruling 3 — a recording is self-contained: transcripts are CAPTURED, not resolved

The gap this prd exists to close: traces replay perfectly because they ARE
events (`trace.span`), while transcripts are resolved live from
`~/.claude/projects` at read time. A replayed session's conversation is
therefore only as durable as an external directory, and on another machine it
is simply gone.

- **On session close, each lane's transcript is copied into that session's own
  artefact directory.** A recording replayed in a year, on any machine, shows
  its conversations.
- **Replay reads the captured copy first**, falling back to live resolution
  only for the still-open session — one code path, one precedence rule, stated.
- **Capture is redacted by the same discipline the OTel fixtures got** (#177's
  hygiene law): identity fields scrubbed, with a law test over captured
  artefacts, because a recording is the thing most likely to be shared.
- **Capture is bounded and honest about cost**: transcripts are the bulk (one
  busy lane ran ~9 MB), so the capture reports its size, and a session whose
  transcripts could not be captured says so precisely rather than silently
  producing a conversation-less recording.
- The append-only law holds: captured transcripts live BESIDE the log, never
  inside it — the same sidecar posture labels already use.

## Ruling 4 — recordings get a real surface: `/recordings`

The replay picker is for choosing; managing needs a room. A route listing every
recording with what `SessionListing` already computes — title, label, lanes,
landed, duration, tokens, cost, and whether cost is authoritative — plus:
rename in place (the label sidecar), open in replay, and export the portable
record (prd11's builder, already written).

This is a **library, not a second overview** — the dashboard-IA spike's warning
was against a second surface competing to answer "what is happening now", and a
recordings library answers "what did we record", which nothing else does. It
reuses the existing hand-rolled router (#135), adds no panel to the curated
order, and the scene remains the hero of the one overview.

## Ruling 5 — the lab inherits this, it does not redefine it

prd14's "begin experiment" IS ruling 2's rotation plus a label: an experiment is
a named session, so a fork's record is a bounded episode rather than a slice of
a mega-log. prd14 may add meaning on top (arms, comparison, checkpoints) but
must not invent a second session concept. #182 is hereby closed by this prd.

## Ruling 6 — the recorder seam is framed now (operator, 2026-08-06, on the council's advice)

The rotation lane draws a clean module boundary around the recording-writer —
its own module, its own namespace law — WITHOUT splitting the process. The
systems chair's argument, accepted: prd16 is the last cheap moment (the wall
is already open); if the forest or the agnosticism future ever wants the
recorder running separately, the doorway exists and nobody performs surgery.
No door is installed: one process, one binary, today and until a prd rules
otherwise.

## Sequencing

1. **Rotation** (ruling 2): the recorder's hand behind the ruling-6 seam, its
   namespace law, the CLI verb, and the UI button. Smallest constitutional
   footprint first.
2. **Capture** (ruling 3): transcript capture on close, replay precedence,
   redaction law, size reporting.
3. **`/recordings`** (ruling 4): the library, rename, export.
4. Then prd14.

## Non-goals

No automatic session splitting on any heuristic beyond the existing resume
window. No writes outside the data directory, ever. No deleting recordings from
the UI in this prd (a destructive action deserves its own ruling). No live
federation — records remain the cross-instrument answer (prd15 ruling 6).
