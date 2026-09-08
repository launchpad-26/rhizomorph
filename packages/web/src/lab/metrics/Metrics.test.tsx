import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import type { LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import { EMPTY_COPY, Metrics, NO_RATE_COPY } from './Metrics.js'

afterEach(cleanup)

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
function outcome(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}
function run(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x', ...(measured === undefined ? {} : { outcome: measured }) }
}
function experiment(forkId: string, arms: LabExperiment['arms'], parentLane = 'feature'): LabExperiment {
  return { forkId, parentLane, checkpointId: 'ckpt-1', arms }
}

/** An estimate route stub: available with a rate, or the honest refusal. */
function estimates(byLane: Record<string, { costUsdPerHour: number } | { reason: string }>): FetchLike {
  return (async (input: string | URL | Request) => {
    const href = String(input)
    const lane = decodeURIComponent(new URL(href, 'http://x').searchParams.get('lane') ?? '')
    const answer = byLane[lane]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({ error: 'no such lane' }) } as Response
    const body =
      'reason' in answer
        ? { lane, arms: 1, available: false, reason: answer.reason }
        : { lane, arms: 1, available: true, windowMs: 3_600_000, costUsdPerHour: answer.costUsdPerHour, estimatedTotalUsd: answer.costUsdPerHour }
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as FetchLike
}

const MEASURED = experiment('fork-1', [
  {
    arm: 1,
    treatment: { model: 'opus', promptDigest: null },
    runs: [run('a1', 1, outcome({ verified: 'pass', costUsd: 2 })), run('a2', 2, outcome({ verified: 'pass', costUsd: 3 })), run('a3', 3, outcome({ verified: 'fail', costUsd: 1, verifiedDetail: 'x' }))],
  },
  {
    arm: 2,
    treatment: { model: 'sonnet', promptDigest: null },
    runs: [run('b1', 1, outcome({ verified: 'pass', costUsd: 4 })), run('b2', 2), run('b3', 3, outcome({ verified: 'not-run', costUsd: null }))],
  },
])

describe('Metrics (prd53 S4, #328)', () => {
  it('every rendered figure has an adjacent basis element — the DOM law', async () => {
    render(<Metrics experiments={[MEASURED]} fetchImpl={estimates({ feature: { costUsdPerHour: 1.5 } })} />)
    await waitFor(() => expect(document.querySelector('[data-figure="rate"]')).not.toBeNull())
    const figures = [...document.querySelectorAll('[data-figure]')]
    expect(figures.length).toBeGreaterThanOrEqual(2)
    for (const figure of figures) {
      const basis = figure.parentElement?.querySelector(`[data-basis="${figure.getAttribute('data-figure')}"]`)
      expect(basis, `${figure.textContent} has no basis beside it`).not.toBeNull()
    }
  })

  it('the spend is the sum of the measured, booked runs only — and says what it excluded, never counting it as zero', () => {
    render(<Metrics experiments={[MEASURED]} fetchImpl={estimates({})} />)
    expect(document.querySelector('[data-figure="spend"]')?.textContent).toBe('$10.00')
    expect(screen.getByTestId('metrics-exclusion-fork-1').textContent).toMatch(/2 runs not measured/)
  })

  it('a below-floor arm renders a track with the refusal copy — on the scale, not omitted from it', () => {
    render(<Metrics experiments={[MEASURED]} fetchImpl={estimates({})} />)
    expect(screen.queryByTestId('metrics-refusal-fork-1-1')).toBeNull()
    expect(screen.getByTestId('metrics-arm-fork-1-1').textContent).toMatch(/3 of 3 completed — a summary may be stated/)
    expect(screen.getByTestId('metrics-refusal-fork-1-2').textContent).toMatch(/refuses to summarise — 1 of 3 completed, needs 3/)
  })

  it('not-run and unmeasured rows carry no numeric cell', () => {
    render(<Metrics experiments={[MEASURED]} fetchImpl={estimates({})} />)
    expect(screen.getByTestId('metrics-run-lane-a1').querySelectorAll('[data-numeric]')).toHaveLength(1)
    expect(screen.getByTestId('metrics-run-lane-b2').querySelectorAll('[data-numeric]')).toHaveLength(0)
    expect(screen.getByTestId('metrics-run-lane-b3').querySelectorAll('[data-numeric]')).toHaveLength(0)
    expect(screen.getByTestId('metrics-run-lane-b2').dataset.verified).toBe('not measured')
    expect(screen.getByTestId('metrics-run-lane-b3').dataset.verified).toBe('not-run')
  })

  it('a lane with no booked rate says so in the estimate route\'s own terms, never $0/h', async () => {
    render(<Metrics experiments={[MEASURED]} fetchImpl={estimates({ feature: { reason: 'no spend in the last hour' } })} />)
    await waitFor(() => expect(screen.getByTestId('metrics-no-rate-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('metrics-no-rate-fork-1').textContent).toBe(NO_RATE_COPY)
    expect(document.querySelector('[data-figure="rate"]')).toBeNull()
  })

  it("a partial experiment states how many arms dispatched, and its spend is the dispatched arms' alone (ruling 7)", () => {
    render(<Metrics experiments={[MEASURED]} failedArmsByFork={{ 'fork-1': [{ arm: 3, error: 'restore failed' }] }} fetchImpl={estimates({})} />)
    expect(screen.getByTestId('metrics-partial-fork-1').textContent).toMatch(/2 of 3 arms dispatched — the spend is the spend of the 2 — arm 3: restore failed/)
    expect(document.querySelector('[data-figure="spend"]')?.textContent).toBe('$10.00')
  })

  it('Enter on a row opens its Compare; no control here changes a number', () => {
    const open = vi.fn()
    render(<Metrics experiments={[MEASURED]} onOpenCompare={open} fetchImpl={estimates({})} />)
    fireEvent.click(screen.getByTestId('metrics-open-fork-1'))
    expect(open).toHaveBeenCalledWith('fork-1')
    expect(document.querySelectorAll('input, select')).toHaveLength(0)
  })

  it('with no experiments, the same empty copy as Compare', () => {
    render(<Metrics experiments={[]} fetchImpl={estimates({})} />)
    expect(screen.getByTestId('metrics-empty').textContent).toBe(EMPTY_COPY)
  })
})
