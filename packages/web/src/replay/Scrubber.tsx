import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { formatClockSeconds } from '../tide/duration.js'
import { formatElapsed } from './format.js'

/** One real chapter instant, for the drag label only — never a seek target of its own (that stays `onChange`/`onSeek`'s job). */
export interface ScrubberChapterMarker {
  ts: number
  label: string
}

export interface ScrubberProps {
  start: number
  end: number
  value: number
  onChange(ts: number): void
  disabled?: boolean
  /** Sorted or not — nearest-lookup is a linear scan either way. Used only for the drag label (research note §4 R2's YouTube idiom). */
  chapterMarkers?: readonly ScrubberChapterMarker[]
  /**
   * The scrub instant's headline facts, already in the caller's own voice —
   * `4 worktrees · 8 commits · $2.14` (#272). Preformatted rather than
   * structured on purpose: this component is chrome and owns no vocabulary for
   * what a fact *is*, so the surface that already knows (`replay/index.tsx`,
   * through `TideDock`) keeps the formatters and this keeps the placement.
   * `null` in live mode, where there is no scrub instant to describe.
   */
  facts?: string | null
}

/**
 * Chrome, not a panel (ruling 16): no border, no fill beyond the native
 * track — it reads as part of the frame around the app, not a widget inside
 * it. Keyboard affordances are the native range input's own (arrow keys,
 * Home/End, Page Up/Down) — kept by construction, never reimplemented. This
 * remains the law wave 3 (#169, prd13 ruling 10) is required to restate
 * stronger, not weaken: the TIDE's body is docked *around* this input — a
 * band above it sharing its x-axis, a zoom-out and a `«`/`»` pan flanking it
 * — but nothing here adds an `onKeyDown`, changes `type`, or otherwise stands
 * between the browser and this element's own native behaviour. A test in
 * `Scrubber.test.tsx` asserts a keydown on this input is never
 * `preventDefault`-ed by anything this component wires up.
 *
 * **Issue #186 defect 3/R3: a real `step`, not the browser's ms-scale
 * default.** `min`/`max` already configure native behaviour rather than
 * replace it; `step` joins them the same way — one arrow press now moves
 * ~0.1% of the session instead of one millisecond. This is the same
 * "configure, never reimplement" law the module note above already states;
 * it does not reopen it.
 *
 * **Issue #270: that step is one pixel of the rendered track, not a fixed
 * 1/1000 of the session.** `max(1000, span / 1000)` quantized the input to
 * ~1000 stops (fewer — one per second — on any session under ~17 minutes),
 * and those stops are not a pointer affordance: they are notches the thumb
 * jumps between, for the drag *and* for a playback position handed back
 * through `value`, which the browser rounds onto the same grid. The claim
 * that "keyboard stepping and pointer dragging want different granularities"
 * only holds while you assume the pointer wants a sub-pixel one. It cannot
 * use one: a drag can address exactly as many positions as the track has
 * pixels. So the two requirements meet at one pixel, and a single `step` does
 * serve both — a notch is never wider than a pixel, at any track width, for
 * any session long enough to afford one. "Long enough" is a fact about the
 * *track*, not about the session: the 1ms floor binds below
 * `2 ** ceil(log2(trackWidth))` ms of recording — 512ms at 480px, 1024ms at
 * 960px, 4096ms on a 4K dock — and inside that band a notch is wider than a
 * pixel (3.75px at 3840px for a two-second recording). That is still strictly
 * finer than what this replaced: `max(1000, span / 1000)` gave a 1.5-second
 * session one 1000ms notch of travel, and froze the slider outright — a
 * single stop, nothing else reachable — on anything under a second.
 * Meanwhile one arrow press moves half a pixel to a pixel of track, which on
 * a real dock is ~0.1% of the session: #186's calibration, held more honestly
 * than the 1-second floor held it on short recordings.
 *
 * This is deliberately the option that leaves the law above untouched — no
 * `onKeyDown`, no second granularity wired by hand, just a better-chosen
 * `step`. The cost, stated plainly: a seek from this input is now grid-
 * granular at roughly a pixel rather than 1/1000-granular, which on a track
 * narrower than 1000px is marginally coarser. No position a pointer can
 * address is unreachable at that granularity — `end` included, which
 * `notchCount` holds on the grid at every width and every session length by
 * *testing* the one thing that can take it off (see there), not by assuming
 * nothing can. The one branch where that is not true is the fallback below,
 * taken only when the track has no measurable width: `max(1000, span / 1000)`
 * leaves `end` up to 999ms off-grid on any sub-17-minute session that is not
 * a whole number of seconds. It is what shipped before this change, and the
 * layout effect means it never paints in a real browser. Precision seeking
 * goes through the TIDE's zoom.
 *
 * **Issue #186 defect 2/R2: the nearest chapter's label while dragging**
 * (the YouTube "chapter title appears as you scrub" idiom) — a plain label
 * above the thumb, shown only while a pointer is down on this input. It
 * reads `chapterMarkers` only to find the nearest one; it never seeks and
 * never becomes a second click target.
 *
 * The elapsed/remaining labels sit on their own line *below* the input,
 * rather than flanking it as they used to, so the input itself spans the
 * component's full width — the one measurement `TideDock` needs in order to
 * lay the TIDE's bands over the exact same x-axis as this track (prd13
 * ruling 1's "share one x-axis"), without a second, hand-tuned offset.
 */
