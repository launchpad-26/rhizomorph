You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The research note docs/research/2026-08-05-replay-ux-spike.md is your design authority — read its section 4 AND its non-recommendations in full before any code. The conductor's browser diagnosis is in the issue; the verified-working parts (exact seek, honest re-fold) must stay exact at every zoom level.

YOUR ISSUE — #186:

## Direction

Operator review of the landed TIDE dock on a real 48-lane recording,
2026-08-05, conductor-diagnosed in the browser the same hour. Four confirmed
defects and one verified non-defect.

**Verified working, for the record:** click-to-seek is EXACT (mark
"123-trace-span-keystone landed · 06:50:47" → clock 10:55 elapsed from the
06:39:52 session start, to the second), and every panel re-folds to scrub
time with the honest "as of scrub time" label. The mode-clock discipline
holds end-to-end. The operator asked for this to be double-checked; it was,
and it passes.

**Defect 1 — two bodies.** The dock renders TWO interactive rows: the density
band (with its `+N` chip) and the native scrubber below it, each with its own
thumb-like affordance. **Direction (from the replay-UX research note — read
`docs/research/2026-08-05-replay-ux-spike.md` §4 R1 IN FULL, it supersedes any
unification instinct): two tiers, two JOBS, one drawn link.** The Scrubber row
is the OVERVIEW — always full range, the only draggable. The Tide+marks rows
are the DETAIL — windowed under zoom, click-to-seek but never drag-grabbable
(the playhead stays a hairline with no grab affordance). When zoomed, draw the
relationship: a still bracket over the scrubber track spanning the detail
window in full-range coordinates (one more `timeScale` call — the mapping
exists in `TideDock.tsx`), plus a figures-voice label in the button cluster:
`window ¼ · 14:02–14:31`. One draggable thing, one hairline, one bracket.

**Defect 2 — marks are dust with a hidden voice.** Chapter marks are 9px
tall, 8–24px wide, dim, and their who/what/when lives in a NATIVE `title`
tooltip (1s delay, unstyled, undiscoverable) — conductor-verified via DOM:
the content is exactly right and the affordance is the weakest the platform
offers. Direction (research note §4 R2–R3, R5): marks become the PRIMARY
navigation surface. Full-height ticks in the mark lane, hit targets grown to
≥12px via padding, existing ice tokens only — NO per-kind colors (an
implicit legend; ruling 7 extends to marks, as `ChapterMarks.tsx` already
argues). Label-when-fits on marks (`163 ▸`), the band's own law reused. The
`title` attribute becomes a styled ~150ms hover card in dock chrome: one
line per cluster member in the ruling-6 voice, **each line its own exact
seek button** — and the card is the declared future home of the fork
affordance (prd12 bridge; a code comment, not an implementation). While
DRAGGING the overview, the nearest chapter's label shows above the thumb
(the YouTube idiom) — scrubbing stops being blind between marks. Keyboard:
`[` / `]` prev/next chapter at dock level (no key the range input owns), and
the range input gains a real `step` (`max(1000, span/1000)`) so arrows move
usefully — configuring native behaviour, never replacing it.

**Defect 3 — no reachable granularity.** The test session spans 43.5 hours
in one bar width ≈ 100 seconds per pixel; clusters reach `◆(1023)`. Zoom
EXISTS (#169's `+`/`-`/shift buttons, corner-tucked) but the operator never
found it — a discoverability failure — and button-step zoom cannot deliver
precision anyway. Direction (research note §4 R4): keep button zoom and the
level-0 exact floor; add **Shift+wheel over the Tide zooming about the
cursor's timestamp** (pointer-anchored, modifier-gated so page scroll is
never hijacked), drag-on-Tide PANS when zoomed (click-vs-drag threshold
~4px), and extend `ZOOM_FRACTIONS` geometrically (…1/32, 1/64) **stopping
when the window's hover threshold reaches the log's median event spacing** —
zoom exactly deep enough that clusters split, which is the only depth any
job asked for. The R1 bracket is the window indicator. NOTE: scope-to-
selection stays strictly #170's; this lane builds the zoom substrate only.

**Defect 4 — density without hierarchy.** Three rows (marks, band,
transport) cramped in ~30px. In REPLAY the dock is the primary control —
give it honest room (marks get height, the axis gets labels at zoom); in
LIVE it stays the compact strip it is today. Mode-dependent height is not a
new law, it is ruling 2's two modes finishing the thought.

Laws that must survive, test-stated:

- Seek exactness (the verified property above) at every zoom level — zoomed
  click-to-seek maps through the SAME scale function, proven not eyeballed
  (#169's one-scale law extended to zoomed states).
- Native scrubber keyboard behaviour intact after the overlay unification.
- Marks/hover: a cluster's card lists ALL members; a member row's seek is
  exact; the card renders within the ice-400 floor (#136 law untouched).
- No new hue, no motion, no legend (prd13 rulings stand).

## Fence (may touch ONLY)

- `packages/web/src/tide/` (all files)
- `packages/web/src/replay/` (all files)
- `packages/web/src/app/ReplayBar.tsx`

## Blocked by

Nothing — the research spike landed
(`docs/research/2026-08-05-replay-ux-spike.md`; read §4 in full, its
non-recommendations bind you too: no second timeline panel, no per-kind
mark colors, no attention heatmap, no auto-skip time-lies — the honest
form of dead-air skipping is `]` next-chapter, already in scope above).
Sibling scope: #170 owns scope-to-selection and windowed-figure honesty
(when it lands, `t=<playhead>` joins its URL state — note the seam, do not
build it). **Model:** sonnet. **Wave:** tide-legibility.

## Definition of done

- One draggable body; marks visible with immediate rich hover cards and
  keyboard traversal; wheel-zoom-at-cursor with a window indicator; replay
  dock breathes; all laws above test-stated.
- Browser-verified on the 48-lane recording at multiple zoom levels, with
  before/after screenshots at 1080p.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
