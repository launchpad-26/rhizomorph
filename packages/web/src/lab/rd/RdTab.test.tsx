import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import type { FetchLike } from '../../replay/api.js'
import type { LaunchFetchLike } from '../launch/launch.js'
import type { LabExperiment } from '../types.js'
import {
  RD_ALL_HELD_BACK_RUN,
  RD_HELD_BACK_ROW_COPY,
  RD_LIVE_RUN,
  RD_MULTI_DIMENSION_REFUSAL,
  RD_NO_CLI_RUN,
  RD_NO_CORPUS_RUN,
  RD_NOTHING_PROPOSED_COPY,
  RD_REFUSED_RUN,
  RD_WRONG_DIMENSION_REFUSAL,
} from './fixtures.js'
import { RD_NO_MEASURED_BASELINE, RD_OVERRIDE_SENTENCE, RdTab } from './RdTab.js'
import type { RdFetchLike } from './rd.js'

/**
 * RULING 9's STATES, one test each, drawn against the fixtures rather than a
 * live call — and the laws this tab adds, each proved by a mutation. See this
 * lane's report for which mutations were run and what went red.
 */

beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

afterEach(() => cleanup())

async function click(element: Element | null) {
  await act(async () => {
    fireEvent.click(element as Element)
  })
}

function rdFetchReturning(run: unknown): RdFetchLike {
  return (async () => ({ ok: true, status: 200, json: async () => run })) as unknown as RdFetchLike
}

const NO_CHECKPOINTS: FetchLike = (async (url: string | URL | Request) => {
  const href = String(url)
  if (href === '/api/lab/checkpoints') return { ok: true, status: 200, json: async () => ({ checkpoints: [] }) } as Response
  throw new Error(`unexpected fetch: ${href}`)
}) as unknown as FetchLike

const CHECKPOINT = {
  eventId: 'evt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1000,
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
  eventIndex: 12,
  sessionCutByte: 11_840,
  sessionByteLength: 40_000,
}

const NO_RATE = { lane: 'feature', arms: 2, runs: 1, lanes: 2, available: false, reason: '"feature" has no recorded spend in the last hour' }

function fetchImplWithCheckpoint(): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/lab/checkpoints') return { ok: true, status: 200, json: async () => ({ checkpoints: [CHECKPOINT] }) } as Response
    if (href.startsWith('/api/lab/estimate')) return { ok: true, status: 200, json: async () => NO_RATE } as Response
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

async function readAndPropose() {
  await act(async () => {
    fireEvent.change(screen.getByTestId('rd-model'), { target: { value: 'sonnet' } })
  })
  await click(screen.getByTestId('rd-read-and-propose'))
}

describe('RdTab — the hand never runs without a click', () => {
  it('posts nothing on mount, or on a prop change — only the button does', async () => {
    const rdFetchImpl = vi.fn(rdFetchReturning(RD_LIVE_RUN))
    const { rerender } = render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchImpl} fetchImpl={NO_CHECKPOINTS} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    rerender(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchImpl} fetchImpl={NO_CHECKPOINTS} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rdFetchImpl).not.toHaveBeenCalled()
  })
})

