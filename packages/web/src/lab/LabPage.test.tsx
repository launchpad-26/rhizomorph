import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../replay/api.js'
import { LabPage } from './LabPage.js'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/lab')
})

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
      requestedArms: 3,
    }
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} seedLaunchOutcomes={[outcome]} />)
    await waitFor(() => expect(screen.getByTestId('axis-marker-ckpt-1')).toBeInTheDocument())
    expect(screen.getByTestId('axis-marker-ckpt-1').dataset.failedArms).toBe('1')
    expect(screen.getByTestId('arm-failed-2').textContent).toMatch(/tmux server not running/)
    expect(screen.getByTestId('metrics-partial-fork-1').textContent).toMatch(/2 of 3 arms dispatched/)
  })

  it('a failed checkpoints read renders the error copy on the axis too, never the empty copy', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [], false, 500)} />)
    await waitFor(() => expect(screen.getByTestId('lab-axis-error')).toBeInTheDocument())
    expect(screen.queryByTestId('axis-empty')).toBeNull()
  })
})
