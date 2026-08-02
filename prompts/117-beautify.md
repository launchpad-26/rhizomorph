## Why (operator, looking at the running app: "this is kind of ugly, no?")

A conductor visual review at 2x device-pixel-ratio, with close crops of
the centre, the rim and the top dock, found three specific failures.
Nothing here is about performance (locked 60fps) or correctness (1553
tests). This is craft.

### 1. The scene reads mechanical, not grown

- Every retired lane is the SAME short stub at the SAME radius, evenly
  spaced on a perfect circle: 37 near-identical eyelashes on a clock
  face. prd7 ruling 4's bounded variation is technically present and
  visually undetectable.
- Each stub still ends in a small double-loop curl — a repeated glyph,
  which is precisely the "shape" prd7 ruling 3 set out to delete. It
  reads as clip-art, not growth.
- Consequence: the rim, which is most of the picture, is regimented.

**Direction.** Retirement must scatter. Within the laws (angle is
identity/g7; lifecycle distance is prd6 ruling 4), you may: vary the
retirement radius by *when* a lane retired (a drift band, not a line);
make scar length and thickness read the lane's actual output far more
decisively (a 216K lane and a 0K lane must be obviously different — they
currently are not); vary curvature and end-shape per lane seed; and
DELETE the curl glyph, letting the ribbon's own taper end the form. The
rim should look grown at different times by different amounts, because
it was.

### 2. The centre is a sticker, not a body

Close crop shows: a flat opaque mid-grey fill, a hard ~1px lighter
outline, and a radial-gradient core sitting inside the silhouette but not
aligned to it — two objects pretending to be one, in a material nothing
else on screen shares (everything else is thin, translucent, ice-toned).

**Direction.** One body: no hard outline; a translucent fill that carries
the ICE ramp with depth derived from the SAME field the contour already
computes (not a separate gradient sprite pasted on); silhouette from
multi-octave noise so lobes vary in scale instead of one uniform
wavelength. It should look like the ribbons' own material gathered into
mass — related to the threads, not imported from another program. This
supersedes #116, which is closed in favour of this issue.

### 3. The burn strip is a wall of grey prose

Verbatim, one line, all at the same weight:
`BURN 2.3M OUT  NO COST FEED (OTel) — dollars unavailable — run: eval
"$(rhizomorph env <lane>)"  0 out-tok/min RATE  CONDUCTOR NOT
INSTRUMENTED — overhead ratio unknowable`

Three unrelated facts and two apology sentences, run together, undesigned.
The honesty is right (law 12 stays); the typography abandoned it.

**Direction.** Give the strip a hierarchy: the figures are the strip
(mono, tabular, the brightest thing in it); the gap voices are secondary
and visually subordinate — smaller, dimmer, clearly separated (a divider,
or a second line, or a compact "why?" affordance that carries the long
sentence without spending the whole bar on it). The command an operator
must run stays copyable and exact. No information may be removed: a gap
must still say WHAT is missing, WHY, and the command.

## Also true, and in scope if cheap

The panels/buttons are a uniform 8px-radius, single-border, single-fill
system with no depth or emphasis anywhere. If a small amount of
hierarchy (a hairline that reads as a fold, a slightly recessed panel
body, a hover that means something) makes the shell feel considered
rather than generated, do it — but do not invent new hues, and do not
touch the ladder colours.

## What may NOT change

- Every law in `marks.test.ts`, `contour.test.ts`, `retire.test.ts`:
  the encodings, the ladder hues, CALM_FLOOR/ALARM_FLOOR, the cap-of-5
  motion budget, the AMBIENT ≤3% breath, reduced-motion, the pause
  control, the un-instrumented floor ("unknown, not zero").
- Determinism: same fleet state → same picture, seeded from lane identity.
- Canvas 2D. No shadowBlur (it also does not scale under the camera).
- 60fps at 30 lanes; report frame cost before/after.

## Method (this is a craft issue — work like it)

Load `emil-design-eng`, `frontend-design`, and `ui-ux-pro-max`
("Biomimetic / Organic 2.0"). **Look at your work**: a dev server runs at
127.0.0.1:4400 (`npm start -- <repo> --port 4400`), and `npx playwright`
is cached — take 2x crops of the centre, the rim and the top dock before
and after, and put what you saw in your report. A change you did not look
at does not count.

## Fence (may touch ONLY)

- `packages/web/src/scene/**` (all of it — this is a scene-wide pass)
- `packages/web/src/panels/burn/**`
- `packages/web/src/theme/theme.css` (ONLY if a token must be added; no hue changes)
- `packages/web/src/app/PanelFrame.tsx` (only for the optional chrome depth)

## Blocked by

Nothing. **Model:** opus. **Wave:** beautification.

## Definition of done

- The three findings are visibly fixed, with before/after 2x crops
  described in your report.
- Root `npm test` + `npm run typecheck` green; every law above intact.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green.
- Frame cost reported; 60fps preserved.

## RULES

- Work ONLY in this worktree. Never run git elsewhere.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
