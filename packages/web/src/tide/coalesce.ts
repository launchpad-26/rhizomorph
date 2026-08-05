import type { Band } from './bands.js'

/**
 * SUB-PIXEL SLIVERS ARE A MEASURED FAILURE MODE (prd13 ruling 4). The
 * felt-evidence pass against a live Grafana state timeline watched 1–2px bands
 * be unhoverable and unreadable, and the ruling's answer is that "a band below
 * the hover threshold must coalesce rather than render".
 *
 * `minSpanMs` is milliseconds, not pixels: **the pixel scale is the caller's
 * business**. A renderer that knows its width and its window converts one
 * hover-sized pixel budget into a duration and hands it here; this file has no
 * opinion about how wide the bar is, which is why it can be tested without one.
 *
 * ## What merging is allowed to cost
 *
 * Coalescing is lossy on purpose — the caller has declared a resolution below
 * which nothing is representable — so the laws bound the loss rather than deny
 * it:
 *
 * - **Total duration is preserved exactly.** Merging never invents or loses
 *   time; a band absorbs its neighbour's span in full.
 * - **The tiling survives**: still contiguous, still non-overlapping, still
 *   ending in exactly one open band.
 * - **A gap of `minSpanMs` or more is never swallowed.** Only a band shorter
 *   than the threshold is ever absorbed, and bands only ever grow, so a gap
 *   that is representable at the caller's resolution stays a gap. This is prd13
 *   ruling 8 held at the one place it could plausibly have been traded away for
 *   tidiness: absence must not become a state, and a *visible* absence
 *   certainly must not.
 * - **A state is never invented.** Every state in the output was in the input;
 *   coalescing can drop one, never conjure one, so an all-gap lane — the
 *   uninstrumented one ruling 8 is about — comes out all gap at every
 *   threshold.
 */

/**
 * Merges every band shorter than `minSpanMs` into a neighbour, repeatedly,
 * until no sliver is left or a single band remains.
 *
 * The order is deterministic and stated rather than incidental: the **shortest**
 * band goes first (leftmost on a tie), and it merges into whichever neighbour is
 * **longer** (the left one on a tie). Shortest-first means the least defensible
 * band is the one that dies; longer-neighbour means it dies into the reading
 * that has the most evidence behind it. Same input, same output, byte-equal.
 *
 * Expects one lane's bands in order, as {@link bandsFor} emits them. A single
 * band is returned untouched even when it is shorter than `minSpanMs` — there
 * is nothing to merge it into, and a lane with one short band is a young lane,
 * not a sliver.
 */
export function coalesce(bands: readonly Band[], minSpanMs: number): readonly Band[] {
  if (bands.length <= 1 || minSpanMs <= 0) return mergeAdjacent(bands)

  let working = mergeAdjacent(bands)

  while (working.length > 1) {
    const index = shortestBelow(working, minSpanMs)
    if (index === null) break

    const left = index > 0 ? (working[index - 1] as Band) : null
    const right = index + 1 < working.length ? (working[index + 1] as Band) : null
    // Longer neighbour wins; the left one on a tie. One of the two exists,
    // because a lone band never reaches here.
    const intoLeft = left !== null && (right === null || left.durationMs >= right.durationMs)

    const partnerIndex = intoLeft ? index - 1 : index + 1
    const partner = working[partnerIndex] as Band
    const short = working[index] as Band

    const merged = absorb(partner, short)
    const next = [...working]
    next.splice(Math.min(index, partnerIndex), 2, merged)
    working = mergeAdjacent(next)
  }

  return working
}

/** The shortest band under the threshold, leftmost on a tie. */
function shortestBelow(bands: readonly Band[], minSpanMs: number): number | null {
  let found: number | null = null
  let best = minSpanMs
  for (let i = 0; i < bands.length; i += 1) {
    const duration = (bands[i] as Band).durationMs
    if (duration < best) {
      best = duration
      found = i
    }
  }
  return found
}

/**
 * `keeper` takes over `victim`'s span. The keeper's identity survives — this is
 * the whole of what coalescing decides — and the span is the union of the two,
 * so the pair's duration is carried across untouched.
 *
 * Openness is a property of the *run*, not of a band's identity: if either side
 * was the open band, the merged band is open, so the last band of a coalesced
 * run is open exactly when the last band of the input was.
 */
function absorb(keeper: Band, victim: Band): Band {
  const startTs = Math.min(keeper.startTs, victim.startTs)
  const open = keeper.endTs === null || victim.endTs === null
  const endTs = open ? null : Math.max(keeper.endTs as number, victim.endTs as number)
  const durationMs = keeper.durationMs + victim.durationMs
  return keeper.kind === 'gap'
    ? { kind: 'gap', lane: keeper.lane, startTs, endTs, durationMs }
    : { kind: 'state', lane: keeper.lane, state: keeper.state, startTs, endTs, durationMs }
}

/**
 * Two abutting bands that say the same thing are one band. `bandsFor` never
 * emits such a pair, but absorbing a sliver from between two like neighbours
 * creates one, and leaving it would make the output depend on where the sliver
 * happened to be rather than on what the log said.
 */
function mergeAdjacent(bands: readonly Band[]): readonly Band[] {
  const out: Band[] = []
  for (const band of bands) {
    const previous = out[out.length - 1]
    if (previous !== undefined && sameReading(previous, band)) {
      out[out.length - 1] = absorb(previous, band)
      continue
    }
    out.push(band)
  }
  return out
}

function sameReading(a: Band, b: Band): boolean {
  if (a.lane !== b.lane) return false
  if (a.kind === 'gap' || b.kind === 'gap') return a.kind === b.kind
  return a.state === b.state
}
