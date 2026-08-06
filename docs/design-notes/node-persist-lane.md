# The finished lane's node (prd10 rulings 13–15, #117)

`packages/web/src/scene/marks/node.ts` — `persistNodeMarks`, `persistNodeRibbons`.

## All three marks now stay

The hollow lens, the tail and the seal used to be gated on
`composting(cut.dissolve)`: the cord's own substance went away with the cord
once ruling 2 erased a finished lane's geometry entirely. Ruling 13 took that
erasure back — a rhizomorph keeps the cords that carried its nutrients rather
than deleting them (see `docs/decisions/retire-transformation-not-deletion.md`
for the fuller argument) — so the tail and the seal are no longer conditional
on anything: they are simply part of a settled strand's resting anatomy. The
node of a finished lane is a node, not a headstone.

## The curl glyph is gone (#117)

The thorn at a finished lane's tip used to be a stamped `THORN_OUT`: the same
unit-square path, at the same nine pixels, rotated onto the end of every
finished lane on the rim. At one lane that reads as a terminal; at
thirty-seven of them on one rim it reads as clip-art — precisely the kind of
repeated "shape" prd7 ruling 3 already set out to delete elsewhere, surviving
here only because nobody had looked at a rim with thirty-seven of them on it.

What ends a strand now is the ribbon's own taper (`tailMark`) and the fold it
seals with (`sealMark` — see `docs/decisions/node-seal-fold.md` for that
shape's own history). Both vary per lane off the lane's free phase, so no two
finished lanes end alike.
