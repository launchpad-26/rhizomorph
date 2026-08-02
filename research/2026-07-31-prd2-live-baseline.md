# prd2 live baseline — the Rhizomorph watching its own fleet, before A/B/C

> Recorded 2026-07-31 ~12:45 NZST. Server restarted on main `1ecdb44` (post
> wave-D landings #51–#53) as
> `npm start -- --extra-sessions /mnt/c/Users/operator/.claude/projects/C--Users-operator-agenticlaunchpad:conductor`,
> session id `1785458425389`. Observed in a real Chrome browser on the Windows
> side (`http://localhost:4321`), no console errors. Every number below is
> what the dashboard actually displayed. **This is the before-picture each of
> waves A, B and C must change; re-observe after each wave lands.**

## What the dashboard showed, minutes after boot

- **Spend ticker: 896.3M tokens, climbing** (896.5M → 896.6M over ~2 min of
  watching) — with zero work dispatched yet. "Tokens only — no cost events
  yet." Role split: worker 287.7K / **conductor 896.3M** / auxiliary 0.
- **Ledger rows** (BRANCH / COST / TOKENS / MODELS / FIRST SEEN):
  - `main` — 835.3M / 835.3M / `<synthetic>`, claude-fable-5,
    claude-haiku-4-5, claude-opus-5, claude-sonnet-5 — **first seen 2m ago**
  - `HEAD` — 41.3M / 41.3M / claude-fable-5, claude-opus-4-8 — first seen 2m ago
  - `factory-p1p2-conductor` — 20M / 20M / `<synthetic>`, claude-fable-5 —
    first seen 2m ago
- **Session dropdown: 24 recorded sessions** (2026-07-30T01:08:52Z through
  2026-07-31T00:40:25Z) — one per past boot, each holding its own copy of
  history; this boot is writing the 25th.
- Worktree table: one row, `main`, cost **287.7K** (tokens in a COST column),
  model badge `CLAUDE-SONNET-5`.
- Banner: "CONDUCTOR NOT INSTRUMENTED — SEE DOCS/TELEMETRY.MD" directly above
  a conductor row showing 896.3M tokens.

## Reading it against the prd

**Wave A (numbers).** The 896M is not this run's spend — it is the entire
history of the extra-sessions directory ingested from byte 0 at boot
(sessionlog has no seek-to-EOF; audit `collector.ts:249`). Every ledger row
says "first seen 2m ago" because events are stamped with the poll clock, not
the line's own time (`poll-loop.ts:45`) — week-old spend lands inside the
5-minute rate window. The 24 duplicate session files are the restart-
duplication defect made visible. **After wave A: a fresh boot starts at ~0,
first-seen dates are historical truth, and a restart resumes instead of
re-recording.**

**Wave B (identity).** `HEAD` and `factory-p1p2-conductor` are not branches
of this repo — they are session activity from a *different project*
(the factory workstream) bleeding through the un-namespaced lane/branch keys.
The repo-root worktree is booked as a 287.7K-token *worker* with a model
badge, because `role: 'worker'` is hard-coded for every `git worktree list`
entry. **After wave B: foreign traffic is refused or namespaced, and an
unidentified root session shows as `unattributed` — a setup gap, not a fake
worker.**

**Wave C (cost/threads).** COST equals TOKENS in every row; no dollars
anywhere despite prd1's OTel path being live-proven — historical sessionlog
data carries no cost and OTel events carry no branch, so the join is
structurally impossible. No thread sub-rows exist. **After wave C: the ledger
shows real dollars where provenance exists, and threads appear as sub-rows
under their lane.**

**Wave D (verified working here).** `npm run build` + `npm start` from the
repo root booted everything (#51); the status bar shows all five collectors —
Git, Tmux, Workmux, Sessionlog, OTel — plus the SSE dot (#53). This live run
IS the dogfood half of the stranger test.

## AFTER wave A (added 2026-07-31 ~13:35 NZST, same method: real browser, real server)

Wave A landed (#56 source timestamps + snapshot store, #57 EOF-start, #58
resume-the-run, #59 cross-collector dedup). Server restarted on main
`68fc3b6` with `--fresh`:

- **Spend ticker: 2.6M tokens** where the baseline showed 896.3M — and the
  2.6M is honest: the conductor session and three live worker lanes
  (60/61/67) burning *right now*, ingested from EOF forward only. Role split:
  worker 1.7M / conductor 912.7K — actual current activity, not history.
- **Ledger first-seen: "just now"** on live lanes, not "2m ago" on week-old
  history — events now carry the log line's own timestamp.
- **Resume proven:** a second restart *without* `--fresh` came back with the
  same session id (`1785461449418`) — the run survives the process, offsets
  persist, no duplicate history file.
- The foreign-branch rows (`HEAD`, `factory-p1p2-conductor`) no longer appear
  on a fresh boot — not because identity is fixed (that is wave B, in
  flight), but because their *history* is no longer ingested; a live foreign
  agent would still bleed in until #60 lands.

Wave A's demo criterion — "spend starts at zero" — holds in a real browser.

## AFTER the token-semantics ruling (added 2026-07-31 ~15:05 NZST)

Lachlan's ruling ("a token is not a unit") landed as #69/#70; verified in a
real browser on main `b544055`:

- **Headline: "400.6K output tokens — work produced"** where the old display
  would have shown ~110M unlabelled "tokens". The four tiers sit beneath it,
  always visible: OUTPUT 400.6K / INPUT 7.1K / CACHE READ 106M / CACHE WRITE
  3.5M — the 50× value difference between tiers is now on screen instead of
  buried in a sum.
- Ledger COST/TOKENS and the worktree table show labelled output figures
  ("68.1K out"); breakdowns ride the existing tooltips. **No surface renders
  an unlabelled all-tier total.**
- The overhead ratio is conductor OUTPUT ÷ worker OUTPUT (#69) — a work
  ratio a polling conductor's cache reads can no longer inflate.

## One copy tension worth a prd3 line

"CONDUCTOR NOT INSTRUMENTED" sitting above an 896M-token conductor row is
correct by design (the gap refers to *cost provenance* — no OTel exporter on
the conductor) but reads as a contradiction. When the viz study (prd3) touches
the spend ticker, this banner should name the missing thing: "no cost feed
(OTel) — tokens from session logs only."
