import type { SessionState } from '@rhizomorph/core'
import { requestPanelFocus } from '../app/panelPrefs.js'
import { TraceTree } from '../trace/TraceTree.js'

/**
 * THE TRACE SECTION (prd9 B1a) — the compact tree, below the conversation
 * (prd4: conversation leads). Its own `FOCUS ↗` reaches `PanelGrid`'s FOCUS
 * TRACE the same way every other focus is reached: `requestPanelFocus` is a
 * plain function call, no fetch, no event channel — this file never becomes
 * a second way for the drawer to reach outside itself, and `readonly.test.ts`
 * scans it exactly like every other file here.
 */
export interface TraceSectionProps {
  state: SessionState
  lane: string
}

export function TraceSection({ state, lane }: TraceSectionProps) {
  return (
    <section
      data-testid="drawer-trace"
      className="max-h-64 shrink-0 overflow-auto border-t border-ice-850 px-4 py-3 [scrollbar-gutter:stable]"
    >
      <header className="flex items-baseline justify-between">
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
      <div className="mt-2">
        <TraceTree state={state} lane={lane} />
      </div>
    </section>
  )
}