export function Scrubber({ start, end, value, onChange, disabled = false, chapterMarkers = [], facts = null }: ScrubberProps) {
  const clamped = Math.min(end, Math.max(start, value))
  const span = Math.max(1, end - start)
  const [trackRef, trackWidth] = useTrackWidth()
  const step = trackWidth > 0 ? span / notchCount(span, trackWidth) : Math.max(1000, span / 1000)
  const [dragging, setDragging] = useState(false)

  const nearest = dragging ? nearestMarker(chapterMarkers, clamped) : null
  const thumbPercent = ((clamped - start) / span) * 100

  // #272. The absolute clock at the playhead, plus the instant's facts, in one
  // string used twice: painted beside the thumb, and handed to assistive tech
  // as the input's `aria-valuetext`. A range input otherwise announces the raw
  // epoch-millisecond `value`, which is not a time anyone can hear.
  const readout = facts === null ? formatClockSeconds(clamped) : `${formatClockSeconds(clamped)} · ${facts}`

  return (
    <div className="relative flex flex-1 flex-col normal-case tracking-normal">
      {nearest !== null && (
        <div
          aria-hidden="true"
          data-testid="scrubber-drag-label"
          className="pointer-events-none absolute -top-10 -translate-x-1/2 whitespace-nowrap rounded border border-(--line-strong) bg-(--surface-panel) px-1 py-0.5 text-inst-dense text-(--ink-primary)"
          style={{ left: `${thumbPercent}%` }}
        >
          {nearest.label}
        </div>
      )}
      {/*
        Co-located with the thumb and present at rest, which is the whole of
        #272: the facts it carries used to sit on a prose row at the bottom of
        the replay bar, the elapsed figures below the track, and the chapter's
        identity only on a 150 ms hover — four places, none of them where the
        operator is looking.

        `aria-hidden`, because the same text reaches assistive tech through the
        input's `aria-valuetext` instead. Announcing a live region that changes
        on every frame of a drag would be hostile; a value that is read when the
        value is asked for is not.
      */}
      <div
        aria-hidden="true"
        data-testid="scrubber-readout"
        className="figures pointer-events-none absolute -top-5 -translate-x-1/2 whitespace-nowrap rounded border border-(--line-strong) bg-(--surface-panel) px-1 py-0.5 text-inst-dense text-(--ink-primary)"
        style={{ left: `${thumbPercent}%` }}
      >
        {readout}
      </div>
      <input
        ref={trackRef}
        type="range"
        aria-label="Replay scrubber"
        aria-valuetext={readout}
        min={start}
        max={Math.max(start, end)}
        step={step}
        value={clamped}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        className="h-1 w-full accent-(--ink-primary)"
      />
      <div className="flex items-center justify-between text-inst-dense leading-none text-(--ink-dim)">
        <span className="figures">{formatElapsed(clamped - start)}</span>
        <span className="figures">{formatElapsed(end - start)}</span>
      </div>
    </div>
  )
}

