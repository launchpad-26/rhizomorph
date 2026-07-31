import { describe, expect, it } from 'vitest'
import { formatSpend } from './format.js'

const BASE = {
  tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400, total: 189_504 },
  costUsd: 0,
  authoritativeCostUsd: 0,
  estimatedCostUsd: 0,
  costIsAuthoritative: null as boolean | null,
  requestCount: 1,
  costEventCount: 0,
  estimatedCostEventCount: 0,
  toolCallCount: 0,
  models: [],
  roles: [],
  origins: [],
  firstTs: null,
  lastTs: null,
}

describe('formatSpend', () => {
  it('renders dollars once any cost event exists, authoritative or estimated', () => {
    expect(formatSpend({ ...BASE, costIsAuthoritative: true, costUsd: 1.5 })).toBe('$1.50')
    expect(formatSpend({ ...BASE, costIsAuthoritative: false, costUsd: 0.05 })).toBe('$0.05')
  })

  it('falls back to the output-led token figure, labelled, when no cost telemetry ever arrived', () => {
    expect(formatSpend(BASE)).toBe('3.1K tok out')
  })

  it('never renders the unlabelled all-tier total as the fallback', () => {
    const rendered = formatSpend(BASE)
    // total (189_504 -> "189.5K") must not appear; only the output tier does.
    expect(rendered).not.toContain('189.5K')
  })
})
