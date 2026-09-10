import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import type { FetchLike } from '../replay/api.js'
import { LabPage } from './LabPage.js'
import type { LaunchFetchLike } from './launch/launch.js'
import type { MeasureFetchLike } from './measure.js'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/lab')
})

/**
 * Stands in for what `server/static.ts` stamps into `index.html` on a real
 * boot (ADR-0012): the page's two writes — the launch and the measurement —
 * read the token off the page and refuse before the wire without it.
 */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

async function click(element: Element | null) {
  await act(async () => {
    fireEvent.click(element as Element)
  })
}

const CHECKPOINT = {
  eventId: 'evt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: Date.UTC(2026, 7, 6, 12, 0, 0),
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
  eventIndex: 12,
  sessionCutByte: 11_840,
  sessionByteLength: 40_000,
}

const CLEAN_EXPERIMENT = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [{ eventId: 'evt-2', dispatchedAt: 1100, laneHandle: 'fork-1-arm-1', worktreePath: '/tmp/arm-1' }],
    },
    {
      arm: 2,
      treatment: { model: 'sonnet', promptDigest: null },
      runs: [{ eventId: 'evt-3', dispatchedAt: 1200, laneHandle: 'fork-1-arm-2', worktreePath: '/tmp/arm-2' }],
    },
  ],
}

const CONFOUNDED_EXPERIMENT = {
  forkId: 'fork-2',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: 'a'.repeat(64) },
      runs: [{ eventId: 'evt-4', dispatchedAt: 1300, laneHandle: 'fork-2-arm-1', worktreePath: '/tmp/arm-3' }],
    },
    {
      arm: 2,
      treatment: { model: 'sonnet', promptDigest: 'b'.repeat(64) },
      runs: [{ eventId: 'evt-5', dispatchedAt: 1400, laneHandle: 'fork-2-arm-2', worktreePath: '/tmp/arm-4' }],
    },
  ],
}

/** One arm recorded — a launch that dispatched exactly one arm before its next one failed (prd-55 ruling 7's "never attempted" gap). */
const SINGLE_ARM_EXPERIMENT = {
  forkId: 'fork-9',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [{ eventId: 'evt-9', dispatchedAt: 1700, laneHandle: 'fork-9-arm-1', worktreePath: '/tmp/arm-9' }],
    },
  ],
}

const MEASURED_EXPERIMENT = {
  forkId: 'fork-3',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'opus', promptDigest: null },
      runs: [
        {
          eventId: 'evt-6',
          dispatchedAt: 1500,
          run: 1,
          laneHandle: 'fork-3-arm-1',
          worktreePath: '/tmp/arm-5',
          // prd53 ruling 3: the outcome is the RUN's, with its provenance.
          outcome: { verified: 'pass', verifiedDetail: null, costUsd: 3.5, durationMs: 4000, commits: 2, provenance: { source: 'measure-route', verifyCommand: 'npm test', measuredAt: 2000 } },
        },
      ],
    },
    {
      arm: 2,
      treatment: { model: 'sonnet', promptDigest: null },
      runs: [
        {
          eventId: 'evt-7',
          dispatchedAt: 1600,
          run: 1,
          laneHandle: 'fork-3-arm-2',
          worktreePath: '/tmp/arm-6',
          outcome: { verified: 'not-run', verifiedDetail: 'checkpoint restore failed', costUsd: null, durationMs: null, commits: null, provenance: { source: 'measure-route', verifyCommand: 'npm test', measuredAt: 2000 } },
        },
      ],
    },
  ],
}

