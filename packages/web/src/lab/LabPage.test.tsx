import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import type { FetchLike } from '../replay/api.js'
import { AXIS_EMPTY_COPY } from './axis/index.js'
import { LabPage, NO_CHECKPOINTS_COPY } from './LabPage.js'
import type { LaunchFetchLike } from './launch/launch.js'
import type { MeasureFetchLike } from './measure.js'
import type { RdFetchLike } from './rd/index.js'

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

  it('lists a captured checkpoint — one row in the rail, which is the whole listing since prd-55 ruling 8', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)

    await waitFor(() => expect(screen.getByTestId('lab-checkpoint-row-ckpt-1')).toBeInTheDocument())
    const row = screen.getByTestId('lab-checkpoint-row-ckpt-1')
    expect(row).toHaveTextContent('feature')
    expect(row).toHaveTextContent('operator')
    expect(row).toHaveTextContent('30 % of session')
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

    // Before: an honest empty page, in both regions — the rail says there is
    // nothing to list, the stage says nothing is open. Metrics is the SELECTED
    // experiment's reading now (ruling 8), so with nothing selected there is
    // no Metrics tab to be empty: the emptiness is stated once, where the
    // listing lives.
    await waitFor(() => expect(screen.getByTestId('lab-experiments-empty')).toBeInTheDocument())
    expect(screen.getByTestId('lab-stage-no-experiment')).toBeInTheDocument()
    expect(screen.queryByTestId('metrics-empty')).toBeNull()
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

/** Two arms of three runs each, all judged the same way — the arm whose notes collapse. */
const REPLICATE_EXPERIMENT = {
  forkId: 'fork-4',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [1, 2].map((armNumber) => ({
    arm: armNumber,
    treatment: { model: armNumber === 1 ? 'opus' : 'sonnet', promptDigest: null },
    runs: [1, 2, 3].map((runNumber) => ({
      eventId: `evt-${armNumber}-${runNumber}`,
      dispatchedAt: 1000 + runNumber,
      run: runNumber,
      laneHandle: `fork-4-arm-${armNumber}-run-${runNumber}`,
      worktreePath: `/work/${armNumber}-${runNumber}`,
      outcome: {
        verified: 'pass',
        verifiedDetail: null,
        costUsd: null,
        durationMs: null,
        commits: null,
        provenance: { source: 'measure-route', verifyCommand: 'npm test', measuredAt: 2000 },
      },
    })),
  })),
}

/**
 * prd-55 ruling 8's rearrangement, and ruling 9's insistence that every state
 * of every region is drawn before the live one. Each of these renders one
 * state and reads what the two regions say in it.
 */
