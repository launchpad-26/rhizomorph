import { cleanup, render, screen } from '@testing-library/react'
import { createEvent, reduceAll } from '@observatory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFleet, type Burn, type CalmEvidence, type Fleet, type Ladder } from '../../fleet/buildFleet.js'
import BurnStrip from './index.js'

const { useFleetMock } = vi.hoisted(() => ({
  useFleetMock: vi.fn(),
}))

// The component reads only `useFleet` from the fleet barrel — mocking the
// whole specifier is safe because nothing else in this file (or in
// `index.tsx`) imports another value out of it. `buildFleet` for the one
// real-pipeline test below is imported straight from `buildFleet.js`
// instead, which this mock never touches.
vi.mock('../../fleet/index.js', () => ({ useFleet: useFleetMock }))

afterEach(() => {
  cleanup()
  useFleetMock.mockReset()
})

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

const CALM_EVIDENCE: CalmEvidence = {
  lanes: 0,
  working: 0,
  branchesChecked: 0,
  filesChecked: 0,
  collisions: 0,
  line: 'collisions: 0 — checked 0 branches / 0 files',
}

const CALM_LADDER: Ladder = { rank: 'calm', items: [], evidence: CALM_EVIDENCE }

const ZERO_BURN: Burn = {
  outputTokens: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  costUsd: 0,
  costIsAuthoritative: null,
  costEventCount: 0,
  outputPerMin: 0,
  costUsdPerHour: 0,
  overheadRatio: null,
  conductorInstrumented: false,
  windowMs: 300_000,
}

function makeFleet(burnOverrides: Partial<Burn> = {}): Fleet {
  return {
    now: NOW,
    root: {
      repoName: null,
      mainBranch: null,
      worktreePath: null,
      commitsHome: 0,
      landings: 0,
      conductorOutputTokens: 0,
      overheadRatio: null,
      lastCommitTs: null,
    },
    lanes: [],
    ladder: CALM_LADDER,
    rank: 'calm',
    burn: { ...ZERO_BURN, ...burnOverrides },
    collisions: [],
    gaps: [],
    hasLaneManifest: false,
    eventCount: 0,
  }
}

function renderWith(burnOverrides: Partial<Burn> = {}) {
  const fleet = makeFleet(burnOverrides)
  useFleetMock.mockReturnValue(fleet)
  return { ...render(<BurnStrip />), fleet }
}

describe('BurnStrip', () => {
  it('renders all four numbers from fixture state', () => {
    renderWith({
      outputTokens: 1_234_567,
      tokens: {
        input: 4_000,
        output: 1_234_567,
        cacheRead: 900_000,
        cacheCreation: 12_000,
        total: 2_150_567,
      },
      costUsd: 42.5,
      costIsAuthoritative: true,
      costEventCount: 40,
      outputPerMin: 1_500,
      costUsdPerHour: 12.34,
      overheadRatio: 0.42,
      conductorInstrumented: true,
    })

    expect(screen.getByTestId('burn-output-tokens').textContent).toContain('1.2M')
    expect(screen.getByTestId('burn-dollars').textContent).toBe('$42.50')
    expect(screen.getByTestId('burn-rate').textContent).toContain('$12.34/hr')
    expect(screen.getByTestId('burn-overhead').textContent).toContain('0.42×')
  })

  it('speaks the gap voice for dollars, never $0.00, when no cost feed has ever arrived', () => {
    const { container } = renderWith({ costUsd: 0, costIsAuthoritative: null, costEventCount: 0 })

    expect(screen.getByTestId('burn-dollars').textContent).toBe(
      'NO COST FEED (OTel) — dollars unavailable — run: eval "$(observatory env <lane>)"',
    )
    expect(container.textContent).not.toContain('$0.00')
  })

  it('speaks the gap voice for overhead when the conductor is not instrumented', () => {
    renderWith({ conductorInstrumented: false })

    expect(screen.getByTestId('burn-overhead').textContent).toContain(
      'CONDUCTOR NOT INSTRUMENTED — overhead ratio unknowable',
    )
  })

  it('carries full precision on hover for the output-tokens headline', () => {
    renderWith({
      outputTokens: 1_234_567,
      tokens: { input: 1, output: 1_234_567, cacheRead: 2, cacheCreation: 3, total: 1_234_573 },
    })

    const cell = screen.getByTestId('burn-output-tokens')
    expect(cell.textContent).toContain('1.2M')
    expect(cell.title).toContain('1,234,567')
    expect(cell.title).not.toBe(cell.textContent)
  })

  it('carries full precision on hover for dollars and overhead once both are live', () => {
    renderWith({
      costUsd: 42.556,
      costIsAuthoritative: true,
      costEventCount: 1,
      overheadRatio: 0.4231,
      conductorInstrumented: true,
    })

    expect(screen.getByTestId('burn-dollars').title).toContain('42.556000')
    expect(screen.getByTestId('burn-overhead').title).toContain('0.4231×')
  })

  it('never renders $0.00 anywhere, even alongside a real, tiny, non-zero cost', () => {
    const { container } = renderWith({
      costUsd: 0.001,
      costIsAuthoritative: true,
      costEventCount: 1,
      costUsdPerHour: 0.0036,
    })
    expect(container.textContent).not.toContain('$0.00')
  })
})