describe('RdTab — ruling 9\'s states, each a fixture and a test', () => {
  beforeEach(() => cleanup())

  it('no CLI: the control is disabled and the sentence renders, verbatim', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_NO_CLI_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-no-cli')).toBeInTheDocument())
    expect(screen.getByTestId('rd-no-cli').textContent).toBe(RD_NO_CLI_RUN.reason)
    expect(screen.getByTestId('rd-read-and-propose')).toBeDisabled()
    expect(screen.getByTestId('rd-model')).toBeDisabled()
  })

  it('no corpus: "nothing to read yet — a retro, or a measured experiment, is where a pattern comes from."', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_NO_CORPUS_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-no-corpus')).toBeInTheDocument())
    expect(screen.getByTestId('rd-no-corpus').textContent).toBe(
      'nothing to read yet — a retro, or a measured experiment, is where a pattern comes from.',
    )
  })

  it('all held back: every row is dim, and "no pattern recurs — nothing is proposed."', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_ALL_HELD_BACK_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-nothing-proposed')).toBeInTheDocument())
    expect(screen.getByTestId('rd-nothing-proposed').textContent).toBe(RD_NOTHING_PROPOSED_COPY)
    expect(screen.getByTestId('rd-pattern-held-back-pattern-1').textContent).toBe(RD_HELD_BACK_ROW_COPY)
    expect(screen.getByTestId('rd-no-proposal-pattern-1').textContent).toBe(RD_HELD_BACK_ROW_COPY)
  })

  it('refused: the schema reason renders verbatim, with the raw result offered as a details element', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_REFUSED_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-refusal-pattern-2')).toBeInTheDocument())
    expect(screen.getByTestId('rd-refusal-pattern-2').textContent).toContain(RD_MULTI_DIMENSION_REFUSAL)
    expect(document.querySelector('#rd-refusal-pattern-2 details, [data-testid="rd-refusal-pattern-2"] details')).not.toBeNull()
  })

  it('live: the proposal renders its arms and its checkpoint pick, with what it rejected', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-proposal-proposal-1')).toBeInTheDocument())
    expect(screen.getByTestId('rd-proposal-arm-proposal-1-0').textContent).toContain('sonnet')
    expect(screen.getByTestId('rd-proposal-arm-proposal-1-1').textContent).toContain('opus')
    expect(screen.getByTestId('rd-checkpoint-pick-proposal-1').textContent).toContain('ckpt-1')
    expect(screen.getByTestId('rd-checkpoint-pick-proposal-1').textContent).toContain('predates the gate command')
    expect(screen.getByTestId('rd-restore-arms-proposal-1')).toBeInTheDocument()
    expect(screen.getByTestId('rd-restore-and-run-proposal-1')).toBeInTheDocument()
  })

  it('the provenance line carries the run\'s own cost, turns and version — never a re-derived figure', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-provenance')).toBeInTheDocument())
    const text = screen.getByTestId('rd-provenance').textContent ?? ''
    expect(text).toContain(RD_LIVE_RUN.provenance?.model)
    expect(text).toContain(RD_LIVE_RUN.provenance?.total_cost_usd.toFixed(4))
    expect(text).toContain(String(RD_LIVE_RUN.turns))
    expect(text).toContain(RD_LIVE_RUN.provenance?.claudeVersion)
  })
})

describe('RdTab — a proposal\'s arms differ in exactly one dimension AS RENDERED (prd-55 ruling 3)', () => {
  it('a fixture whose second arm also varies checkpoint renders the refusal, never a patched proposal', async () => {
    const confounded = {
      ...RD_LIVE_RUN,
      proposals: [
        {
          ...RD_LIVE_RUN.proposals[0]!,
          arms: [
            RD_LIVE_RUN.proposals[0]!.arms[0]!,
            { ...RD_LIVE_RUN.proposals[0]!.arms[1]!, checkpointId: 'ckpt-9' },
          ],
        },
      ],
    }
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(confounded)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-refusal-pattern-3')).toBeInTheDocument())
    expect(screen.getByTestId('rd-refusal-pattern-3').textContent).toContain(RD_MULTI_DIMENSION_REFUSAL)
    expect(screen.queryByTestId('rd-proposal-proposal-1')).toBeNull()
  })

  /**
   * Post-merge (review of #437, `1cbc3e86`): the count of varying dimensions
   * being exactly one is not enough — the ONE dimension that varies must be
   * the one the proposal declares. A fixture declaring `varies: 'model'`
   * whose arms hold the SAME model and differ only in `gateCommand` is
   * exactly the shape that check-only-the-count missed; core's own
   * `rdRefusalReason` (re-run here, not re-implemented) catches it.
   */
  it('a fixture declaring varies: "model" whose arms actually differ in gateCommand renders the wrong-dimension refusal', async () => {
    const wrongDimension = {
      ...RD_LIVE_RUN,
      proposals: [
        {
          ...RD_LIVE_RUN.proposals[0]!,
          arms: [
            { ...RD_LIVE_RUN.proposals[0]!.arms[0]!, model: 'sonnet', gateCommand: 'npm test' },
            { ...RD_LIVE_RUN.proposals[0]!.arms[1]!, model: 'sonnet', gateCommand: 'npm run verify' },
          ],
        },
      ],
    }
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(wrongDimension)} fetchImpl={NO_CHECKPOINTS} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-refusal-pattern-3')).toBeInTheDocument())
    expect(screen.getByTestId('rd-refusal-pattern-3').textContent).toContain(RD_WRONG_DIMENSION_REFUSAL)
    expect(screen.queryByTestId('rd-proposal-proposal-1')).toBeNull()
  })
})

