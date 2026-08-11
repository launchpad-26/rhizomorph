import { useStream } from '../app/StreamContext.js'

/**
 * THE SAMPLE-FLEET AFFORDANCE (prd-19 ruling 6, wave 3, #259).
 *
 * `useStream()` already drives three logs — `live`, `fleet20` (twenty
 * synthetic lanes) and `pathology` (one lane per staged pathology) — but
 * until now the only way to reach the last two was pressing 1 / 2 / 3 on the
 * keyboard (`StreamContext.tsx`'s `useFixtureKeys`), an undiscoverable
 * secret. This file adds no state of its own and reaches into no stream
 * machinery: it is a thin read of the same `setSource`/`provenance` every
 * other surface already reads, wired to a button instead of a keypress.
 *
 * Ruling 6's law, restated: a fixture must never pass as live data. So
 * whenever `source !== 'live'` this control *becomes* the banner — the
 * fixture's own `provenance` string, verbatim, beside the one button that
 * undoes it — rather than a toast that fades or scrolls out of view.
 * `index.tsx` mounts it in the header, which never scrolls, on purpose: this
 * is meant to be a persistent tell, not a one-time notice.
 */
export function SampleFleetControl() {
  const { source, setSource, provenance } = useStream()

  if (source !== 'live') {
    return (
      <div data-testid="connect-sample" className="flex shrink-0 items-center gap-2">
        <span data-testid="connect-sample-banner" className="figures text-[11px] font-semibold text-notice">
          reading {provenance} — not the live log
        </span>
        <button
          type="button"
          data-testid="connect-sample-return"
          onClick={() => setSource('live')}
          className="shrink-0 rounded border border-notice/60 px-2 py-1 text-[10px] uppercase tracking-wider text-notice hover:border-notice hover:text-ice-100"
        >
          return to live
        </button>
      </div>
    )
  }

  return (
    <div data-testid="connect-sample" className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        data-testid="connect-sample-activate"
        onClick={() => setSource('fleet20')}
        className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
      >
        view a sample fleet
      </button>
      {/* The secret this control replaces, named rather than left for someone to stumble on. */}
      <span data-testid="connect-sample-keys" className="text-[10px] text-ice-400">
        or press 1 live · 2 sample fleet · 3 staged pathologies
      </span>
    </div>
  )
}
