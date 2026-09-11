import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import { canvasHeightFor } from '../canvas/index.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'
import { Frame } from './Frame.js'

afterEach(cleanup)

const SEATED: LabCheckpoint = {
  eventId: 'evt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1000,
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
  eventIndex: 12,
  sessionCutByte: 460,
  sessionByteLength: 1000,
}

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2000 }
const HERE: LabExperiment = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [
        { eventId: 'a', dispatchedAt: 1, run: 1, laneHandle: 'l-a', worktreePath: '/x', outcome: { verified: 'pass', verifiedDetail: null, costUsd: 2, durationMs: 1, commits: 1, provenance } },
        { eventId: 'b', dispatchedAt: 1, run: 2, laneHandle: 'l-b', worktreePath: '/x' },
      ],
    },
  ],
}

/**
 * `/api/lab/telemetry` and `/api/lab/footprint`, stubbed (prd-55 ruling 6,
 * #402) — the same `{ ok, status, json }` cast `TraceDiff.test.tsx` uses for
 * `/api/lab/transcript`, so neither route's read reaches a real socket under
 * jsdom. Defaults answer both routes with an honest, empty, AVAILABLE
 * reading; a test that cares about a specific state passes its own body.
 */
function stubSeries(bodies: { telemetry?: unknown; footprint?: unknown } = {}): FetchLike {
  const telemetry = bodies.telemetry ?? { available: true, lane: SEATED.lane, atByte: SEATED.sessionCutByte, asOf: null, usage: [], costs: [], tools: [], activeTime: [] }
  const footprint = bodies.footprint ?? { available: true, lane: SEATED.lane, files: [], collisions: {} }
  return (async (input: string | URL | Request) => {
    const href = String(input)
    const body = href.includes('/api/lab/telemetry') ? telemetry : href.includes('/api/lab/footprint') ? footprint : { available: false, reason: 'unhandled in test stub' }
    return { ok: true, status: 200, json: async () => body } as Response
  }) as unknown as FetchLike
}

