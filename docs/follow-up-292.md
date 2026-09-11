# Follow-up from #292 — what was deliberately left undone

#292 removed `preview` from `pane.activity`: the tmux collector no longer
puts any captured pane text on an event, and a record built now strips the
field out of pre-change logs. That closed the leak that was actually there.

The items below were identified while doing it and **deliberately not
implemented at the time** — they are hardening and scope-narrowing, not fixes
for a live leak. Recorded here so a future issue can pick them up rather than
rediscover them. Nothing here is a known vulnerability.

This is therefore a ledger rather than a standing list of undone work, and it is
read that way: **item 4 has since been picked up and is kept below as one
discharged line**, because deleting it would lose the fact that the law exists
and where it lives. Everything else here is still open.

## Laws that would keep the boundary from eroding

**4 — a no-open-payload law across `packages/core/src/events/` — DISCHARGED.**
`packages/core/src/events/no-open-payload-law.test.ts` is that law, and it is
exactly the shape this item asked for: it greps the directory's own source text
for all six spellings — `.passthrough(`, `.loose(`, `.catchall(`, `z.record(`,
`z.any(`, `z.unknown(` — and proves its own detector against a rigged schema
rather than trusting a green run on real files. Its header records the failure
mode this item predicted, met and fixed in the writing: a first version bound
eleven files in by name, so a twelfth file containing
`z.object({…}).passthrough()` left every test there green; it walks the
directory with `import.meta.glob` now.

**5 — a behavioural sentinel over `collectors/tmux/capture.ts`.** #292
deleted `lastNonEmptyLine`, the one helper that turned a capture into
shareable text. A test that exercises every export of that module for what
it *returns* — a hash, a count, nothing resembling the input's own
characters — would survive a rename, which a grep for the old function name
would not.

**6 — a single-call-site law for `capture-pane`.** Today the only non-test
place that shells to `tmux capture-pane` is
`packages/server/src/collectors/tmux/collector.ts:163` — one
`context.exec('tmux', [...])` inside the per-pane loop. A test
pinning that to one non-test call site would close the escape where a new
directory grows its own capture path. The *motive* has moved since this was
written, and restating it is fairer than leaving the original wording:
`collector.ts:19-27` no longer advertises footer/prompt heuristics as a future
way to raise the tmux collector's `attention` capability — it states them as
today's reason for a partial one, `reason: 'footer/prompt heuristics over
captured pane text, not a declared status'`, with `remedy: 'pair with the
workmux collector for declared agent.status'`. The declared route up is
therefore workmux's status line rather than more pane text, which makes the
pressure toward putting captured text back on an event weaker than this item
first argued. The item stands anyway: no test names the single call site, so
nothing structural stops it, and a capability sitting at `partial` is the kind
of gap a later change reaches into. Note the assertion has to be written over
the *call*, not a bare string match: `capture-pane` also appears in prose
comments in `collector.ts` and `capture.ts`, so a naive "exactly one file
contains this string" law fails today for uninteresting reasons.

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
together rather than fixing one. Line numbers below are given with the wording
they point at, because they have drifted once already — search the quoted phrase
if the number no longer lands on it:

- `docs/record-format.md:150-160` — the reader's contract, above. True of a
  reader; says nothing about what this emitter writes, which is why it reads
  as a promise the record doesn't keep.
- `docs/architecture.md:1915-1917` — law 1, "preserved byte-for-byte in the
  log **and the record**", now sitting inside prd11 ruling 4's `/recordings`
  material. The "and the record" half is false on both export paths. **Still
  uncorrected**: this pass was deliberately scoped to leave
  `docs/architecture.md` alone, so the wrong wording is still in the tree and
  is inventoried here rather than fixed.
- `docs/prds/prd-17-complete-record.md`, ruling 3, law 1 — **cited by phrase
  rather than by line, deliberately (2026-09-10):** "never silently dropped,
  and always preserved byte-for-byte in the log and the record". The range this
  bullet used to carry (`:69-72`) was correct the day it was written
  (`e4990328`, 2026-08-25 — the phrase sat at line 71 then, inside the range)
  and had **already drifted well past that range before prd-17's wave-8
  amendment touched anything**: it was at line 136 as of `df494011`, the
  amendment's own base. That amendment moved it further; it did not break it.
  Both numbers are tied to a sha on purpose, so they stay true as history
  rather than becoming two more pointers to rot. Said precisely because a later reader
  auditing "which commit broke this" would otherwise be misdirected, in a
  document whose whole subject is stale-pointer hygiene. The drift is invisible
  to tooling — `doc-citation-law.test.ts`
  strips a `:NNN-NNN` suffix before its existence check, so it validates the
  path and cannot see that the number now lands on unrelated text. The
  preamble above already tells the reader to search the quoted phrase; this
  bullet now simply has nothing to go stale. This is the **origin** of the
  `docs/architecture.md` wording above,
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
`packages/core/src/events/index.ts:204-206` says `UnknownEventLine.line` is
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
