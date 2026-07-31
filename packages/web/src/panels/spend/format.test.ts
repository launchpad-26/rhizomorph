import { describe, expect, it } from 'vitest'
import { formatUsd } from '../../lib/format.js'
import { formatCostOrGap, formatCostOverhead, selectCostOverhead } from './format.js'

describe('selectCostOverhead', () => {
  const authoritative = { costEventCount: 1, costIsAuthoritative: true as boolean | null }
  const estimated = { costEventCount: 1, costIsAuthoritative: false as boolean | null }
  const uninstrumented = { costUsd: 0, costEventCount: 0, costIsAuthoritative: null as boolean | null }

  it('is a gap, never a ratio, when the conductor has sent no cost event', () => {
    const overhead = selectCostOverhead({ costUsd: 1.5, ...authoritative }, uninstrumented)
    expect(overhead.conductorInstrumented).toBe(false)
    expect(overhead.ratio).toBeNull()
  })

  it('is a gap even when the conductor has token-only telemetry but zero cost', () => {
    // The exact regression this guards: sessionlog --extra-sessions tags a whole
    // directory role: conductor with tokens and no dollars at all.
    const overhead = selectCostOverhead({ costUsd: 1.5, ...authoritative }, {
      costUsd: 0,
      costEventCount: 0,
      costIsAuthoritative: null,
    })
    expect(overhead.conductorInstrumented).toBe(false)
    expect(overhead.ratio).toBeNull()
  })

  it('is unknown, not a ratio, when the worker side has no cost yet', () => {
    const overhead = selectCostOverhead(uninstrumented, { costUsd: 0.9, ...authoritative })
    expect(overhead.conductorInstrumented).toBe(true)
    expect(overhead.ratio).toBeNull()
  })

  it('divides conductor cost by worker cost when both are instrumented', () => {
    const overhead = selectCostOverhead(
      { costUsd: 1.01, ...authoritative },
      { costUsd: 1.61, ...authoritative },
    )
    expect(overhead.conductorInstrumented).toBe(true)
    expect(overhead.ratio).toBeCloseTo(1.594059, 5)
    expect(overhead.mixedProvenance).toBe(false)
  })

  it('flags mixed provenance when either side includes an estimate', () => {
    const overhead = selectCostOverhead(
      { costUsd: 1.01, ...estimated },
      { costUsd: 1.61, ...authoritative },
    )
    expect(overhead.mixedProvenance).toBe(true)
  })
})

describe('formatCostOverhead', () => {
  it('renders an un-instrumented conductor as an actionable gap, never 0.00×', () => {
    expect(
      formatCostOverhead({ conductorInstrumented: false, ratio: null, mixedProvenance: false }),
    ).toBe('conductor not instrumented — see docs/telemetry.md')
  })

  it('renders a missing worker side as unknown, distinct from the conductor gap', () => {
    expect(
      formatCostOverhead({ conductorInstrumented: true, ratio: null, mixedProvenance: false }),
    ).toBe('unknown — no worker cost yet')
  })

  it('formats a known ratio to two decimal places with a × suffix', () => {
    expect(
      formatCostOverhead({ conductorInstrumented: true, ratio: 1.837742, mixedProvenance: false }),
    ).toBe('overhead 1.84×')
  })

  it('notes mixed provenance without hiding the ratio', () => {
    expect(
      formatCostOverhead({ conductorInstrumented: true, ratio: 0.5, mixedProvenance: true }),
    ).toBe('overhead 0.50× (incl. estimate)')
  })
})

describe('formatCostOrGap', () => {
  it('renders a real zero cost as $0.00 when a cost event actually reported it', () => {
    expect(formatCostOrGap({ costUsd: 0, costEventCount: 1 })).toBe('$0.00')
  })

  it('renders no cost events as an explicit gap, never the real-zero $0.00', () => {
    expect(formatCostOrGap({ costUsd: 0, costEventCount: 0 })).toBe('no cost data')
  })

  it('formats an ordinary known cost normally', () => {
    expect(formatCostOrGap({ costUsd: 0.42, costEventCount: 3 })).toBe('$0.42')
  })
})
