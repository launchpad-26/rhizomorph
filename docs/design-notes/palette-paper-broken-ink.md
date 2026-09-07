# The paper broken ink (#39, law 9's first test)

## Where it lives

`packages/web/src/theme/theme.css` — light theme's `--color-broken`.
`packages/web/src/scene/palette.ts` — `PAPER_BROKEN`, the canvas mirror of the
same token. `packages/web/src/theme/category.test.ts` — the law itself,
"law 9 — the two poles survive greyscale and a red-green reader". The shared
arithmetic — `deltaE`, `simulate`, the two dichromacy matrices — lives in
`packages/web/src/theme/oklch.ts`, beside `oklch()` and `hueGap()`.

## The defect, measured

Light theme shipped `--color-working: #007137` and `--color-broken: #a90035`.
Measured with a Machado et al. (2009, severity 1.0) dichromacy simulation and
WCAG contrast for greyscale:

- greyscale: **1.25:1**
- deuteranopia ΔE: **1.4**
- protanopia ΔE: **15.3**

Both colours are individually fine against their ground and fail only against
each other: a red-green reader with deuteranopia, and anyone reading the page
in greyscale, saw one colour where "fine" and "dead" needed to be two.

## The value and why

**`--color-broken` (light): `#a90035` → `#7a0024`.** OKLCH L 0.467 → 0.368, C
0.187 → 0.147, h 15.6 → 15.5 (dark's is 13.9; the 12° law has 1.6° of use).
Same angle, deeper ink. The target: **light's poles separate at least as well
as dark's do**.

| clearance | law | before | after |
| --- | --- | --- | --- |
| broken ↔ working (light), greyscale | ≥ 1.5:1 (new) | 1.25:1 | **1.84:1** |
| broken ↔ working (light), deuteranopia ΔE | ≥ 8 (new) | 1.4 | **10.0** |
| broken ↔ working (light), protanopia ΔE | ≥ 8 (new) | 15.3 | 22.8 |
| broken ↔ working (dark), greyscale / deutan / protan | same | 1.88:1 / 10.9 / 29.1 | unchanged |
| light broken ↔ dark broken hue | < 12° (`palette.test.ts` "keeps %s at the angle it means") | 1.7° | 1.6° |
| every other light status ↔ broken | > 30° | 61–161° | 61.3° (needs-you) … 161.1° (notice) |
| paper fruit steps ↔ light broken | > 30° in the test; "≥ 33°" in `palette.ts`'s comment | 33.9° / 34.9° / 37.6° | **33.8° / 34.7° / 37.5°** — the documented 33 still holds |
| tissue accent ↔ broken (dark, "78° from broken-red") | > 60° | 78.4° | unchanged (dark does not move); light accent ↔ light broken 80.2° |
| notice ↔ accent ("87°") | > 60° | 87.5° | unchanged |
| broken on the page (legibility) | ≥ 4.5:1 | 7.13:1 | 10.53:1 |
| broken's presence on paper | ≥ `PAPER_ALARM_FLOOR` 0.75 | 0.811 | 0.855 |
| severity ladder in presence, calm → notice → needs-you → broken | monotone | 0.447 / 0.485 / 0.751 / 0.811 | … / 0.855 |
| cap 1's quietest status chroma | notice (0.090) stays quietest | — | unchanged |

## What was rejected

**Move `working` instead.** Impossible in the sense that matters, though not
in the naive one. Working can only get *lighter* to separate (broken is
already the darker), and it sits at 5.71:1 against the page with
`BODY_TEXT_MINIMUM` 4.5:1 underneath it. A search over every green within 8°
of dark's working, ≥ 4.5:1 on the page and > 30° from notice — the full sRGB
cube, step 1, restricted to hues lighter than the shipped broken — does find
candidates that clear the bare floors: 489 of them, e.g. `#4c7b65` at 1.58:1 /
ΔE 8.0. But **zero** of those lighter greens reach dark's own separation
(≥ 1.88:1 *and* ≥ ΔE 10.9, the principled target stated below), and the ones
that clear only the bare floors do so at chroma 0.005–0.062 against the
shipped green's 0.127 — the best contrast achievable this way (`#4c7c5a`,
1.58:1) already needs chroma down to 0.075 and still falls short of the ΔE
floor (7.27, not 8); the best ΔE achievable (`#6f7270`, ΔE 9.36) needs chroma
down to 0.005, which is a grey, not a green. A working that separates from
broken by this route stops reading as the calm-world colour it is; the floor
pins working in the only sense that survives contact with a reader's eye.

**Move both.** Buys ~0.3:1 of extra greyscale ratio for twice the blast radius
(`working` is what `activityInkOn` tints every living thread with). Rejected;
one token moves.

**Deeper still.** `#700020` (L 0.346) gives 2.00:1 / ΔE 12.3 but drops chroma
to 0.138; `#460016` reaches 2.69:1 / ΔE 22 at C 0.10 — a near-black nobody
would call red. `#7a0024` is the shallowest value whose pair matches dark's own
separation (1.84:1 / 10.0 vs 1.88:1 / 10.9), which is the principled target: a
reader who can tell fine from dead on the void can tell them apart on paper
too.

## Why the law is denominated in WCAG contrast and not cap 5's `luminance()`

Cap 5 in `theme/category.ts` measures greyscale separation with
`scene/palette.ts`'s `luminance()` — a gamma-naive weighted mean of the sRGB
bytes, times alpha, the budget the presence/salience arithmetic is denominated
in. It reports the shipped light pair 0.176 apart in that budget, comfortably
over cap 5's 0.08 step, while a gamma-decoded grey (WCAG's own relative
luminance, `theme/contrast.ts`) puts the same pair at 1.25:1 — the actual
defect. The naive mean errs little on the low-chroma tints cap 5 was written
for and badly on saturated, high-contrast inks like the status poles. So law
9's status test is denominated in WCAG contrast, the same ratio the legibility
law uses, and it would have caught the shipped defect the day it landed. This
is a recorded observation, not a change: cap 5 stays as it is for the category
family, and if that family is ever retuned toward saturation, cap 5 should move
to `contrastRatio` too.

## What the law does not claim

The six status hues are not pairwise separable in either theme without their
glyphs — dark's `done`/`broken` sit at 1.01:1, `needs-you`/`notice` at 1.06:1;
light's `done`/`waiting-benign` at 1.01:1, `working`/`notice` at 1.11:1. They
are not meant to be: law 9's by-construction half — every state is glyph +
word (`packages/web/src/fleet/sigils.tsx`) — carries those. The poles
(`working`, the healthiest read; `broken`, the one that means dead) are the
one pair whose confusion inverts the whole instrument's reading, so they alone
are held to a number.

## Simulation model

Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for
Simulation of Color Vision Deficiency", severity 1.0, applied in linear light
(`packages/web/src/theme/oklch.ts`'s `simulate`). Distance between simulated
colours is Euclidean in Oklab, scaled ×100 (`deltaE`) so the numbers sit on the
scale colour-vision validators report — ΔE ≈ 1 is about the least difference a
reader notices.