describe('RdTab — keyboard path (S5)', () => {
  it('↑/↓ move focus through patterns; Esc closes the launch review', async () => {
    const twoPatterns = {
      ...RD_LIVE_RUN,
      patterns: [...RD_LIVE_RUN.patterns, { ...RD_ALL_HELD_BACK_RUN.patterns[0]!, patternId: 'pattern-9' }],
    }
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(twoPatterns)} fetchImpl={fetchImplWithCheckpoint()} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-pattern-pattern-3')).toBeInTheDocument())

    screen.getByTestId('rd-pattern-pattern-3').focus()
    fireEvent.keyDown(screen.getByTestId('rd-pattern-pattern-3').parentElement!.parentElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('rd-pattern-pattern-9'))

    await click(screen.getByTestId('rd-pattern-pattern-3'))
    await click(screen.getByTestId('rd-restore-and-run-proposal-1'))
    await waitFor(() => expect(screen.getByTestId('rd-launch-review')).toBeInTheDocument())

    fireEvent.keyDown(screen.getByTestId('rd-launch-review'), { key: 'Escape' })
    expect(screen.queryByTestId('rd-launch-review')).toBeNull()
  })
})

describe('RdTab — the launch review, the override sentence, and the counterfactual (ruling 4)', () => {
  it('opens prefilled with the proposal\'s checkpoint, and dispatches through the one launch the lab already has', async () => {
    render(<RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)} fetchImpl={fetchImplWithCheckpoint()} />)
    await readAndPropose()
    await waitFor(() => expect(screen.getByTestId('rd-restore-and-run-proposal-1')).toBeInTheDocument())

    await click(screen.getByTestId('rd-restore-and-run-proposal-1'))
    await waitFor(() =>
      expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true),
    )
  })

  it('launching against the SAME checkpoint the proposal picked reports no override', async () => {
    const launchFetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arms: [{ arm: 1, model: 'sonnet', briefProvided: false, forkId: 'fork-rd-1', laneHandle: 'fork-rd-1-arm-1', worktreePath: '/tmp/rd-1', launched: true }],
        failed: null,
      }),
    })) as unknown as LaunchFetchLike

    render(
      <RdTab
        lane="feature"
        experiments={[]}
        rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)}
        fetchImpl={fetchImplWithCheckpoint()}
        launchFetchImpl={launchFetchImpl}
      />,
    )
    await readAndPropose()
    await click(screen.getByTestId('rd-restore-and-run-proposal-1'))
    await waitFor(() => expect(screen.getByTestId('launch-checkpoint-ckpt-1')).toBeInTheDocument())
    // Prefilled already — this is what "restore n arms"/"restore and run" CAN
    // prefill today (the checkpoint), and nothing more; see this wave's report.
    expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true)
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('rd-launched-proposal-1')).toBeInTheDocument())
    // The proposal's own checkpointPick chose ckpt-1, and so did this launch —
    // same checkpoint, so no override to report. The mutation below proves the
    // sentence renders when the two actually disagree.
    expect(screen.queryByTestId('rd-override-proposal-1')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('rd-counterfactual-proposal-1')).toBeInTheDocument())
    expect(screen.getByTestId('rd-baseline-proposal-1').textContent).toBe(RD_NO_MEASURED_BASELINE)
  })

  it('MUTATION: an operator picking a DIFFERENT checkpoint before launching renders the override sentence, never re-attributed', async () => {
    const CHECKPOINT_2 = { ...CHECKPOINT, checkpointId: 'ckpt-2', eventId: 'evt-2' }
    const fetchImpl: FetchLike = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/lab/checkpoints') return { ok: true, status: 200, json: async () => ({ checkpoints: [CHECKPOINT, CHECKPOINT_2] }) } as Response
      if (href.startsWith('/api/lab/estimate')) return { ok: true, status: 200, json: async () => NO_RATE } as Response
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike
    const launchFetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        parentLane: 'feature',
        // The operator chose ckpt-2 in the review below — different from the
        // proposal's own pick (ckpt-1) — so this IS an override.
        checkpointId: 'ckpt-2',
        arms: [{ arm: 1, model: 'sonnet', briefProvided: false, forkId: 'fork-rd-3', laneHandle: 'fork-rd-3-arm-1', worktreePath: '/tmp/rd-3', launched: true }],
        failed: null,
      }),
    })) as unknown as LaunchFetchLike

    render(
      <RdTab lane="feature" experiments={[]} rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)} fetchImpl={fetchImpl} launchFetchImpl={launchFetchImpl} />,
    )
    await readAndPropose()
    await click(screen.getByTestId('rd-restore-and-run-proposal-1'))
    await waitFor(() => expect(screen.getByTestId('launch-checkpoint-ckpt-2')).toBeInTheDocument())
    // The operator overrides the prefilled pick before reviewing.
    await click(screen.getByTestId('launch-checkpoint-ckpt-2').querySelector('input'))
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('rd-override-proposal-1')).toBeInTheDocument())
    expect(screen.getByTestId('rd-override-proposal-1').textContent).toBe(RD_OVERRIDE_SENTENCE)
  })

  it('a measured source item resolves to one observation — never a spread', async () => {
    const experiments: LabExperiment[] = [
      {
        forkId: 'fork-old',
        parentLane: 'feature',
        checkpointId: 'ckpt-0',
        arms: [
          {
            arm: 1,
            treatment: { model: 'sonnet', promptDigest: null },
            runs: [
              {
                eventId: 'evt-old',
                dispatchedAt: 900,
                run: 1,
                laneHandle: 'w6-413-arm-1',
                worktreePath: '/tmp/old',
                outcome: {
                  verified: 'fail',
                  verifiedDetail: 'timeout',
                  costUsd: 1.2,
                  durationMs: 9000,
                  commits: 1,
                  provenance: { source: 'measure-route', verifyCommand: 'npm test', measuredAt: 950 },
                },
              },
            ],
          },
        ],
      },
    ]
    const launchFetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        parentLane: 'feature',
        checkpointId: 'ckpt-1',
        arms: [{ arm: 1, model: 'sonnet', briefProvided: false, forkId: 'fork-rd-2', laneHandle: 'fork-rd-2-arm-1', worktreePath: '/tmp/rd-2', launched: true }],
        failed: null,
      }),
    })) as unknown as LaunchFetchLike

    render(
      <RdTab
        lane="feature"
        experiments={experiments}
        rdFetchImpl={rdFetchReturning(RD_LIVE_RUN)}
        fetchImpl={fetchImplWithCheckpoint()}
        launchFetchImpl={launchFetchImpl}
      />,
    )
    await readAndPropose()
    await click(screen.getByTestId('rd-restore-and-run-proposal-1'))
    await waitFor(() => expect(screen.getByTestId('launch-checkpoint-ckpt-1')).toBeInTheDocument())
    await click(screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input'))
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('rd-baseline-proposal-1')).toBeInTheDocument())
    expect(screen.getByTestId('rd-baseline-proposal-1').textContent).toContain('w6-413-arm-1')
    expect(screen.getByTestId('rd-baseline-proposal-1').textContent).toContain('fail')
    expect(screen.getByTestId('rd-baseline-proposal-1').textContent).toContain('timeout')
  })
})