describe('BurnStrip — overhead ratio basis (real pipeline)', () => {
  it('renders conductor OUTPUT ÷ worker OUTPUT, not a total-token ratio, when tiers diverge', () => {
    // The conductor here is cache-read-heavy (a poll re-sending a growing
    // context) with tiny real output; the worker is the reverse. A total-token
    // ratio would read as roughly 350x; the output-only ratio the direction
    // asks for reads as 0.1x. This proves BurnStrip renders whatever
    // `buildFleet` actually computed, not a locally re-derived number.
    const events = [
      createEvent(
        'session.started',
        { sessionId: 'sess-1', repoPath: '/repo/observatory', repoName: 'observatory', mainBranch: 'main' },
        { id: 'e1', ts: NOW - 100_000 },
      ),
      createEvent(
        'llm.usage',
        {
          lane: 'conductor',
          role: 'conductor',
          model: 'claude-opus-5',
          tokens: { input: 5, output: 100, cacheRead: 900_000, cacheCreation: 5_000 },
        },
        { id: 'e2', ts: NOW - 50_000 },
      ),
      createEvent(
        'llm.cost',
        {
          lane: 'conductor',
          role: 'conductor',
          model: 'claude-opus-5',
          costUsd: 1,
          authoritative: true,
        },
        { id: 'e3', ts: NOW - 50_000, source: 'otel' },
      ),
      createEvent(
        'llm.usage',
        {
          lane: '80-burn-strip',
          role: 'worker',
          model: 'claude-opus-5',
          tokens: { input: 50, output: 1_000, cacheRead: 2_000, cacheCreation: 500 },
        },
        { id: 'e4', ts: NOW - 40_000 },
      ),
      createEvent(
        'llm.cost',
        {
          lane: '80-burn-strip',
          role: 'worker',
          model: 'claude-opus-5',
          costUsd: 2,
          authoritative: true,
        },
        { id: 'e5', ts: NOW - 40_000, source: 'otel' },
      ),
    ]

    const session = reduceAll(events)
    const fleet = buildFleet(session, { now: NOW })

    // The fixture is only useful if the two bases actually disagree.
    const totalRatio =
      (5 + 100 + 900_000 + 5_000) / (50 + 1_000 + 2_000 + 500)
    expect(fleet.burn.overheadRatio).toBeCloseTo(100 / 1_000, 5)
    expect(fleet.burn.overheadRatio).not.toBeCloseTo(totalRatio, 0)
    expect(fleet.burn.conductorInstrumented).toBe(true)

    useFleetMock.mockReturnValue(fleet)
    render(<BurnStrip />)

    expect(screen.getByTestId('burn-overhead').textContent).toContain('0.10×')
  })
})