function fetchImplFor(checkpoints: unknown[], experiments: unknown[], ok = true, status = 200): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/lab/checkpoints') {
      return { ok, status, json: async () => ({ checkpoints }) } as Response
    }
    if (href === '/api/lab/experiments') {
      return { ok, status, json: async () => ({ experiments }) } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

describe('LabPage', () => {
  it('renders the persistent nav (#549, prd-32 ruling 10) — this surface was reachable by URL only before', async () => {
    window.history.replaceState(null, '', '/lab')
    render(<LabPage fetchImpl={fetchImplFor([], [])} />)

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByTestId('nav-lab').getAttribute('aria-current')).toBe('page')
  })

  it('shows the honest "no experiments yet" and "no checkpoints yet" states — never a bare blank page', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [])} />)

    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-empty')).toBeInTheDocument())
    expect(screen.getByTestId('lab-experiments-empty')).toBeInTheDocument()
  })

  it('lists a captured checkpoint', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)

    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-table')).toBeInTheDocument())
    const row = screen.getByTestId('lab-checkpoint-row-ckpt-1')
    expect(row).toHaveTextContent('feature')
    expect(row).toHaveTextContent('operator')
  })

  it('lists an experiment, its arms, and names when arms are cleanly controlled (ruling 2)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [CLEAN_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('lab-branching-arm-fork-1-1')).toHaveTextContent('opus')
    expect(screen.getByTestId('lab-branching-arm-fork-1-2')).toHaveTextContent('sonnet')
    expect(screen.getByTestId('lab-experiment-dimensions-fork-1')).toHaveTextContent('model only')
  })

  it('names a confounded experiment honestly — never a silent conclusion (ruling 2)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [CONFOUNDED_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-2')).toBeInTheDocument())
    expect(screen.getByTestId('lab-experiment-dimensions-fork-2')).toHaveTextContent(
      'model and brief — a difference cannot be attributed to either',
    )
  })

  it('distinguishes "cannot see" from "nothing yet" — a fetch failure gets its own honest sentence', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [], false, 500)} />)

    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-error')).toBeInTheDocument())
    expect(screen.getByTestId('lab-checkpoints-error')).toHaveTextContent('the lab cannot see')
    expect(screen.getByTestId('lab-experiments-error')).toHaveTextContent('the lab cannot see')
    expect(screen.queryByTestId('lab-checkpoints-empty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lab-experiments-empty')).not.toBeInTheDocument()
  })

  it('the back button returns to the balcony', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-empty')).toBeInTheDocument())

    await act(async () => {
      screen.getByTestId('lab-back').click()
    })

    expect(window.location.pathname).toBe('/')
  })

  it('renders no live-fleet surface — no scene, no panel, no fleet strip', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-empty')).toBeInTheDocument())

    expect(screen.queryByTestId('fleet-table')).toBeNull()
    expect(document.querySelector('[data-panel]')).toBeNull()
  })

  it('mounts the launch panel alongside checkpoints and experiments', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)
    await waitFor(() => expect(screen.getByTestId('launch-panel')).toBeInTheDocument())
  })

  it('renders a branching diagram for each experiment, one arm path per arm, in arm order', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [CLEAN_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-branching-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('lab-arm-path-fork-1-arm-1')).toHaveAttribute('data-arm-state', 'running')
    expect(screen.getByTestId('lab-arm-path-fork-1-arm-2')).toHaveAttribute('data-arm-state', 'running')
  })

  it('a running experiment (no run measured yet) says so, and its comparison renders every run as not measured — never an empty surface and never a number (prd53 S2)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [CLEAN_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-experiment-no-comparison-fork-1')).toBeInTheDocument())
    expect(screen.getByTestId('comparison-surface')).toBeInTheDocument()
    expect(screen.getAllByText('not measured yet — no outcome is invented in its place').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-testid="arm-spread"]')).toHaveLength(0)
  })

  it('an experiment with a measured arm renders the branching layout AND the comparison surface below it', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [MEASURED_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-branching-fork-3')).toBeInTheDocument())
    expect(screen.getByTestId('lab-arm-path-fork-3-arm-1')).toHaveAttribute('data-arm-state', 'finished')
    expect(screen.getByTestId('lab-arm-path-fork-3-arm-2')).toHaveAttribute('data-arm-state', 'dead')
    expect(screen.getByTestId('comparison-surface')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-experiment-no-comparison-fork-3')).toBeNull()
  })

  it('the session axis places the checkpoint by byte, and seating it puts the same x on the frame (prd53 S1)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)
    await waitFor(() => expect(screen.getByTestId('axis-marker-ckpt-1')).toBeInTheDocument())
    expect(screen.getByTestId('axis-marker-ckpt-1').dataset.x).not.toBe('unknown')
    await act(async () => {
      screen.getByTestId('axis-marker-ckpt-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(screen.getByTestId('axis-playhead').dataset.x).toStrictEqual(screen.getByTestId('frame-playhead').dataset.x)
  })

  it('fork-from-here lives on the seated marker and seats the launch panel on that checkpoint', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)
    await waitFor(() => expect(screen.getByTestId('axis-marker-ckpt-1')).toBeInTheDocument())
    expect(screen.queryByTestId('axis-fork-from-here')).toBeNull()
    await act(async () => {
      screen.getByTestId('axis-marker-ckpt-1').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      screen.getByTestId('axis-fork-from-here').click()
    })
    await waitFor(() => expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true))
  })

  it('a partial launch names its failed arm count at the marker and its failed arm in Compare and Metrics (prd53 ruling 7)', async () => {
    const outcome = {
      forkId: 'fork-1',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ arm: 1, model: 'opus', briefProvided: false, forkId: 'fork-1', laneHandle: 'fork-1-arm-1', worktreePath: '/tmp/arm-1', launched: true }],
      failed: { arm: 2, error: 'workmux: tmux server not running' },
      // Two arms asked for; the one that failed was the last of them, so there
      // is nothing after it to have been "never attempted" (that gap is its
      // own test below).
      requestedArms: 2,
    }
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} seedLaunchOutcomes={[outcome]} />)
    await waitFor(() => expect(screen.getByTestId('axis-marker-ckpt-1')).toBeInTheDocument())
    expect(screen.getByTestId('axis-marker-ckpt-1').dataset.failedArms).toBe('1')
    expect(screen.getByTestId('arm-failed-2').textContent).toMatch(/tmux server not running/)
    expect(screen.getByTestId('metrics-partial-fork-1').textContent).toMatch(/2 of 3 arms dispatched/)
  })

  it('every requested arm after the one that failed is present in Compare as never attempted, and Metrics counts the true gap — never dispatched + failed (prd-55 ruling 7)', async () => {
    const outcome = {
      forkId: 'fork-9',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ arm: 1, model: 'opus', briefProvided: false, forkId: 'fork-9', laneHandle: 'fork-9-arm-1', worktreePath: '/tmp/arm-9', launched: true }],
      failed: { arm: 2, error: 'workmux: tmux server not running' },
      // Four arms asked for; dispatch stopped at arm 2, so arms 3 and 4 never
      // ran at all — present in Compare, excluded from every spread, and said
      // to be a different thing than the arm that actually failed.
      requestedArms: 4,
    }
    render(<LabPage fetchImpl={fetchImplFor([], [SINGLE_ARM_EXPERIMENT])} seedLaunchOutcomes={[outcome]} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-9')).toBeInTheDocument())
    expect(screen.getByTestId('arm-failed-2').textContent).toMatch(/tmux server not running/)
    expect(screen.getByTestId('arm-failed-3').textContent).toMatch(/never attempted — dispatch stopped at arm 2/)
    expect(screen.getByTestId('arm-failed-4').textContent).toMatch(/never attempted — dispatch stopped at arm 2/)
    // Metrics' own denominator is never invented from dispatched + ONE failed
    // arm either: it is the true gap, one entry per requested arm that never
    // dispatched — 1 arm actually ran, 3 did not (1 failed, 2 never attempted).
    expect(screen.getByTestId('metrics-partial-fork-9').textContent).toMatch(/1 of 4 arms dispatched/)
  })

  it('a failed checkpoints read renders the error copy on the axis too, never the empty copy', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [], false, 500)} />)
    await waitFor(() => expect(screen.getByTestId('lab-axis-error')).toBeInTheDocument())
    expect(screen.queryByTestId('axis-empty')).toBeNull()
  })
})