describe('the workspace is one working screen (prd-55 ruling 8, S1-prime)', () => {
  it('two regions: a rail that lists, and a stage whose top is pinned', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-rail')).toBeInTheDocument())

    const pinned = screen.getByTestId('lab-stage-pinned')
    expect(pinned.className, 'the axis and the frame do not scroll away').toContain('sticky')
    expect(pinned.contains(screen.getByTestId('session-axis'))).toBe(true)
    expect(pinned.contains(screen.getByTestId('frame'))).toBe(true)
    expect(pinned.contains(screen.getByTestId('lab-tab-Compare')), 'the reading is not pinned; the top of the stage is').toBe(false)
  })

  it('THE CHECKPOINT TABLE RENDERS ONCE — the rail lists it, and the workspace does not repeat it (ruling 8)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoint-row-ckpt-1')).toBeInTheDocument())

    expect(document.querySelectorAll('[data-checkpoint-row]'), 'one row per checkpoint, in one listing').toHaveLength(1)
    expect(screen.queryByTestId('lab-checkpoints-table'), 'the Stage 1 table is gone, not drawn beside the rail').toBeNull()
    expect(screen.getAllByTestId('lab-checkpoint-row-ckpt-1')).toHaveLength(1)
  })

  it("and the launch's step 1 reuses the rail's selection rather than repeating the table", async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoint-row-ckpt-1')).toBeInTheDocument())

    await click(screen.getByTestId('lab-checkpoint-row-ckpt-1'))

    expect(screen.getByTestId('lab-checkpoint-row-ckpt-1').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true))
  })

  it('the empty sentence is ONE sentence in two regions — the rail says how to capture a checkpoint in the axis own words', () => {
    expect(NO_CHECKPOINTS_COPY, 'executed: the page and the axis say the same thing').toBe(AXIS_EMPTY_COPY)
  })

  it('state — no checkpoints: the rail says how to capture one, and the axis is empty with the sentence', async () => {
    render(<LabPage fetchImpl={fetchImplFor([], [])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoints-empty')).toBeInTheDocument())

    expect(screen.getByTestId('lab-checkpoints-empty').textContent).toBe(NO_CHECKPOINTS_COPY)
    expect(screen.getByTestId('axis-empty').textContent).toBe(AXIS_EMPTY_COPY)
    expect(screen.queryByTestId('lab-checkpoints-error')).toBeNull()
  })

  it('state — checkpoints but no experiments: the rail lists them, and the frame reads seat the playhead', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [])} />)
    await waitFor(() => expect(screen.getByTestId('lab-checkpoint-row-ckpt-1')).toBeInTheDocument())

    expect(screen.getByTestId('lab-experiments-empty')).toBeInTheDocument()
    expect(screen.getByTestId('frame').textContent).toContain('seat the playhead')
    expect(screen.getByTestId('lab-stage-no-experiment')).toBeInTheDocument()
    expect(screen.queryByRole('tablist'), 'there is no reading to tab between').toBeNull()
  })

  it('state — an experiment selected: the tabs are live, and the rail row is the raised one', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-1')).toBeInTheDocument())

    expect(screen.getByTestId('lab-experiment-row-fork-1').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getByTestId('lab-tabpanel-Compare').hidden).toBe(false)
    expect(screen.getByTestId('lab-tabpanel-Metrics').hidden).toBe(true)
  })

  it('state — partial: the rail row carries 2 of 3 arms', async () => {
    const outcome = {
      forkId: 'fork-1',
      parentLane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ arm: 1, model: 'opus', briefProvided: false, forkId: 'fork-1', laneHandle: 'fork-1-arm-1', worktreePath: '/tmp/arm-1', launched: true }],
      failed: { arm: 3, error: 'workmux: tmux server not running' },
      requestedArms: 3,
    }
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} seedLaunchOutcomes={[outcome]} />)
    await waitFor(() => expect(screen.getByTestId('lab-rail-partial-fork-1')).toBeInTheDocument())

    expect(screen.getByTestId('lab-rail-partial-fork-1').textContent).toBe('2 of 3 arms')
  })

  it('state — loading and error, per region, never conflated', async () => {
    const { unmount } = render(<LabPage fetchImpl={fetchImplFor([], [], false, 500)} />)
    await waitFor(() => expect(screen.getByTestId('lab-rail-experiments-error')).toBeInTheDocument())
    // The rail names the failure; the stage carries its reason. Neither says empty.
    expect(screen.getByTestId('lab-checkpoints-error').textContent).toContain('the lab cannot see its checkpoints')
    expect(screen.getByTestId('lab-experiments-error').textContent).toContain('the lab cannot see its experiments — /api/lab/experiments responded 500')
    expect(screen.queryByTestId('lab-experiments-empty')).toBeNull()
    expect(screen.queryByTestId('lab-stage-no-experiment')).toBeNull()
    unmount()

    // A read still in flight says so, in both regions, and claims nothing.
    render(<LabPage fetchImpl={(() => new Promise(() => {})) as unknown as FetchLike} />)
    expect(screen.getByTestId('lab-rail-checkpoints-loading')).toBeInTheDocument()
    expect(screen.getByTestId('lab-experiments-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('lab-checkpoints-empty')).toBeNull()
  })
})

describe('Compare, Trace and Metrics are tabs, not a stack (prd-55 ruling 8, S1-prime)', () => {
  async function openWorkspace() {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())
  }

  it('the strip is a role=tablist whose panels follow the tabpanel pattern', async () => {
    await openWorkspace()

    expect(screen.getByRole('tablist')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    // prd-55 wave 6: R&D joins as the fourth tab, at the end — extending this
    // assertion to the new fact rather than weakening it to still expect three.
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Compare', 'Trace', 'Metrics', 'R&D'])
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') as string)
      expect(panel, `${tab.textContent} controls a panel`).not.toBeNull()
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
  })

  it('ARROW KEYS move between them, Home/End reach the ends, and only the selected tab is a tab stop', async () => {
    await openWorkspace()

    const [compare, trace] = screen.getAllByRole('tab')
    expect(compare?.getAttribute('aria-selected')).toBe('true')
    expect(compare?.getAttribute('tabindex')).toBe('0')
    expect(trace?.getAttribute('tabindex')).toBe('-1')

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    })
    expect(screen.getByTestId('lab-tab-Trace').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('lab-tabpanel-Trace').hidden).toBe(false)
    expect(screen.getByTestId('lab-tabpanel-Compare').hidden).toBe(true)
    expect(document.activeElement, 'focus follows the selection, as a tablist does').toBe(screen.getByTestId('lab-tab-Trace'))

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    })
    expect(screen.getByTestId('lab-tab-Compare').getAttribute('aria-selected')).toBe('true')

    // prd-55 wave 6: End now reaches R&D — the new true last tab — not
    // Metrics; extended to the new fact, never weakened to still expect the
    // old one.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    })
    expect(screen.getByTestId('lab-tab-R&D').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' })
    })
    expect(screen.getByTestId('lab-tab-Compare').getAttribute('aria-selected')).toBe('true')
  })

  it('the arrow wraps at both ends, so the strip is a ring rather than a dead stop', async () => {
    await openWorkspace()

    // ArrowLeft from the first tab (Compare) wraps to the new last tab (R&D).
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    })
    expect(screen.getByTestId('lab-tab-R&D').getAttribute('aria-selected')).toBe('true')
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    })
    expect(screen.getByTestId('lab-tab-Compare').getAttribute('aria-selected')).toBe('true')
  })

  it('every reading is of the SELECTED experiment — Metrics reads the one on the stage, not every experiment there is', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT, CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    expect(screen.getByTestId('metrics-row-fork-3')).toBeInTheDocument()
    expect(screen.queryByTestId('metrics-row-fork-1')).toBeNull()

    await click(screen.getByTestId('lab-experiment-row-fork-1'))

    expect(screen.getByTestId('metrics-row-fork-1')).toBeInTheDocument()
    expect(screen.queryByTestId('metrics-row-fork-3')).toBeNull()
  })
})

