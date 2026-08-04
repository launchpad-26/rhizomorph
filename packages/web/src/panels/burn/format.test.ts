import { describe, expect, it } from 'vitest'
import type { Burn } from '../../fleet/index.js'
import {
  CONDUCTOR_NOT_INSTRUMENTED_GAP,
  NO_COST_FEED_GAP,
  burnRateHoverTitle,
  dollarsHoverTitle,
  errorCount,
  errorsHoverTitle,
  formatBurnRate,
  formatDollarsOrGap,
  formatOverheadOrGap,
  isDollarsGap,
  isOverheadGap,
  outputHoverTitle,
  overheadHoverTitle,
} from './format.js'

const BASE_BURN: Burn = {
  outputTokens: 1_234_567,
  tokens: { input: 4_000, output: 1_234_567, cacheRead: 900_000, cacheCreation: 12_000, total: 2_150_567 },
  costUsd: 42.556,
  costIsAuthoritative: true,
  costEventCount: 40,
  outputPerMin: 1_500,
  costUsdPerHour: 12.3456,
  overheadRatio: 0.4231,
  conductorInstrumented: true,
  windowMs: 300_000,
  errorCount: 2,
  errorBlockedCount: 1,
  errorParkedCount: 0,
  errorOffFenceCount: 1,
}

describe('formatDollarsOrGap / isDollarsGap', () => {
  it('renders the authoritative dollar figure, never a bare estimate warning', () => {
    expect(formatDollarsOrGap(BASE_BURN)).toBe('$42.56')
    expect(isDollarsGap(BASE_BURN)).toBe(false)
  })

  it('speaks the gap voice, never $0.00, when no cost event has ever arrived', () => {
    const burn = { ...BASE_BURN, costUsd: 0, costIsAuthoritative: null, costEventCount: 0 }
    expect(formatDollarsOrGap(burn)).toBe(NO_COST_FEED_GAP)
    expect(isDollarsGap(burn)).toBe(true)
  })

  it('still renders a real, non-zero dollar figure when the read is a mixed estimate', () => {
    const burn = { ...BASE_BURN, costIsAuthoritative: false }
    expect(formatDollarsOrGap(burn)).toBe('$42.56')
    expect(dollarsHoverTitle(burn)).toContain('estimate')
  })
})

describe('dollarsHoverTitle', () => {
  it('carries more precision than the headline figure ever shows', () => {
    const title = dollarsHoverTitle(BASE_BURN)
    expect(title).toContain('42.556000')
    expect(title).toContain('authoritative')
  })
})

describe('formatBurnRate', () => {
  it('renders $/hr once dollars are authoritative', () => {
    expect(formatBurnRate(BASE_BURN)).toBe('$12.35/hr')
  })

  it('falls back to out-tok/min when dollars are not authoritative', () => {
    const burn = { ...BASE_BURN, costIsAuthoritative: null }
    expect(formatBurnRate(burn)).toBe('1.5K out-tok/min')
  })

  it('falls back to out-tok/min for a mixed/estimated read too — ruling 13 says authoritative', () => {
    const burn = { ...BASE_BURN, costIsAuthoritative: false }
    expect(formatBurnRate(burn)).toBe('1.5K out-tok/min')
  })
})

describe('burnRateHoverTitle', () => {
  it('shows the exact out-tok/min count regardless of which unit is headlined', () => {
    expect(burnRateHoverTitle(BASE_BURN)).toContain('1,500 out-tok/min')
  })
})

describe('formatOverheadOrGap / isOverheadGap', () => {
  it('renders the conductor ÷ worker output ratio', () => {
    expect(formatOverheadOrGap(BASE_BURN)).toBe('0.42×')
    expect(isOverheadGap(BASE_BURN)).toBe(false)
  })

  it('speaks the exact conductor-not-instrumented gap line', () => {
    const burn = { ...BASE_BURN, conductorInstrumented: false }
    expect(formatOverheadOrGap(burn)).toBe(CONDUCTOR_NOT_INSTRUMENTED_GAP)
    expect(isOverheadGap(burn)).toBe(true)
  })

  it('is gated on cost-event instrumentation, not on the ratio itself', () => {
    // A conductor whose tokens arrived via `--extra-sessions` with no cost
    // telemetry behind them: the exact "worse than absent" shape architecture.md
    // documents (issue #47) — a real ratio must not paper over it.
    const burn = { ...BASE_BURN, conductorInstrumented: false, overheadRatio: 0.9 }
    expect(formatOverheadOrGap(burn)).toBe(CONDUCTOR_NOT_INSTRUMENTED_GAP)
  })

  it('reads as unknown, never 0×, when the conductor is instrumented but a side has no output yet', () => {
    const burn = { ...BASE_BURN, overheadRatio: null }
    expect(formatOverheadOrGap(burn)).not.toContain('0.00')
    expect(formatOverheadOrGap(burn)).toBe('unknown — no worker output yet')
  })
})

describe('overheadHoverTitle', () => {
  it('carries more precision than the two-decimal headline', () => {
    expect(overheadHoverTitle(BASE_BURN)).toContain('0.4231×')
  })
})

describe('outputHoverTitle', () => {
  it('carries the exact comma-grouped count and the full tier breakdown', () => {
    const title = outputHoverTitle(BASE_BURN.tokens)
    expect(title).toContain('1,234,567')
    expect(title).toContain('cache read')
  })
})

describe('errorCount / errorsHoverTitle (issue #159)', () => {
  it('reads the fleet-computed total straight through', () => {
    expect(errorCount(BASE_BURN)).toBe(2)
  })

  it('defaults to a calm zero for a fixture built before this field existed', () => {
    expect(errorCount({ ...BASE_BURN, errorCount: undefined })).toBe(0)
  })

  it('breaks the total down into blocked/parked/off-fence on hover', () => {
    const title = errorsHoverTitle(BASE_BURN)
    expect(title).toContain('2 exactly')
    expect(title).toContain('1 blocked')
    expect(title).toContain('0 parked')
    expect(title).toContain('1 off-fence')
  })
})
