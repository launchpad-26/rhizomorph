You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Wave 3 of prd13. Keystone (#167) AND body (#168) are LANDED in packages/web/src/tide/ — read docs/prd13.md and both before anything. #183 owns app/StreamContext and app/streamState — do NOT touch them; if the dock needs a stream-side change, BLOCKED: <need>.

YOUR ISSUE — #169:

## Direction

prd13 wave 3 of 4 — **the dock**. Read `docs/prd13.md` IN FULL, then the landed
#167 selectors and #168 `Tide` component. This wave is where "the scrubber grew
a body" becomes literally true — and where the framing law bites hardest:
**the TIDE docks into the replay bar; it is never a panel** (prd13 ruling 1).
Zero rows added to the curated panel order. The scene's hero status is
untouched. If your diff adds a panel registration, you have left the ruling.

1. **Dock the `Tide` directly above the transport** so they share one x-axis
   and read as a single TIME dock. Use the time→x mapping #168 exported — do
   NOT build a second scale. The playhead must be pixel-aligned between the
   band body and the transport at every width you test.
2. **Live**: collapsed single density band (session-to-now, ruling 2), with the
   explicit expand affordance. **Replay**: expanded per-lane rows by default.
3. **The transport gains its missing affordances** (prd13 ruling 10): an
   explicit zoom-out control and `<<` / `>>` window-shift, alongside the
   playhead. The native range input keeps its keyboard behaviour BY
   CONSTRUCTION (arrows, Home/End, PageUp/Down) — the body is added around the
   existing `Scrubber`, never a reimplementation of it (its own docstring
   states this law; restate it stronger, don't weaken it).
4. **Clicking a moment in a band seeks the playhead there.** Drag-selection is
   wave 4's scope — in this wave, selection does NOTHING but exist visually if
   you build it at all; prefer not building it. Scope-to-selection, windowed
   figures and URL state are all #170. Do not reach into them.
5. **Height discipline**: collapsed live adds ~28px to the replay bar; expanded
   respects the 14px-row plan with the `+N` coalescing — the fold's page
   geometry (attention, burn, scene-min-height, fleet-above-the-fold) must
   survive at 1080p. Screenshot before/after at 1080p to prove the fold.

Laws, test-stated:

- The playhead x-position derived from the transport and from the band mapping
  agree (one scale, proven, not eyeballed).
- Live mode never renders per-lane rows without the explicit expand.
- Keyboard behaviour of the scrubber is asserted unchanged.
- Browser-verify live AND replay, collapsed AND expanded, in combination — the
  drawer scar (#132/#134/#149 green alone, broken together) applies to layout
  work as a class.

## Fence (may touch ONLY)

- `packages/web/src/app/ReplayBar.tsx` (+ its test if one exists or you add one)
- `packages/web/src/replay/index.tsx`, `packages/web/src/replay/index.test.tsx`
- `packages/web/src/replay/Scrubber.tsx`, `packages/web/src/replay/Scrubber.test.tsx`
- `packages/web/src/tide/` integration-glue components ONLY — #167/#168 laws
  and selectors may not change; if they must, `BLOCKED: <need>`

## Blocked by

#168 (landed on main). **Model:** sonnet. **Wave:** TIDE wave 3.

Sibling scope you must not enter: #170 owns scope-to-selection, windowed-figure
labelling, and URL deep-linking. The Shell/App layout tests are a known
coupling point (`.swarm/coupling.txt`) — if the dock's height change lands in
`Shell.test.tsx`, `BLOCKED: <need>` and the conductor widens on the record.

## Definition of done

- The replay bar has a body: collapsed band in live, per-lane rows in replay,
  one shared x-axis, click-to-seek, zoom-out and window-shift affordances.
- 1080p before/after screenshots; fold geometry intact; laws test-stated.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
