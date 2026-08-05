/**
 * LABELS WHEN THEY FIT; COLOUR WHEN THEY DO NOT (prd13 ruling 7). A band
 * decides whether it carries its state as text by comparing an estimated
 * label width against its own pixel width — never by measuring the DOM.
 *
 * A `canvas.measureText`/DOM measurement would make the answer depend on
 * which font actually loaded in which environment, which is exactly what
 * "tests deterministic … hermetic under 4x concurrency" rules out: two
 * workers measuring the same label could disagree. A fixed per-character
 * budget is a deliberate simplification in the other direction — it can be
 * conservative, never precise — and conservative is the safe side of ruling
 * 7's other half: "never clipped text." Undershooting hides a label that
 * would have fit; overshooting the threshold in this file would render text
 * that overflows its band, which the law forbids outright.
 */

/** A generous per-character budget — uppercase, tracked-out label text. */
const CHAR_PX = 6.5

/** Left+right padding a label needs inside its band before it counts as "fits". */
const LABEL_PADDING_PX = 8

export function estimateLabelWidthPx(text: string): number {
  return text.length * CHAR_PX
}

/** Whether `text` fits inside a band `bandWidthPx` wide, padding included. */
export function labelFits(bandWidthPx: number, text: string): boolean {
  return estimateLabelWidthPx(text) + LABEL_PADDING_PX <= bandWidthPx
}
