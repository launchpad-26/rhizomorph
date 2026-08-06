# Three fixed glyphs replaced with per-lane organic variation (prd7 ruling 3, #117)

`packages/web/src/scene/marks/node.ts` — `enclosureMark`, `expensiveMarks`,
`tailMark`.

All three of these marks share the same underlying argument: a fixed path
rotated onto every lane on the rim is a repeated glyph however good the glyph
looks once, and a rim with dozens of them reads as clip-art rather than as an
organism. Ruling 3 is the standing law against that; each mark below is a
separate place it was applied.

## The enclosure: ring → blob

The claim — a lane above calm is bracketed, a calm one never is — is
unchanged from prd3, and it is exempt from every fade for the same reason the
fleet table's alarmed rows are. What changed is the shape. The old enclosure
was a cartouche: a struck circle, sitting at the node where it competed with
the state mark it was supposed to frame. Two things were wrong with it — it
was a circle in a picture of grown things, and it sat in the wrong place — so
it became a midpoint-displaced blob (Hobbs' subdivision, seeded off the lane
so no two are the same shape) behind the lane's *name* instead. It does its
job better for having moved: the thing an operator needs bracketed at a
glance is which lane, and the answer to that is the name, not the node.

## Expensive: chevrons → tapers

Three arrowheads stacked over a node were, in the team's own words, "the
scene at its most drafted": a fixed ladder of identical glyphs, legible only
within a few pixels of one point, saying "outward" about a thread whose
direction was already the most obvious thing on it. They were replaced with
tapers — the burning thread itself draws down to a needle over its last fifth
(`thread.ts`'s `HEAT_TAPER`), and the three marks at the node are the licks
leaving it: short ribbons, thick at the tip and needled to nothing, each
curling a little differently on the lane's own free phase.

## The tail: thorn → taper

A finished lane used to end in the same stamped `THORN_OUT` every other
terminal in the scene uses. Replaced with a short run of the lane's own
substance carried past the node and needled to nothing, leaning off the
lane's free phase — the same "a taper is not a glyph, it's the ribbon ending"
argument as the two substitutions above.
