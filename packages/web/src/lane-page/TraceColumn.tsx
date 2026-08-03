import { useState } from 'react'
import type { SessionState } from '@rhizomorph/core'
import { TraceGantt, TraceTree } from '../trace/index.js'

/**
 * THE TRACE COLUMN (prd9 B1b) — #132's own `TraceTree`, given the room the
 * drawer never had. The lane page is where an operator goes DEEPER on one
 * lane, so its own gantt affordance is inline rather than a "focus" request
 * into a panel grid that does not exist here: a local toggle swaps the same
 * tree for #132's own `TraceGantt`, over the newest interaction, both read
 * straight off `state.traces` through the trace directory's own selectors —
 * nothing here counts a span or sums a duration itself.
 */
export interface TraceColumnProps {
  state: SessionState
  lane: string
}

export function TraceColumn({ state, lane }: TraceColumnProps) {
  const [view, setView] = useState<'tree' | 'gantt'>('tree')

  return (
    <section data-testid="lane-page-trace" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between px-1 pb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Trace</h3>
        <button
          type="button"
          data-testid="lane-page-trace-toggle"
          onClick={() => setView((current) => (current === 'tree' ? 'gantt' : 'tree'))}
          className="rounded border border-ice-850 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ice-400 hover:border-ice-600 hover:text-ice-200"
        >
          {view === 'tree' ? 'Gantt ↗' : 'Tree ↗'}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-1 [scrollbar-gutter:stable]">
        {view === 'tree' ? <TraceTree state={state} lane={lane} /> : <TraceGantt state={state} lane={lane} />}
      </div>
    </section>
  )
}
