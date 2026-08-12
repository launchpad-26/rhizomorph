# Follow-up from #292 — what was deliberately left undone

#292 removed `preview` from `pane.activity`: the tmux collector no longer
puts any captured pane text on an event, and a record built now strips the
field out of pre-change logs. That closed the leak that was actually there.

The items below were identified while doing it and **deliberately not
implemented** — they are hardening and scope-narrowing, not fixes for a
live leak. Recorded here so a future issue can pick them up rather than
rediscover them. Nothing here is a known vulnerability.

## Laws that would keep the boundary from eroding

**4 — a no-open-payload law across `packages/core/src/events/`.** Every
payload schema there is a closed `z.object`, so zod strips what it does not
declare, which is the whole mechanism #292 relies on. A grep for
`.passthrough(`, `.loose(`, `.catchall(`, `z.record(`, `z.any(` and
`z.unknown(` across that directory currently returns **zero** matches — and
nothing tests that it stays zero. One open payload anywhere in there
silently turns the allowlist into a sieve, including for the record
builder.

**5 — a behavioural sentinel over `collectors/tmux/capture.ts`.** #292
deleted `lastNonEmptyLine`, the one helper that turned a capture into
shareable text. A test that exercises every export of that module for what
it *returns* — a hash, a count, nothing resembling the input's own
characters — would survive a rename, which a grep for the old function name
would not.

**6 — a single-call-site law for `capture-pane`.** Today the only place
that shells to `tmux capture-pane` is
`packages/server/src/collectors/tmux/collector.ts:102`. A test pinning that
to one non-test call site would close the escape where a new directory
grows its own capture path — which is not hypothetical:
`collector.ts:19-23` advertises future "footer/prompt heuristics over
captured pane text" as the way to raise the tmux collector's `attention`
capability. That is exactly the change that would want pane text on an
event again. Note the assertion has to be written over the *call*, not a
bare string match: `capture-pane` also appears in prose comments in
`collector.ts` and `capture.ts`, so a naive "exactly one file contains this
string" law fails today for uninteresting reasons.

## The free-form text a record still carries

#292's claim is narrow on purpose: no captured *pane content* enters an
event. A record is still not an anonymised artefact, and
[SECURITY.md](../SECURITY.md#what-a-shared-record-contains) says so. The
fields below are the ones that carry text a program, a shell or a person
wrote, and each would need its own decision:

- `pane.discovered.title` and `windowName` — free-form; the title was a
  hostname in this project's own era-1 capture (see
  `packages/core/src/eras/CAPTURE.md`)
- `agent.status.detail` — the workmux status line
- `judge.finding.evidence.symbols` — identifiers lifted from the user's own
  diff
- `commit.landed.author.name` / `.email`
- `collector.error.detail` and `collector.disabled.reason` — verbatim git
  and tmux stderr

One asymmetry is worth resolving first, because it is internally
inconsistent rather than merely permissive:
`packages/server/src/log/transcript-capture.ts:151` (`redactTranscript`)
scrubs email addresses and home directories out of every captured
transcript line before a byte reaches disk, on the stated grounds that a
transcript is "the artefact most likely to be shared" — while the event log
sitting beside it stores a commit author's email verbatim and ships it into
the same shared record.

Whatever is decided, note the blast radius is wider than the record:
`packages/server/src/api/stream.ts:21` writes `JSON.stringify(event)` to
the SSE stream, so any free-form field added to any event is on the wire to
every open tab, live, not only in an exported file.

## An unknown event line is dropped, not preserved

Found while correcting the "verbatim" claims in the docs, **not fixed here**
— it is a separate issue from #292 and wants its own change.

`docs/record-format.md:150-160` tells a reader that a well-formed line whose
`type` this era has never heard of is "counted and preserved verbatim, not
folded". That is the *reader's* contract, and replay honours it. The
*emitter* does not: on both export paths a line the current schema cannot
parse is discarded before `buildRecord` ever sees it — `parseJsonl` →
`parseEvent` on the CLI side, `parseEventLenient` → `parseEvent` on the web
side. Nothing dropped there reaches the body.

**Where the claim is still made, live in the tree.** Four places state it
about the *record* specifically; whoever picks this up should read all four
together rather than fixing one:

- `docs/record-format.md:150-160` — the reader's contract, above. True of a
  reader; says nothing about what this emitter writes, which is why it reads
  as a promise the record doesn't keep.
- `docs/architecture.md:1864-1866` — law 1, "preserved byte-for-byte in the
  log **and the record**". The "and the record" half is false on both export
  paths. **Still uncorrected**: this pass was deliberately scoped to leave
  `docs/architecture.md` alone, so the wrong wording is still in the tree and
  is inventoried here rather than fixed.
- `docs/prds/prd-17-complete-record.md:64-67` — ruling 3, law 1: "never
  silently dropped, and always preserved byte-for-byte in the log and the
  record". This is the **origin** of the `docs/architecture.md` wording above,
  and it lives in `docs/prds/`, not `docs/prds/done/`, so by this repo's own
  convention it is a live ruling rather than an archival one. Whether a PRD's
  text should be amended at all is a judgement for whoever owns the ruling —
  but it is the source, and fixing the two docs without reading it would leave
  the wording to grow back.
- `docs/user-guide/replay.md` — **corrected in this pass**. It now says the
  counted-and-preserved behaviour holds for the session log and the replay
  path, that such a line is skipped when a new record is exported, and points
  here for the open decision.

Borderline, and probably fine as written:
`packages/core/src/events/index.ts:202-204` says `UnknownEventLine.line` is
"the *exact* text that arrived, not a re-serialization … what makes a record
containing unknowns still hash-chain clean". That is true of a *foreign*
record read by an older build, which is the type's actual job. It is
misleading only if read as a claim about what this emitter writes, since this
emitter never puts an unknown into a body at all.

The reason this is worth an issue rather than a footnote is that the record
does not admit the loss. `packages/core/src/record/build.ts:69` sets
`eventCount: events.length` — the count of what survived parsing — so
`manifest.eventCount === body.length` holds, the record verifies clean, and
a reader is told the session is complete. A record exported by an *older*
build from a *newer* log therefore reads whole while being short, and no
field says how many lines were skipped. Deciding what should happen
(carrying the raw line into the body, or counting the skips and declaring
them the way `manifest.complete: false` declares missing transcripts) is the
actual work.
