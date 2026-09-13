# Why the attention strip assumes every chip is 520px wide

`CHIP_MAX_WIDTH_PX` in `packages/web/src/panels/attention/AttentionStripView.tsx`, and the
conservative folding it produces. Written with prd-30 wave 5 (2026-09-14).

## The value

520px, derived from the two caps the chip already declares rather than from anything observed:

| part | source | px |
|---|---|---|
| label | `max-w-[9rem]` | 144 |
| evidence | `max-w-[18rem]` | 288 |
| glyph | `ChipGlyph` | ~14 |
| age | `figures` span | ~40 |
| three inner gaps | `gap-1.5` | 18 |
| padding | `px-1.5` either side | 12 |
| border | 1px either side | 2 |
| | | **518 → 520** |

**Derived, not measured, and that is the point.** The widest chip on fixture `3` is 462px. A
constant tuned to that would under-fold the moment a real lane carried a longer name or a
longer trespass path — and under-folding is the failure this note's issue was filed for.

## Why the estimate is deliberately high

`chipCapacity` assumes *every* chip is this wide, so it can fold a chip that would in fact have
fitted. The asymmetry is the whole design:

- **Over-folding** names one fewer lane and counts it in `+N`. The reader is told the truth and
  can press `v` for the list.
- **Under-folding** puts a chip past the right edge with nothing to say so. That is the defect:
  measured at 1440×900 on `main` at `a893af22`, the row had 563px for 1522px of chips, and the
  `+1` marker sat at x=2381 — 941px off screen. It read as "one more", with three hidden.

A guess that costs a name is recoverable. A guess that hides a frozen lane is not.

## What it means at the sizes that matter

| viewport | wrapper | **measured row** | chips named | counted |
|---|---|---|---|---|
| 1440×900 | 563px | **544px** | 1 | +4 |
| 1100×760 (`WINDOW_MIN_WIDTH`) | 223px | **204px** | 0 | +5 |

The two width columns are why this note exists in the form it does. The `+N` marker is a
sibling of the clipping row, so the flex split removes it and its gap before the row is
measured — 19px. `chipCapacity` is fed the **measured row** and must not reserve the marker a
second time. A version that did passed every unit test, because the tests fed it the wrapper
width, and named zero lanes on screen at the primary target viewport. The numbers above are
transcribed from Chromium on fixture 3; the capacity tests use them directly.

One named chip at the primary target is not generous, and it is **not** what this note is
defending. It is what the current layout affords: the chip row starts 848px from the left at
*both* widths, because the title and provenance block left of the alarm bar does not yield. Reclaiming that space is the
change that lets the strip name three or four lanes; it was ruled out of this issue's fence and
belongs in its own issue. Until then, naming one honestly beats naming four and hiding three.

**No issue number is cited above**, deliberately. `doc-citation-law`'s ceiling is the highest
merged PR on `main`, so a freshly filed issue sits above it and reads as a prior-tracker
citation. `docs/prds/` is excluded from that law; `docs/design-notes/` is not.

## If you change a cap

`max-w-[9rem]` and `max-w-[18rem]` and this constant are one fact written twice. Change either
cap and this moves with it — `chipCapacity`'s boundary tests (539px names one, 538px names none)
fail if it does not, which is the point of pinning a boundary rather than a band.