const NO_RATE = { lane: 'feature', arms: 3, runs: 1, lanes: 3, available: false, reason: '"feature" has no recorded spend in the last hour' }

/**
 * A page whose experiments listing answers `before` on its first read and
 * `after` on every later one — so a re-read is observable as a change on
 * screen, and counted.
 */
function rereadingFetchImpl(before: unknown[], after: unknown[]): { fetchImpl: FetchLike; reads: () => number } {
  let experimentReads = 0
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
  const fetchImpl = ((async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/lab/checkpoints') return ok({ checkpoints: [CHECKPOINT] })
    if (href === '/api/lab/experiments') {
      experimentReads += 1
      return ok({ experiments: experimentReads === 1 ? before : after })
    }
    if (href.startsWith('/api/lab/estimate')) return ok(NO_RATE)
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown) as FetchLike
  return { fetchImpl, reads: () => experimentReads }
}

describe('LabPage — the lab re-reads its own record when it has changed it (prd-55 ruling 7)', () => {
  it('a newly launched experiment reaches Compare and Metrics without a page reload', async () => {
    const { fetchImpl, reads } = rereadingFetchImpl([], [CLEAN_EXPERIMENT])
    const launchFetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arms: [{ arm: 1, model: 'opus', briefProvided: false, forkId: 'fork-1', laneHandle: 'fork-1-arm-1', worktreePath: '/tmp/arm-1', launched: true }],
        failed: null,
      }),
    })) as unknown as LaunchFetchLike
    render(<LabPage fetchImpl={fetchImpl} launchFetchImpl={launchFetchImpl} />)

    // Before: an honest empty page, in both places.
    await waitFor(() => expect(screen.getByTestId('lab-experiments-empty')).toBeInTheDocument())
    expect(screen.getByTestId('metrics-empty')).toBeInTheDocument()
    expect(reads()).toBe(1)

    await waitFor(() => expect(screen.getByTestId('launch-checkpoint-ckpt-1')).toBeInTheDocument())
    await click(screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input'))
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    // After: the launch reported, the page read its experiments again, and the
    // new one is on the page — its panel, its comparison, its Metrics row.
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-1')).toBeInTheDocument())
    expect(launchFetchImpl).toHaveBeenCalledTimes(1)
    expect(reads()).toBe(2)
    expect(screen.getByTestId('comparison-surface')).toBeInTheDocument()
    expect(screen.getByTestId('metrics-spend-fork-1')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-experiments-empty')).toBeNull()
  })

  it('every experiment panel carries a measure control, and a successful measurement re-reads the workspace — the verdicts reach Compare and Metrics without a page reload (prd-55 ruling 7)', async () => {
    const { fetchImpl, reads } = rereadingFetchImpl([CLEAN_EXPERIMENT], [CLEAN_EXPERIMENT])
    const measureFetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        forkId: 'fork-1',
        verifyCommand: 'npm test',
        measured: [{ arm: 1, run: 1, laneHandle: 'fork-1-arm-1', verified: 'pass', verifiedDetail: null, commits: 2 }],
      }),
    })) as unknown as MeasureFetchLike
    render(<LabPage fetchImpl={fetchImpl} measureFetchImpl={measureFetchImpl} />)

    await waitFor(() => expect(screen.getByTestId('measure-control-fork-1')).toBeInTheDocument())
    expect(reads()).toBe(1)

    await click(screen.getByTestId('measure-fork-1'))
    await waitFor(() => expect(screen.getByTestId('measure-confirm-dialog-fork-1')).toBeInTheDocument())
    await click(screen.getByTestId('measure-confirm-fork-1'))

    await waitFor(() => expect(screen.getByTestId('measure-result-fork-1')).toBeInTheDocument())
    expect(measureFetchImpl).toHaveBeenCalledTimes(1)
    expect(reads()).toBe(2)
  })
})
