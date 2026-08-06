# The lens's length formula (#117)

`packages/web/src/scene/marks/node.ts` — `lensLength`.

## Before

The formula was `9 + 9 · size`: a 4× range in the underlying encoding (work
size) compressed into a 2× range on screen — a range nobody actually reads at
a glance. The review that opened #117 put it directly: "a 216K lane and a 0K
lane must be obviously different," and the node is the mark the eye lands on
first, so it is where that had to be fixed.

## After

`5 + 14 · size` spends the whole span instead: a lane that has produced
nothing draws as a speck, and a lane that has produced a day's work draws
three times it. Nothing else about the formula's shape changed — it is still
linear in `sizeFrac`, on the same absolute pixel scale as the rest of the
lane's marks (prd6 ruling 1) — only the coefficients moved to use the range
that was going to waste.