/**
 * How many notches to cut the session into: the smallest power of two that is
 * at least the track's width in pixels — capped so a notch is never finer than
 * one millisecond, and never finer than the `step` attribute can carry.
 *
 * A power of two, and not the pixel count itself, because `end` has to *be* a
 * grid point. The grid is `min + n * step`, and both the browser and jsdom
 * test membership in decimal arithmetic on the serialized `step` attribute —
 * where `span / 1907` does not divide `span`, however close the doubles look.
 * The far end then rounds down to the previous notch and the last pixel of
 * track, `End`, and a drag to the right edge all land a full step short: up to
 * ~2.4 minutes on an eight-hour session at a narrow width. `span / 2 ** k` is
 * exact in binary and multiplies back to exactly `span`.
 *
 * Exact in binary is necessary and not sufficient, which is what
 * `serialisesExactly` is for. The attribute carries `String(step)` — the
 * *shortest* decimal that round-trips, not the exact quotient — and the two
 * part company once the exact quotient needs more than about 17 significant
 * digits. That first bites at `2 ** 28 + 1` ms (3.107 days) on a dock wide
 * enough to ask for 4096 notches, and then only sporadically: `2 ** 28 + 2` is
 * exact again, `+ 3` is 65.5 seconds short, `+ 4` exact. Since that boundary is
 * not a boundary, nothing here hardcodes one; the loop simply refuses a
 * doubling whose step would not survive being written down. The grid is as fine
 * as the pixels ask for wherever that is representable, and one power of two
 * coarser where it is not.
 *
 * Measured over widths 200…3840 and sessions from 500ms to 60 days: endpoint
 * shortfall is 0 everywhere; no recording of three days or less has its notch
 * count changed by the guard at all; and where the track asks for 1024 notches
 * or more the guard never returns fewer than 1024 — so even the guarded corner
 * stays finer than the 1000 stops this replaced.
 *
 * The cost of rounding the notch count up to a power of two is up to 2x more
 * notches than pixels — which is free, since a finer-than-pixel grid is still
 * invisible, and it is never *coarser* than a pixel.
 */
function notchCount(span: number, trackWidth: number): number {
  let notches = 1
  while (notches < trackWidth && notches * 2 <= span && serialisesExactly(span / (notches * 2))) {
    notches *= 2
  }
  return notches
}

/**
 * Whether `String(step)` — the text the `step` attribute actually carries —
 * denotes step's exact value rather than a rounded stand-in for it.
 *
 * ECMA-262 defines `Number::toString` as the shortest digit string that
 * round-trips, and among equally short candidates the one closest to the value.
 * So the written decimal is the exact expansion precisely when it carries as
 * many fractional digits as the exact expansion has — and for a double
 * `m * 2 ** -f` with `m` odd that is exactly `f`, because `m * 5 ** f` ends in
 * 5 and so the last digit is never a droppable zero. Doubling to integrality
 * recovers `f` without any arithmetic that could itself round.
 *
 * The alternative, writing the exact decimal out ourselves, is the only
 * *complete* answer and is rejected anyway: it needs BigInt on a render path
 * (the exact decimal passes 2 ** 53 at around 10.25 hours and 4096 notches),
 * and it moves the bet from `Number::toString` — specified, and checkable in
 * this suite — onto each engine's own step-attribute decimal parser, whose
 * coefficient is finite too. Digits an engine does not keep buy nothing, and
 * jsdom's parser keeps 20 of them, so such a test would pass here and still
 * fail in a browser. Asking for *less* precision is the direction every engine
 * can honour.
 */
function serialisesExactly(step: number): boolean {
  if (!Number.isFinite(step)) return false

  const text = String(step)
  const point = text.indexOf('.')
  const written = point === -1 ? 0 : text.length - point - 1

  let exact = 0
  for (let value = step; !Number.isInteger(value); value *= 2) exact += 1

  return written === exact
}

/**
 * The input's own rendered width in whole pixels — `0` until it is knowable,
 * which is the honest answer under a DOM that reports no layout at all
 * (jsdom) as well as before the first measurement. Same shape as `TideDock`'s
 * `useElementWidth`, deliberately: measure once, then follow a
 * `ResizeObserver` where the platform has one. A layout effect rather than a
 * plain one so the very first painted frame is already pixel-stepped, instead
 * of showing one frame snapped to the coarse fallback grid.
 *
 * That last sentence is not held by anything in `Scrubber.test.tsx`: swapping
 * this for `useEffect` leaves the suite green, because RTL flushes passive
 * effects inside `act()` before any assertion runs and jsdom never paints. That
 * is a gap in the harness, not permission — pinning it needs a real browser.
 */
function useTrackWidth(): [RefObject<HTMLInputElement | null>, number] {
  const ref = useRef<HTMLInputElement | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return

    const measure = () => setWidth(Math.max(0, Math.floor(el.getBoundingClientRect().width)))
    measure()

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [])

  return [ref, width]
}

function nearestMarker(
  markers: readonly ScrubberChapterMarker[],
  ts: number,
): ScrubberChapterMarker | null {
  let best: ScrubberChapterMarker | null = null
  let bestDist = Infinity
  for (const marker of markers) {
    const dist = Math.abs(marker.ts - ts)
    if (dist < bestDist) {
      bestDist = dist
      best = marker
    }
  }
  return best
}
