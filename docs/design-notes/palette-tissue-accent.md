# The tissue accent (prd10 rulings 5, 11, 12)

`packages/web/src/scene/palette.ts` — `TISSUE_900`..`TISSUE_200`, `TISSUE_RAMP`,
`tissueAt`, `returningInk`.

## Lineage

Ruling 29 originally bought salience by forbidding the calm-world colour
outright. prd4 replaced that blanket ban with the brightness band (law 9b).
prd10 ruling 5 opened one remaining door: a cold bioluminal violet, permitted
for organic tissue only — the heart's depths, a thread's underglow, spore
motes, and the gradient a severed lane's matter cools through on its way home
(ruling 12). Never a status hue, never data ink, never chrome.

## Why the hue is safe

Ruling 11 states the accent's safety margins as numbers rather than as
assurance: H 295.5 in OKLCH at low chroma, which sits 41° clear of the ice
ramp, 87° from notice-cyan and 78° from broken-red. `palette.test.ts` measures
all three, so the accent cannot drift toward a hue that already means
something. The whole ramp also sits below the text-contrast floor by design —
tissue is never ink, so prd4's legibility law doesn't need to be touched or
traded against.

## `returningInk` (ruling 12)

A returning mote is born in its lane's own dim done-family colour (preserving
status meaning at the cut) and cools through the tissue ramp as it drifts home
(tissue meaning at the heart) — the composting story told in colour, and the
only place a status hue and the accent are allowed to touch. The hand-off is
deliberately early and soft (`t * 1.4`): a mote reads as unmistakably its
lane's colour for the first third of the journey and unmistakably tissue by
the last, rather than snapping between the two.
