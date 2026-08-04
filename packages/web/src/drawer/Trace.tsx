import type { SessionState } from '@rhizomorph/core'
import { requestPanelFocus } from '../app/panelPrefs.js'
import { TraceTree } from '../trace/TraceTree.js'

/**
 * THE TRACE SECTION (prd9 B1a) — the drawer's own TRACE tab (#163: the whole
 * tab body, no self-imposed cap). Its own `FOCUS ↗` reaches `PanelGrid`'s
 * FOCUS TRACE the same way every other focus is reached: `requestPanelFocus`
 * is a plain function call, no fetch, no event channel — this file never
 * becomes a second way for the drawer to reach outside itself, and
 * `readonly.test.ts` scans it exactly like every other file here.
 *
 * The sole consumer of this component is `drawer/index.tsx`, so unlike
 * `Activity.tsx`/`WhySurface.tsx` (also shared with `LanePage`, outside this
 * issue's fence) there is no bounded-strip mode to keep around here — the
 * pinned-header-over-`flex-1 overflow-y-auto`-body shape is simply what this
 * section is now.
 */
export interface TraceSectionProps {
  state: SessionState
  lane: string
}

export function TraceSection({ state, lane }: TraceSectionProps) {
  return (
    <section data-testid="drawer-trace" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-baseline justify-between px-4 pb-1 pt-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Trace</h3>
        <button
          type="button"
          data-testid="trace-focus"
          onClick={() => requestPanelFocus('trace')}
          className="rounded border border-ice-850 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200"
        >
          Focus ↗
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 [scrollbar-gutter:stable]">
        <TraceTree state={state} lane={lane} />
      </div>
    </section>
  )
}
