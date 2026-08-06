# Vibrancy dials (#157)

`packages/web/src/scene/palette.ts` — `ACTIVITY_TINT`, `CALM_BODY_FLOOR`, `TUFT_WASH`, `REPLAY_VIBRANCY`.

## Context

The operator's review of the "gorgeous round" asked for a little more vibrancy
live. The tempting fix — raise `CALM_CEILING` and let the fleet climb — was
rejected: since prd4 dropped hue exclusivity, the six-hundredths gap between
`CALM_CEILING` (0.78) and `ALARM_FLOOR` (0.84) *is* the entire salience
mechanism (law 9b). Spending any of it on ambient prettiness would buy
vibrancy with the one property the instrument cannot lose.

## Decision

Raise vibrancy only in the two channels the alarm band doesn't own:

- **Chroma** — `ACTIVITY_TINT` raised from prd4's values (working 0.45,
  waiting 0.50, done 0.35) to 0.56 / 0.60 / 0.44. `luminance()` is a weighted
  mean of the channels, so swinging a colour away from grey at constant mean
  costs the budget nothing.
- **The floor** — `CALM_BODY_FLOOR` raised to 0.58. prd4 originally pinned the
  "too dark and pale to read" fix at 0.5 (up from a regressed 0.22); this
  raises it again by exactly the headroom the ceiling leaves free, so the top
  of the band still hasn't moved.
- **Tuft wash** — `TUFT_WASH` lowered from 0.25 to 0.16. Lowering it is what
  raises vividness: `hotter()` mixes toward `ICE_050`, so every hundredth of
  wash is a hundredth of the family's chroma traded for white.
- **Replay-only lift** — `REPLAY_VIBRANCY = 1.6`, applied in exactly one place
  (`marks/ambient.ts`). Picked instead of a more "obvious" 1.2 because ruling
  16's mode chrome already applies `saturate-75 brightness-90` to
  `document.body`, so a replay frame is shown 10% darker and 25% less
  saturated than the pixels this palette produces before the CSS filter is
  even considered. 1.6 nets out at roughly ×1.44 luminance and ×1.20 chroma on
  the substrate after that filter — which is where "a lot more vibrancy on
  the replays" actually lands. This is a deliberate tension with ruling 16
  (which cools the whole app so a replay can never be mistaken for a live
  fleet): nothing here weakens that ruling, because the multiplier only
  reaches the substrate (spores, rim flora, fog, vignette) — never a status
  hue, the alarm grammar, the ladder, or the motion budget — and every status
  mark still carries ruling 16's cooling untouched.

`palette.test.ts` sweeps every activity at every freshness/heat through
`spend()` and holds the pair to `CALM_CEILING`, so none of these dials can be
turned far enough to break the band by accident.
