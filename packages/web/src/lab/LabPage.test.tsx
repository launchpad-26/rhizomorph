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
      runs: [{ eventId: 'evt-6', dispatchedAt: 1500, laneHandle: 'fork-3-arm-1', worktreePath: '/tmp/arm-5' }],
      outcome: { verified: 'pass', verifiedDetail: null, costUsd: 3.5, durationMs: 4000, commits: 2 },
    },
    {
      arm: 2,
      treatment: { model: 'sonnet', promptDigest: null },
      runs: [{ eventId: 'evt-7', dispatchedAt: 1600, laneHandle: 'fork-3-arm-2', worktreePath: '/tmp/arm-6' }],
      outcome: { verified: 'not-run', verifiedDetail: 'checkpoint restore failed', costUsd: null, durationMs: null, commits: null },
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

  it('a running experiment (no arm measured yet) shows its arms without a comparison — never an empty one', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [CLEAN_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-experiment-no-comparison-fork-1')).toBeInTheDocument())
    expect(screen.queryByTestId('comparison-surface')).toBeNull()
  })

  it('an experiment with a measured arm renders the branching layout AND the comparison surface below it', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [MEASURED_EXPERIMENT])} />)

    await waitFor(() => expect(screen.getByTestId('lab-branching-fork-3')).toBeInTheDocument())
    expect(screen.getByTestId('lab-arm-path-fork-3-arm-1')).toHaveAttribute('data-arm-state', 'finished')
    expect(screen.getByTestId('lab-arm-path-fork-3-arm-2')).toHaveAttribute('data-arm-state', 'dead')
    expect(screen.getByTestId('comparison-surface')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-experiment-no-comparison-fork-3')).toBeNull()
  })
})
