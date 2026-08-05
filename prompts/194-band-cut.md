You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

This is a DELETION lane — its value is what comes OUT. docs/prd13.md ruling
13 is the blessing; read it and ruling 12 together so you cut the band
without nicking the marks. Delete code nothing calls; do not leave orphans.

YOUR ISSUE — #194:

## Direction

**prd13 ruling 13 (operator amendment, 2026-08-06) — read it IN FULL in
`docs/prd13.md` before touching anything.** The operator, after three rounds
of fixes on this dock: *"honestly? get rid of the working green strips
entirely."*

This is a DELETION lane. Its whole value is what comes out. The density band
got every affordance the research asked for — legible hit targets, an honest
hatch, coalescing, a real per-lane expansion sized to available height — and
it still read as noise to the only person using it. prd3 ruling 25's protocol
is explicit: a mark that fails the glance test gets an affordance or is cut.
It got its affordances. It is cut.

**Remove entirely — collapsed and expanded, live and replay:**

1. The state-fill bands (working / waiting / broken / parked fills) and the
   honest hatch that expressed gaps within them.
2. The per-lane rows and the expanded view altogether.
3. The `+N` coalescing chip and its gutter.
4. The row-budget machinery that sized rows to available height, and the
   expand/collapse affordance itself — there is nothing left to expand.
5. Any band-only selector surface that no longer has a consumer: `bandsFor`
   and `rowPlan` were built for this and nothing else. **Delete code that
   nothing calls** — do not leave orphans behind "in case". If a helper is
   genuinely shared with the marks path, keep it and say which.

**What the dock becomes, and all it becomes:** the chapter-mark lane, the
time axis, and the transport. A line of moments over a scrubber.

**What must survive untouched** (verify each, name it in your summary):

- Chapter marks, their coalescing, and the portaled hover cards with
  per-member exact seek (#189's `createPortal` to `document.body`,
  `position: fixed`, and its parent-is-body law).
- Click-to-seek exactness at every zoom level, and shift+wheel
  zoom-at-cursor with the window bracket and its label.
- `[` / `]` chapter stepping, the native scrubber's own keyboard behaviour,
  the zoom-out and window-shift affordances.
- Ruling 1: still the replay bar's body, never a panel. Zero rows added to
  the curated panel order.
- The #136 contrast floor and the motion law (marks stay still).

**Height:** with the band gone the dock is much shorter. Re-check the fold at
1080p — the scene gains the space back, which is the point. Mode-dependent
height (#189) probably collapses to one height; if so, delete that branch too
rather than leaving a constant that lies.

Laws to restate, test-stated: no band, row, fill or chip renders in any mode
(assert their absence — a deletion needs a law or it creeps back); marks and
seek behave identically to before the cut (the existing laws must pass
unchanged, which is the proof the cut took nothing with it).

**Report the diff's shape**: lines removed vs added, and files deleted
outright. A deletion lane that adds more than it removes has misunderstood
its job.

## Fence (may touch ONLY)

- `packages/web/src/tide/` (all files, including deletions)
- `packages/web/src/replay/` (all files)
- `packages/web/src/app/ReplayBar.tsx`

## Blocked by

Nothing (#189 landed). Sibling lanes hold other surfaces: #190 owns
core/server capabilities, #191 owns the drawer. **Model:** sonnet.
**Wave:** the cut.

## Definition of done

- The band, rows, chip and expansion are gone, with laws asserting their
  absence; marks, cards, seek, zoom and keys all still work and their laws
  pass unchanged; the fold re-checked at 1080p with a screenshot.
- Browser-verified on the 48-lane recording: hover a cluster, click a card
  row, land on the exact moment — with no band anywhere on screen.
- Report removed-vs-added line counts.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
