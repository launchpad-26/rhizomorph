You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

YOUR ISSUE — #157:

## Direction

Operator review of the gorgeous round (2026-08-04): "the scene is good…
we could have a LITTLE more vibrancy, a lot more vibrancy on the replays"
— plus a suspected frame-rate cost. Read `docs/prd10.md` and
`docs/research/2026-08-04-prd10-gorgeous-spike.md` first; every law there
still binds. NOTE: the replay-grey BUG (wall-clock vs scrub clock) is
being fixed in its own lane — do NOT compensate for it here with colour;
assume replay renders live-looking states and make THOSE more vibrant.

**FIRST TASK — measure, before touching anything** (the operator suspects
lag): run the scene perf test and a 30-lane frame profile on the CURRENT
build; record median and worst frame time in your summary. Your work must
end no worse than it started; if you cannot hold that, ship less.

1. **A little more vibrancy, live** (within law 9a/9b as amended):
   raise the calm band's ceiling toward — never past — the alarm floor:
   richer thread body luminance, stronger apical tuft saturation within
   the amendment's bounds, deeper tissue undertone in the heart's
   interior. Constants named at the top of `palette.ts` with their law
   comments so a future reader can see the ceiling they must respect.
2. **A lot more vibrancy in replay** — and it must be PRINCIPLED, not a
   mode-switch hack. The honest framing: a replay is a performance of
   history, so its ambient dimming (which exists to keep a live scene
   calm and glanceable) can relax. Introduce a single named
   `REPLAY_VIBRANCY` multiplier applied to ambient luminance/saturation
   ONLY (never to status hues' MEANING, never to the alarm grammar, never
   to the ladder), documented as: live is a working instrument, replay is
   a retrospective. Motion budget unchanged.
3. **Perf**: if the measurement shows the scene is over budget at 30
   lanes, fix the cheapest offender first (the spike's guidance: sprite
   blits over per-frame gradients, cached patterns, bake what does not
   change). Report before/after numbers.
4. Laws restated stronger, never weakened; scene fence only.

## Fence (may touch ONLY)

- `packages/web/src/scene/` (all files)
- `packages/web/src/theme/theme.css`

## Blocked by

#154 (must be landed — it touches scene/). **Model:** opus (taste work).
**Wave:** vibrancy.

## Definition of done

- Before/after frame numbers in the summary; no regression.
- Live vibrancy raised within the ceiling; replay vibrancy raised through
  ONE named, documented multiplier on ambient only.
- Scene laws + legibility floor green; root `npm test` +
  `npm run typecheck` green.
- Name what you would show the operator first, as #144 did.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
