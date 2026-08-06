# The role/form split at the node (prd7 ruling 2)

`packages/web/src/scene/marks/node.ts` — `nodeMarks`, the five pathology cases.

## The split

The node is the one place in the scene where the two vocabularies meet most
visibly, and ruling 2 draws the line down the middle on purpose: the **roles**
a pathology emits are what the laws in `marks.test.ts` are written in and must
not change when the picture does; the **form** — the actual glyphs, ribbons
and glows — is this file's answer today, and is free to change.

| state     | roles it emits            | form, today                    | hue   |
| --------- | -------------------------- | ------------------------------- | ----- |
| LOOPING   | `looping-mark`, `orbit`     | knot, light going round it      | amber |
| FROZEN    | `severed`                   | the ribbon pinched shut, twice  | red   |
| WAITING   | `summons`, `held`           | raised hand, light stopped      | amber |
| EXPENSIVE | `expensive-mark`, `heat`    | needled tip, licks coming off   | cyan  |
| OFF-FENCE | `off-fence-*` (four)        | barb, reach, breached arc       | amber |

Three of those cells (LOOPING, EXPENSIVE, the seal/tail forms) were rewritten
by prd7 ruling 3, and the left-hand column — the roles — did not move an inch.
That is the whole return on ruling 2: the tests kept passing while the picture
was redrawn underneath them.

## The third axis's naming history

FROZEN and WAITING are the pair the prd says must never be confusable, and
they are opposed on three axes at once: dark vs light, broken vs continuous,
and severed vs summoning. That third axis used to be stated in this file as
"cut vs raised" — which was the drawing describing itself, not the property
that has to hold. The two states have to stay distinguishable however either
is actually drawn, so the axis is now named for the fact rather than for the
current glyph. `marks.test.ts` asserts all three axes, so no future tuning can
quietly collapse one of them.