describe('Frame — one switch over five ways of looking (prd53 ruling 8, S1)', () => {
  it('keys 1–5 select the position, and each panel resolves the seated moment through the axis', () => {
    const onPosition = vi.fn()
    render(<Frame position={1} onPosition={onPosition} seated={SEATED} experiments={[]} fetchImpl={stubSeries()} />)
    for (const key of ['1', '2', '3', '4', '5']) {
      fireEvent.keyDown(screen.getByTestId('frame'), { key })
    }
    expect(onPosition.mock.calls.map((call) => call[0])).toEqual([1, 2, 3, 4, 5])
    expect(screen.getByTestId('frame-playhead').textContent).toContain('46 %')
  })

  it('the cost position books what was spent from the seated checkpoint, with its basis, excluding unmeasured runs', () => {
    render(<Frame position={2} onPosition={() => {}} seated={SEATED} experiments={[HERE, { ...HERE, forkId: 'fork-elsewhere', checkpointId: 'ckpt-9' }]} fetchImpl={stubSeries()} />)
    const row = screen.getByTestId('frame-cost-fork-1')
    expect(row.querySelector('[data-figure="cost"]')?.textContent).toBe('$2.00')
    expect(row.querySelector('[data-basis="cost"]')?.textContent).toMatch(/over 1 completed run/)
    expect(screen.queryByTestId('frame-cost-fork-elsewhere')).toBeNull()
  })

  it('the scene position draws the lane canvas for the experiments forked here — one ribbon per dispatch record — and says so when there is none (ruling 5, ruling 11)', () => {
    const { rerender } = render(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={stubSeries()} />)
    expect(screen.getByTestId('frame-scene-empty')).toBeInTheDocument()
    rerender(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[HERE]} failedArmsByFork={{ 'fork-1': [{ arm: 2, error: 'restore failed' }] }} fetchImpl={stubSeries()} />)
    const canvas = screen.getByTestId('lane-canvas-fork-1')
    expect(canvas.dataset.ribbons).toBe('2')
    expect(canvas.dataset.stubs).toBe('1')
    expect(screen.getByTestId('frame-scene').querySelector('[data-basis="scene"]')?.textContent).toMatch(/charter §8/)
  })

  it('mounts the canvas at the height its ribbons need — the picture\'s own function, never the frame\'s guess (prd-55 ruling 11)', () => {
    // Two runs and one stub: the height the canvas asks for, not a constant
    // and not an SVG-era stroke pitch. A frame that hands its own number back
    // reddens here, because the two numbers are only equal by construction.
    render(<Frame position={3} onPosition={() => {}} seated={SEATED} experiments={[HERE]} failedArmsByFork={{ 'fork-1': [{ arm: 2, error: 'restore failed' }] }} fetchImpl={stubSeries()} />)
    const canvas = screen.getByTestId('lane-canvas-fork-1')
    expect(canvas.dataset.height).toBe(String(canvasHeightFor(2, 1)))
    // …and it is a height a fan actually fits into: taller than the band's own margins.
    expect(Number(canvas.dataset.height)).toBeGreaterThan(canvasHeightFor(0, 0) - 1)
  })

  it('the divergence position reads what Trace read, or says how to make it, and slots in the workspace\'s Trace control when it hands one over', () => {
    const { rerender } = render(<Frame position={4} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={stubSeries()} />)
    expect(screen.getByTestId('frame-gap-divergence')).toBeInTheDocument()
    expect(screen.queryByTestId('frame-trace-control')).toBeNull()
    rerender(
      <Frame
        position={4}
        onPosition={() => {}}
        seated={SEATED}
        experiments={[]}
        divergence={{ armLabel: 'arm 1 · run 1', rows: 5, diverged: 2, added: 1, absent: 0 }}
        traceControl={<p data-testid="stand-in-trace">Trace, from the workspace</p>}
        fetchImpl={stubSeries()}
      />,
    )
    expect(screen.getByTestId('frame-divergence').textContent).toMatch(/2 of 5 steps diverged/)
    expect(screen.getByTestId('frame-divergence').querySelector('[data-basis]')).not.toBeNull()
    // The frame never interprets the slot's content — it renders exactly what it was handed.
    expect(screen.getByTestId('frame-trace-control').querySelector('[data-testid="stand-in-trace"]')).not.toBeNull()
  })

  it('with nothing seated, every position says to seat the playhead first — and reads neither route', async () => {
    const fetchImpl = vi.fn(stubSeries()) as unknown as FetchLike
    render(<Frame position={2} onPosition={() => {}} seated={null} experiments={[HERE]} fetchImpl={fetchImpl} />)
    expect(screen.getByTestId('frame-panel-2').textContent).toMatch(/seat the playhead/)
    expect(screen.queryByTestId('frame-playhead')).toBeNull()
    // Give any wrongly-scheduled effect a turn to fire, then prove it never did.
    await Promise.resolve()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('position 1 — telemetry (prd-55 ruling 6, #402): loading, refused and empty drawn before live (ruling 9)', () => {
    it('draws a stated refusal, with its basis, when the telemetry route cannot answer — never a series drawn from nothing', async () => {
      const fetchImpl = stubSeries({ telemetry: { available: false, reason: 'NO SUCH LANE "feature" in the lab\'s record' } })
      render(<Frame position={1} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-gap-telemetry')).toBeInTheDocument())
      expect(screen.getByTestId('frame-gap-telemetry').textContent).toMatch(/NO SUCH LANE "feature"/)
      expect(screen.getByTestId('frame-gap-telemetry').querySelector('[data-basis]')?.textContent).toMatch(/GET \/api\/lab\/telemetry/)
      expect(document.querySelectorAll('[data-figure]')).toHaveLength(0)
    })

    it('draws an honest empty reading — a known lane with nothing recorded by this byte is not the same fact as a refusal', async () => {
      const fetchImpl = stubSeries({ telemetry: { available: true, lane: 'feature', atByte: 460, asOf: null, usage: [], costs: [], tools: [], activeTime: [] } })
      render(<Frame position={1} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-telemetry-empty')).toBeInTheDocument())
      expect(screen.getByTestId('frame-telemetry-empty').textContent).toMatch(/no OTel readings recorded/)
      expect(screen.queryByTestId('frame-gap-telemetry')).toBeNull()
      expect(document.querySelectorAll('[data-figure]')).toHaveLength(0)
    })

    it('draws the live reading count with its basis — which readings, at which byte', async () => {
      const fetchImpl = stubSeries({
        telemetry: { available: true, lane: 'feature', atByte: 460, asOf: 1_700_000_000_000, usage: [{}], costs: [{}, {}], tools: [], activeTime: [] },
      })
      render(<Frame position={1} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-telemetry')).toBeInTheDocument())
      expect(screen.getByTestId('frame-telemetry').querySelector('[data-figure="telemetry"]')?.textContent).toBe('3 OTel readings')
      expect(screen.getByTestId('frame-telemetry').querySelector('[data-basis="telemetry"]')?.textContent).toMatch(/feature/)
    })
  })

  describe('position 5 — footprint (prd-55 ruling 6, #402): loading, refused and empty drawn before live (ruling 9)', () => {
    it('draws a stated refusal, with its basis, when the footprint route cannot answer — never a series drawn from nothing', async () => {
      const fetchImpl = stubSeries({ footprint: { available: false, reason: 'NO SUCH LANE "feature" in the fold\'s branch record' } })
      render(<Frame position={5} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-gap-footprint')).toBeInTheDocument())
      expect(screen.getByTestId('frame-gap-footprint').textContent).toMatch(/NO SUCH LANE "feature"/)
      expect(screen.getByTestId('frame-gap-footprint').querySelector('[data-basis]')?.textContent).toMatch(/selectFilesTouchedByBranch/)
      expect(document.querySelectorAll('[data-figure]')).toHaveLength(0)
    })

    it('draws an honest empty footprint — a known lane that has touched nothing yet is not the same fact as a refusal', async () => {
      const fetchImpl = stubSeries({ footprint: { available: true, lane: 'feature', files: [], collisions: {} } })
      render(<Frame position={5} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-footprint-empty')).toBeInTheDocument())
      expect(screen.queryByTestId('frame-gap-footprint')).toBeNull()
      expect(document.querySelectorAll('[data-figure]')).toHaveLength(0)
    })

    it('draws the live intersection — selectFilesTouchedByBranch ∩ selectCollisionMap, with its basis', async () => {
      const fetchImpl = stubSeries({ footprint: { available: true, lane: 'feature', files: ['src/shared.ts', 'src/feature-only.ts'], collisions: {} } })
      render(<Frame position={5} onPosition={() => {}} seated={SEATED} experiments={[]} fetchImpl={fetchImpl} />)

      await waitFor(() => expect(screen.getByTestId('frame-footprint')).toBeInTheDocument())
      expect(screen.getByTestId('frame-footprint').querySelector('[data-figure="footprint"]')?.textContent).toBe('2 files touched')
      expect(screen.getByTestId('frame-footprint').textContent).toContain('src/shared.ts')
      expect(screen.getByTestId('frame-footprint').querySelector('[data-basis="footprint"]')?.textContent).toMatch(/selectFilesTouchedByBranch ∩ selectCollisionMap/)
    })
  })
})
