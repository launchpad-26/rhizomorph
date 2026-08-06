import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../../replay/api.js'
import type { LaunchFetchLike, LaunchOutcome } from './launch.js'
import { LaunchPanel } from './LaunchPanel.js'

afterEach(cleanup)

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

function fetchImplFor(options: {
  checkpoints?: unknown[]
  checkpointsOk?: boolean
  estimate?: unknown
  estimateOk?: boolean
}): FetchLike {
  const { checkpoints = [CHECKPOINT], checkpointsOk = true, estimate, estimateOk = true } = options
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/lab/checkpoints') {
      return { ok: checkpointsOk, status: checkpointsOk ? 200 : 500, json: async () => ({ checkpoints }) } as Response
    }
    if (href.startsWith('/api/lab/estimate')) {
      return { ok: estimateOk, status: estimateOk ? 200 : 500, json: async () => estimate } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

const AVAILABLE_ESTIMATE = {
  lane: 'feature',
  arms: 3,
  available: true,
  windowMs: 3_600_000,
  costUsdPerHour: 1.6,
  estimatedTotalUsd: 4.8,
}

const UNAVAILABLE_ESTIMATE = {
  lane: 'feature',
  arms: 3,
  available: false,
  reason: '"feature" has no recorded spend in the last hour — its rate cannot be established',
}

const OUTCOME: LaunchOutcome = {
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      model: 'opus',
      briefProvided: true,
      forkId: 'fork-abc',
      laneHandle: 'fork-abc-arm-1',
      worktreePath: '/data/lab/worktrees/fork-abc-arm-1',
      launched: true,
    },
  ],
  failed: null,
}

describe('LaunchPanel', () => {
  it('shows the honest empty state when there is nothing to fork from', async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({ checkpoints: [] })} />)
    await waitFor(() => expect(screen.getByTestId('launch-checkpoints-empty')).toBeInTheDocument())
    expect(screen.getByTestId('launch-review')).toBeDisabled()
  })

  it('disables "review & launch" until a checkpoint is selected', async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({})} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    expect(screen.getByTestId('launch-review')).toBeDisabled()

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    expect(screen.getByTestId('launch-review')).not.toBeDisabled()
  })

  it('starts with three free-form arms, each editable independently, and supports add/remove', async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({})} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    const armInputs = screen.getAllByPlaceholderText('model (default if blank)')
    expect(armInputs).toHaveLength(3)

    fireEvent.change(armInputs[0]!, { target: { value: 'opus' } })
    fireEvent.change(armInputs[1]!, { target: { value: 'sonnet' } })
    expect(armInputs[0]).toHaveValue('opus')
    expect(armInputs[1]).toHaveValue('sonnet')
    expect(armInputs[2]).toHaveValue('')

    await click(screen.getByTestId('launch-add-arm'))
    expect(screen.getAllByPlaceholderText('model (default if blank)')).toHaveLength(4)

    const removeButtons = screen.getAllByText('remove')
    await click(removeButtons[0]!)
    expect(screen.getAllByPlaceholderText('model (default if blank)')).toHaveLength(3)
  })

  it('reviewing fetches the estimate and shows its basis before any write happens', async () => {
    const fetchImpl = vi.fn(fetchImplFor({ estimate: AVAILABLE_ESTIMATE }))
    render(<LaunchPanel fetchImpl={fetchImpl} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    await click(screen.getByTestId('launch-review'))

    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('$4.80')
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('$1.60/hr')
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/lab/estimate?lane=feature&arms=3'))
  })

  it('says the rate cannot be established, honestly — never a fabricated or bare-zero number', async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: UNAVAILABLE_ESTIMATE })} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    await click(screen.getByTestId('launch-review'))

    await waitFor(() => expect(screen.getByTestId('launch-estimate-unavailable')).toBeInTheDocument())
    expect(screen.getByTestId('launch-estimate-unavailable')).toHaveTextContent('cannot be established')
    expect(screen.queryByTestId('launch-estimate-amount')).not.toBeInTheDocument()
  })

  it('cancelling the confirm dialog returns to configuring without ever calling the launch fetch', async () => {
    const launchFetchImpl = vi.fn() as unknown as LaunchFetchLike
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())

    await click(screen.getByTestId('launch-cancel'))

    expect(screen.getByTestId('launch-review')).toBeInTheDocument()
    expect(launchFetchImpl).not.toHaveBeenCalled()
  })

  it('the ONE confirm click launches, sending each arm its own model and brief', async () => {
    const launchFetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => OUTCOME }),
    ) as unknown as LaunchFetchLike
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    const armInputs = screen.getAllByPlaceholderText('model (default if blank)')
    fireEvent.change(armInputs[0]!, { target: { value: 'opus' } })
    const briefInputs = screen.getAllByPlaceholderText('brief (no brief if blank)')
    fireEvent.change(briefInputs[0]!, { target: { value: 'try the aggressive refactor' } })
    fireEvent.change(armInputs[1]!, { target: { value: 'sonnet' } })

    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())

    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())
    expect(launchFetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = (launchFetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as { lane: string; checkpointId: string; arms: unknown[] }
    expect(body).toEqual({
      lane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ model: 'opus', brief: 'try the aggressive refactor' }, { model: 'sonnet' }, {}],
    })
    expect(screen.getByTestId('launch-result-arm-1')).toHaveTextContent('opus')
  })

  it('shows a partial failure honestly — arms already dispatched are reported, never discarded', async () => {
    const partial: LaunchOutcome = { ...OUTCOME, failed: { arm: 2, error: 'workmux add ... failed: tmux not running' } }
    const launchFetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => partial }),
    ) as unknown as LaunchFetchLike
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-result-failed')).toBeInTheDocument())
    expect(screen.getByTestId('launch-result-failed')).toHaveTextContent('arm 2 failed')
    expect(screen.getByTestId('launch-result-arm-1')).toBeInTheDocument()
  })

  it('shows the refusal instead of claiming a launch that did not happen', async () => {
    const launchFetchImpl = vi.fn(
      async () => ({ ok: false, status: 409, json: async () => ({ error: 'this server is replaying a session record' }) }),
    ) as unknown as LaunchFetchLike
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
    await click(screen.getByTestId('launch-review'))
    await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-error')).toBeInTheDocument())
    expect(screen.getByTestId('launch-error')).toHaveTextContent('this server is replaying a session record')
    expect(screen.queryByTestId('launch-result')).not.toBeInTheDocument()
  })
})
