# The apical tuft and its glow (prd10 ruling 4, #157)

`packages/web/src/scene/marks/node.ts` — `tuftMarks`, `branchlets`, `TIP_LIGHT`.

## Context

Ruling 4's brief: "Growing thread ends taper into fine 2–3 branchlet
growth-cones in vivid family hue." Before this, the tip of every lane ended in
the same `node-tip` thorn, which says *this reach ended deliberately* — true
of every lane, and therefore silent about the one distinction the north star
cares about: a lane that is still growing versus a lane that has stopped. A
hypha's growing end is its apex; it is where the organism is actually
happening, and ruling 4 asked for it to look like it.

## The three carried facts

A working lane's tip splits into branchlets, and each visible property is a
fact the lane already carries rather than a new number invented for the mark:

- **branchlet count** — 2 or 3, off the lane's free phase, so no two apices
  are congruent (`variation.ts`'s permission table says the count itself
  carries no meaning).
- **reach** — the lens's own length, so a big lane's apex is bigger too; the
  work-size channel, unchanged.
- **light** — the lane's own decaying `inbound` energy. A `commit.landed`
  event raises it and it decays over about one agent turn, so a bright tip is
  one that work has just come out of. A landing flares it once, over the
  event's own envelope (see "The landing flare" below).

The glow itself is the 9b amendment: the only calm mark in the instrument
permitted past `CALM_CEILING`. Its bounds (`TIP_CEILING`, `TIP_GLOW_RADIUS`)
live in `salience.ts`, not here, and `spendTip` is the only door it goes
through — it recedes like every other calm mark, so a summons anywhere still
owns the band.

## The landing flare

When a lane finishes, the cord-cut carried a law forward from before ruling
13: "no glow anywhere on a retiring lane; matter, not light." Ruling 13's
transformation (see `docs/decisions/retire-transformation-not-deletion.md`)
gave the tail and seal back to every finished lane, but this law survives
unweakened — a finishing apex gets a *flare*, not a glow. A flare doesn't need
a halo to be a flare: the apex's own substance goes bright once, tracking the
return's own tension/withdraw stages, which is what a growth cone burning out
actually looks like. The 9b amendment's glow stays scoped to a *working* tip
only, exactly as ruling 4 asked.

## The wash budget (#157)

The branchlets' colour is the family hue at its live end rather than the aged
tint the lens wears — the apex is the newest part of the organism, so it is
the one mark whose brightness is not its age. This is also where a commit is
actually made legible, not in the glow: the band between `CALM_CEILING` and
`TIP_CEILING` is only three hundredths wide, a door rather than a channel, so
a glow living inside it has almost no range to spend. The branchlets have the
whole calm world to move in instead, so the arrival rides there.

`TUFT_WASH` (toward white) is deliberately the smallest of the three terms
that feed the branchlets' colour: every hundredth of it is a hundredth of the
family's chroma sold for luminance the calm ceiling won't let the mark keep
anyway. What it gives up there it takes back in alpha, so the branchlets end
up more saturated at about the same brightness, and `budget()` still holds the
pair under `CALM_CEILING`.

## `TIP_LIGHT`'s two numbers

The floor (0.95) is high because "a small **steady** glow" means a quiet
working tip has to clear `CALM_CEILING` on its own — otherwise the amendment
would only ever be visible on lanes that happened to have just committed, and
ruling 4 would have been granted for nothing. The commit term (0.05) is
deliberately small for the same reason the door is narrow: `spendTip` caps the
pair at `TIP_CEILING` regardless, and the *visible* response to an arrival is
the branchlets, which have the whole calm world to move in.
