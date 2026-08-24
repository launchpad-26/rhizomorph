/**
 * THE CONTROL VOCABULARY (professionalisation loop 11).
 *
 * Four components had each declared their own button classes — the tide dock,
 * the connect wizard, the instrument button and the rotate button — and the
 * four had already converged on the same decision by hand: `rounded border
 * px-2 py-1`, body ink, hover to primary, opacity when disabled. What differed
 * between them was only what each author forgot: one had no focus ring, one
 * had `opacity-40` where the others had 50, none had a minimum target size.
 * A primitive earns its existence exactly here — not by inventing a look but
 * by making the converged look converge the rest of the way.
 *
 * `rounded-ctl` named the radius here once; it is `rounded-none` now (an
 * operator's explicit request, 2026-08-24, applied sitewide — every corner
 * square, no exceptions for chrome). The token stayed a *decision* through
 * that change rather than becoming a stray literal: the value moved, the name
 * for it did not, so `controls.test.ts` still pins one string and every
 * consumer still says why by importing it rather than guessing.
 *
 * The floors every variant carries, as laws in `controls.test.ts`:
 * - `focus-ring` — keyboard visibility is not a per-component decision.
 * - `min-h-6` — 24px, WCAG 2.5.8's minimum target, on every control.
 * - `duration-(--duration-touch)` — hover moves at the theme's one touch speed.
 * - `rounded-none` — square, named once here rather than repeated 80 times.
 *
 * Three intensities, no status hue. A control is chrome; colour that MEANS
 * something (broken, waiting, done) belongs to facts, so a button may never
 * wear it — including the armed confirm step, which the house style renders
 * as emphasis (`BUTTON_PRIMARY`), not alarm: ending a session keeps the
 * recording, and a calm instrument does not paint reversible acts red.
 *
 * These are class strings, not components, on purpose: the repo's idiom is
 * JSX that shows its own element, and 80 existing buttons adopt a constant
 * with a one-line diff. A `<Button>` wrapper would re-house all of them to
 * express the same three decisions.
 */

const BUTTON_BASE =
  'focus-ring min-h-6 rounded-none border px-2 py-1 text-inst leading-none normal-case tracking-normal transition-[color,border-color] duration-(--duration-touch) disabled:opacity-50'

/** The chrome default: a visible control on a panel's own surface. */
export const BUTTON = `${BUTTON_BASE} border-(--line-strong) text-(--ink-body) not-disabled:hover:border-(--ink-dim) not-disabled:hover:text-(--ink-primary)`

/** The quiet variant: hairline border, for docks and dense strips where the chrome must recede. */
export const BUTTON_QUIET = `${BUTTON_BASE} border-(--line-hair) text-(--ink-body) not-disabled:hover:border-(--ink-dim) not-disabled:hover:text-(--ink-primary)`

/** Emphasis: the current step, the armed confirm, the one suggested act. Ink, not hue. */
export const BUTTON_PRIMARY = `${BUTTON_BASE} border-(--ink-dim) text-(--ink-primary) not-disabled:hover:border-(--ink-body)`

/** A text-entry surface: input or select, on the floor, primary ink. */
export const FIELD =
  'focus-ring min-h-6 max-w-full rounded-none border border-(--line-hair) bg-(--surface-floor) px-2 py-1 font-sans text-inst normal-case tracking-normal text-(--ink-primary)'