describe('the Trace control is reachable from the frame divergence position as well as the tab (prd-55 ruling 8)', () => {
  it('the frame carries its own control at position 4, and it drives the same open run the tab does', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    // Not at the cost position: the control belongs to divergence.
    expect(screen.queryByTestId('lab-frame-trace-control')).toBeNull()

    await click(screen.getByTestId('frame-position-4'))
    expect(screen.getByTestId('lab-frame-trace-control')).toBeInTheDocument()

    await click(screen.getByTestId('lab-frame-trace-open-fork-3-arm-1'))

    // ONE open run, two controls: the tab's control agrees with the frame's,
    // because both press the same state.
    expect(screen.getByTestId('lab-frame-trace-open-fork-3-arm-1').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('lab-trace-open-fork-3-arm-1').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('lab-trace-none-open')).toBeNull()
  })

  it('and the trace reads while another tab is the reading on screen — divergence populates without opening the Trace tab (S3-prime)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    await click(screen.getByTestId('frame-position-4'))
    await click(screen.getByTestId('lab-frame-trace-open-fork-3-arm-1'))

    // Compare is still the visible reading; Trace is mounted and reading.
    expect(screen.getByTestId('lab-tab-Compare').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('lab-tabpanel-Trace').hidden).toBe(true)
    await waitFor(() => expect(screen.getByTestId('lab-tabpanel-Trace').textContent).not.toBe(''))
  })

  it('opening another experiment closes the trace — a divergence figure never outlives the run it was read from', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT, CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    await click(screen.getByTestId('lab-tab-Trace'))
    await click(screen.getByTestId('lab-trace-open-fork-3-arm-1'))
    expect(screen.queryByTestId('lab-trace-none-open')).toBeNull()

    await click(screen.getByTestId('lab-experiment-row-fork-1'))

    expect(screen.getByTestId('lab-trace-none-open')).toBeInTheDocument()
  })
})

describe('the workspace holds its Stage 1 laws through the rearrangement', () => {
  it('no native title attribute anywhere on the workspace (#220, prd-30 w1)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    expect(document.querySelectorAll('[title]')).toHaveLength(0)
  })

  it('a run identical notes collapse to one line per arm, on the page as well as in the surface (ruling 8)', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [REPLICATE_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-4')).toBeInTheDocument())

    for (const dots of screen.getAllByTestId('run-dots')) {
      const notes = [...dots.children].map((line) => line.textContent)
      expect(new Set(notes).size, `a note was printed twice in one arm: ${notes.join(' | ')}`).toBe(notes.length)
      expect(notes[0]).toContain('3 runs · all passed')
    }
  })

  it('the rail counts and the comparison below them agree about how many runs were judged', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [MEASURED_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-3')).toBeInTheDocument())

    // fork-3: one run passed, one `not-run` — judged by nobody, so unmeasured.
    expect(screen.getByTestId('lab-experiment-row-fork-3')).toHaveTextContent('1 passed · 0 failed · 1 unmeasured')
    expect(screen.getByTestId('lab-experiment-row-fork-3')).toHaveTextContent('2 arms · 2 runs')
  })
})

describe('the R&D tab (prd-55 wave 6, ruling 9)', () => {
  it('joins the strip as the fourth tab and mounts silently — the hand never runs without a click', async () => {
    const rdFetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as RdFetchLike
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} rdFetchImpl={rdFetchImpl} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-1')).toBeInTheDocument())

    expect(screen.getByTestId('lab-tab-R&D')).toBeInTheDocument()
    await click(screen.getByTestId('lab-tab-R&D'))
    expect(screen.getByTestId('rd-tab')).toBeInTheDocument()
    expect(rdFetchImpl).not.toHaveBeenCalled()
  })

  it('books the run to the seated checkpoint\'s lane, falling back to the selected experiment\'s parent lane', async () => {
    render(<LabPage fetchImpl={fetchImplFor([CHECKPOINT], [CLEAN_EXPERIMENT])} />)
    await waitFor(() => expect(screen.getByTestId('lab-experiment-fork-1')).toBeInTheDocument())
    await click(screen.getByTestId('lab-tab-R&D'))

    expect(screen.queryByTestId('rd-no-lane')).toBeNull()
  })
})
