import { laneUrl, navigate } from '../../app/router.js'
import { useStream } from '../../app/StreamContext.js'
import { isMainSelected, useSelection } from '../../fleet/index.js'
import { TraceTree } from '../../trace/TraceTree.js'

/**
 * THE TRACE TAB (prd-32 ruling 5 / S3, #552) — the fourth tab of the dock.
 *
 * ## Why this file exists at all
 *
 * Until #562 the trace had two homes and neither was a panel: a compact tree in
 * the drawer's TRACE tab, and a `fixed inset-0` gantt (`trace/FocusPanel.tsx`)
 * reachable only from that tab's `FOCUS ↗`. prd-36 ruling 2 cut both — the
 * drawer became a peek and the focus panel had no address to be linked at. That
 * left prd-32's dock naming a `trace` tab with nothing behind it.
 *
 * So this is the trace's inline home: `trace/TraceTree.tsx`, unchanged, mounted
 * as a dock tab like every other panel. **The furniture is not touched** — this
 * file is mounting and the tab's own states, which is exactly what S3 scopes a
 * dock tab to.
 *
 * ## The states, and the one that is not an emptiness
 *
 * S3 asks every tab to voice its zero rather than hide. The trace has *two*
 * zeros and conflating them is the failure:
 *
 * - **no lane selected** — not an absence of telemetry, an absence of a
 *   question. The tab says which act produces an answer instead of implying the
 *   collectors are down.
 * - **a lane with no spans** — a real gap, and `trace/EmptyTrace.tsx` already
 *   speaks it in law 12's voice (what is missing, where it comes from). Reached
 *   by rendering `TraceTree`, never by re-deriving the check here.
 *
 * MAIN is the third case: the conductor is not a lane in the fold's trace
 * index, and its own spans live under the `conductor` telemetry lane, which the
 * run view already knows how to read. Sending the reader there beats drawing an
 * empty tree that looks like a broken conductor.
 *
 * **Depth stays at the address.** The gantt is the run view's
 * (`lane-page/TraceColumn.tsx`), so this tab carries a real link to it rather
 * than growing a second full-view of its own — the exact mistake `FocusPanel`
 * was.
 */
export default function TracePanel() {
  const { selectedId } = useSelection()
  const { state } = useStream()

  if (selectedId === null) {
    return (
      <p
        role="status"
        data-testid="trace-tab-no-lane"
        className="px-1 py-2 text-read-floor leading-snug text-(--ink-dim)"
      >
        NO LANE SELECTED — a trace is one lane's spans, so this tab has no subject until you pick
        one. Click a lane in the fleet above and its interactions appear here.
      </p>
    )
  }

  if (isMainSelected(selectedId)) {
    return (
      <p
        role="status"
        data-testid="trace-tab-main"
        className="px-1 py-2 text-read-floor leading-snug text-(--ink-dim)"
      >
        MAIN IS NOT A LANE HERE — the conductor's own spans are recorded under the{' '}
        <span className="font-mono">conductor</span> telemetry lane, which its run view reads.{' '}
        <RunViewLink handle={selectedId} />
      </p>
    )
  }

  return (
    <div data-testid="trace-tab" className="flex flex-col">
      <div className="px-1">
        <TraceTree state={state.session} lane={selectedId} />
      </div>
      <p className="mt-1 border-t border-(--line-hair) pt-1 text-inst text-(--ink-dim)">
        <RunViewLink handle={selectedId} />
      </p>
    </div>
  )
}

/**
 * The way to depth: a real `<a href>`, modifier-aware, routed in place on a
 * plain click — the same convention the peek's action and the fleet row's
 * drill-down use, so every path out of a surface behaves the same way in a
 * hand that has learned one of them.
 */
function RunViewLink({ handle }: { handle: string }) {
  const href = laneUrl(handle)
  return (
    <a
      href={href}
      data-testid="trace-tab-run-view"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(href)
      }}
      className="focus-ring rounded-none text-(--ink-body) underline hover:text-(--ink-primary)"
    >
      open the run view for the gantt and the full spine ↗
    </a>
  )
}
