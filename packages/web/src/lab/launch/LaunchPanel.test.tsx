import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import type { FetchLike } from '../../replay/api.js'
import { adoptRepoScope, readRecordOverlay, writePreference } from '../../settings/registry.js'
import { LaunchPanel } from './LaunchPanel.js'
import type { LaunchFetchLike, LaunchOutcome } from './launch.js'
import { LAB_MODELS_PREFERENCE, OTHER_MODEL, offeredModels } from './models.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * The registry is module state behind `localStorage`, so every test starts
 * from a fresh repo bucket — a model offered under other… in one test must not
 * be on offer in the next.
 */
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  adoptRepoScope(null)
  localStorage.clear()
})

/**
 * Stands in for what `server/static.ts` stamps into `index.html` on a real
 * boot (ADR-0012). Needed since #234 gated `POST /api/lab/launch`:
 * `launch.ts` reads the token off the page and refuses before the wire if
 * there is none, so without this the panel below would be exercising that
 * refusal rather than the confirmation flow it exists to test.
 * `launch.test.ts` is where the missing-token path is asserted on purpose.
 */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
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
      return { ok: estimateOk, status: estimateOk ? 200 : 400, json: async () => estimate } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** The estimate as the server shapes it since prd53: arms × runs, and the lanes it counted. */
const AVAILABLE_ESTIMATE = {
  lane: 'feature',
  arms: 3,
  runs: 1,
  lanes: 3,
  available: true,
  windowMs: 3_600_000,
  costUsdPerHour: 1.6,
  estimatedTotalUsd: 4.8,
}

const UNAVAILABLE_ESTIMATE = {
  lane: 'feature',
  arms: 3,
  runs: 1,
  lanes: 3,
  available: false,
  reason: '"feature" has no recorded spend in the last hour — its rate cannot be established',
}

/** What the launch route answers. It does not echo the requested arm count — `requestLaunch` stamps that from the request. */
const ANSWER: Omit<LaunchOutcome, 'requestedArms'> = {
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

function answering(payload: unknown, status = 200): LaunchFetchLike {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })) as unknown as LaunchFetchLike
}

function launchBody(launchFetchImpl: LaunchFetchLike): Record<string, unknown> {
  const [, init] = (launchFetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }]
  return JSON.parse(init.body) as Record<string, unknown>
}

/** Every arm row's model select, in arm order — found by the label a person would read, not by the row's internal key. */
function modelSelects(): HTMLSelectElement[] {
  return screen.getAllByLabelText(/^arm \d+ model$/) as HTMLSelectElement[]
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value)
}

async function seatCheckpoint() {
  await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())
  await click(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`).querySelector('input')!)
}

async function review() {
  await click(screen.getByTestId('launch-review'))
  await waitFor(() => expect(screen.getByTestId('launch-confirm-dialog')).toBeInTheDocument())
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

  it('starts with three arms, each with its own model select and its own brief, and supports add/remove', async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({})} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    const selects = modelSelects()
    expect(selects).toHaveLength(3)

    fireEvent.change(selects[0]!, { target: { value: 'opus' } })
    fireEvent.change(selects[1]!, { target: { value: 'sonnet' } })
    expect(selects[0]).toHaveValue('opus')
    expect(selects[1]).toHaveValue('sonnet')
    expect(selects[2]).toHaveValue('')

    await click(screen.getByTestId('launch-add-arm'))
    expect(modelSelects()).toHaveLength(4)

    const removeButtons = screen.getAllByText('remove')
    await click(removeButtons[0]!)
    expect(modelSelects()).toHaveLength(3)
  })

  it('reviewing fetches the estimate for the arm count alone while runs is blank, and shows the basis the server stated', async () => {
    const fetchImpl = vi.fn(fetchImplFor({ estimate: AVAILABLE_ESTIMATE }))
    render(<LaunchPanel fetchImpl={fetchImpl} />)
    await seatCheckpoint()
    await review()

    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('$4.80')
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('$1.60/hr')
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('across 3 spending lane(s) — 3 arm(s) × 1 run(s)')
    const estimateUrl = fetchImpl.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith('/api/lab/estimate'))
    expect(estimateUrl).toBe('/api/lab/estimate?lane=feature&arms=3')
  })

  it("says the rate cannot be established in the dim ink, never the alarm's — a lane that has not spent is not a fault", async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: UNAVAILABLE_ESTIMATE })} />)
    await seatCheckpoint()
    await review()

    const unavailable = screen.getByTestId('launch-estimate-unavailable')
    expect(unavailable).toHaveTextContent('cannot be established')
    expect(unavailable).toHaveTextContent('is not a fault')
    // The ink is the claim: `text-broken` is the alarm every failed read wears
    // in this panel, and this is not a failed read. The mutation is one class.
    expect(unavailable.className).toContain('text-(--ink-dim)')
    expect(unavailable.className).not.toContain('text-broken')
    expect(screen.queryByTestId('launch-estimate-amount')).not.toBeInTheDocument()
  })

  it('cancelling the confirm dialog returns to configuring without ever calling the launch fetch', async () => {
    const launchFetchImpl = vi.fn() as unknown as LaunchFetchLike
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    await review()

    await click(screen.getByTestId('launch-cancel'))

    expect(screen.getByTestId('launch-review')).toBeInTheDocument()
    expect(launchFetchImpl).not.toHaveBeenCalled()
  })

  it('the ONE confirm click launches, sending each arm its own model and brief, and tells the workspace what was asked for', async () => {
    const launchFetchImpl = answering(ANSWER)
    const onLaunched = vi.fn()
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} onLaunched={onLaunched} />)
    await seatCheckpoint()
    const selects = modelSelects()
    fireEvent.change(selects[0]!, { target: { value: 'opus' } })
    const briefInputs = screen.getAllByPlaceholderText('brief (no brief if blank)')
    fireEvent.change(briefInputs[0]!, { target: { value: 'try the aggressive refactor' } })
    fireEvent.change(selects[1]!, { target: { value: 'sonnet' } })

    await review()
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())
    expect(launchFetchImpl).toHaveBeenCalledTimes(1)
    expect(launchBody(launchFetchImpl)).toEqual({
      lane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ model: 'opus', brief: 'try the aggressive refactor' }, { model: 'sonnet' }, {}],
    })
    expect(screen.getByTestId('launch-result-arm-1')).toHaveTextContent('opus')
    // "k of N requested" — N from the request, not rebuilt from what came back.
    expect(screen.getByTestId('launch-result')).toHaveTextContent('1 of 3 requested arm(s) dispatched')
    expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ requestedArms: 3, failed: null }))
  })

  it('shows a partial failure honestly — arms already dispatched are reported, never discarded', async () => {
    const partial = { ...ANSWER, failed: { arm: 2, error: 'workmux add ... failed: tmux not running' } }
    const launchFetchImpl = answering(partial)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    await review()
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-result-failed')).toBeInTheDocument())
    expect(screen.getByTestId('launch-result-failed')).toHaveTextContent('arm 2 failed')
    expect(screen.getByTestId('launch-result-arm-1')).toBeInTheDocument()
    expect(screen.getByTestId('launch-result')).toHaveTextContent('1 of 3 requested arm(s) dispatched')
  })

  it('shows the refusal instead of claiming a launch that did not happen', async () => {
    const launchFetchImpl = answering({ error: 'this server is replaying a session record' }, 409)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    await review()
    await click(screen.getByTestId('launch-confirm'))

    await waitFor(() => expect(screen.getByTestId('launch-error')).toBeInTheDocument())
    expect(screen.getByTestId('launch-error')).toHaveTextContent('this server is replaying a session record')
    expect(screen.queryByTestId('launch-result')).not.toBeInTheDocument()
  })
})

describe("the model select is this repo's own list (prd-55 ruling 5)", () => {
  it("every arm's options are exactly: the default, the keys switched on in lab.models, and other… — and they follow the registry", async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({})} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    // Executed against the registry, not a literal list: the law is that the
    // options ARE the enabled keys, whatever the map holds.
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku'])
    for (const select of modelSelects()) {
      expect(optionValues(select)).toEqual(['', ...offeredModels(), OTHER_MODEL])
    }
    expect(modelSelects()[0]!.options[0]).toHaveTextContent('default model')

    // A key switched off leaves every select; a key added joins it — through
    // the registry's own change signal, with no prop passed down.
    act(() => {
      writePreference(LAB_MODELS_PREFERENCE, { sonnet: false, 'claude-opus-5': true })
    })
    for (const select of modelSelects()) {
      expect(optionValues(select)).toEqual(['', 'opus', 'haiku', 'claude-opus-5', OTHER_MODEL])
    }
  })

  it('other… takes a typed name, writes it into lab.models as an offered key, and the arm then carries it in the launch body', async () => {
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()

    fireEvent.change(modelSelects()[0]!, { target: { value: OTHER_MODEL } })
    const typed = screen.getByLabelText('arm 1 model, typed')
    fireEvent.change(typed, { target: { value: '  claude-opus-5 ' } })
    fireEvent.blur(typed)

    // Written into the record as an offered key — the overlay holds exactly
    // that key, and the merged list now offers it to every arm.
    expect(readRecordOverlay(LAB_MODELS_PREFERENCE)).toEqual({ 'claude-opus-5': true })
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku', 'claude-opus-5'])
    // …and the select now shows it selected, the typed field gone.
    expect(modelSelects()[0]).toHaveValue('claude-opus-5')
    expect(screen.queryByLabelText('arm 1 model, typed')).toBeNull()
    expect(optionValues(modelSelects()[1]!)).toContain('claude-opus-5')

    await review()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())
    expect((launchBody(launchFetchImpl).arms as unknown[])[0]).toEqual({ model: 'claude-opus-5' })
  })

  it('a typed name still travels when storage refused to keep it — the list is a convenience, never a gate', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()

    fireEvent.change(modelSelects()[0]!, { target: { value: OTHER_MODEL } })
    const typed = screen.getByLabelText('arm 1 model, typed')
    fireEvent.change(typed, { target: { value: 'x-model' } })
    fireEvent.blur(typed)

    // Not on the list — the write did not persist — so the name stays where it
    // was typed rather than appearing in a list that does not hold it…
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku'])
    expect(modelSelects()[0]).toHaveValue(OTHER_MODEL)
    expect(screen.getByLabelText('arm 1 model, typed')).toHaveValue('x-model')

    // …and it travels all the same. Whether the server admits it is the
    // server's grammar to say, in its own words.
    await review()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())
    expect((launchBody(launchFetchImpl).arms as unknown[])[0]).toEqual({ model: 'x-model' })
  })
})

describe('runs per arm and the ceiling override travel only when set (prd-55 ruling 7)', () => {
  it('absent: blank fields put no key in the body, and the estimate is asked for the arm count alone', async () => {
    const fetchImpl = vi.fn(fetchImplFor({ estimate: AVAILABLE_ESTIMATE }))
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImpl} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    await review()
    expect(screen.getByTestId('launch-confirm-dialog')).not.toHaveTextContent('run(s) from lane')
    expect(screen.queryByTestId('launch-ceiling-declared')).toBeNull()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())

    const body = launchBody(launchFetchImpl)
    expect(Object.keys(body).sort()).toEqual(['arms', 'checkpointId', 'lane'])
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith('/api/lab/estimate'))).not.toContain('runs=')
  })

  it('present: the estimate is asked for arms × runs and its basis says so, the confirmation names both, and the body carries both as typed', async () => {
    const fetchImpl = vi.fn(fetchImplFor({ estimate: { ...AVAILABLE_ESTIMATE, runs: 2, lanes: 6, estimatedTotalUsd: 9.6 } }))
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImpl} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    fireEvent.change(screen.getByTestId('launch-runs'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('launch-ceiling-override'), { target: { value: '9' } })

    await review()
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith('/api/lab/estimate'))).toBe(
      '/api/lab/estimate?lane=feature&arms=3&runs=2',
    )
    expect(screen.getByTestId('launch-confirm-dialog')).toHaveTextContent('Launch 3 arm(s) × 2 run(s)')
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('$9.60')
    expect(screen.getByTestId('launch-estimate-amount')).toHaveTextContent('across 6 spending lane(s) — 3 arm(s) × 2 run(s)')
    expect(screen.getByTestId('launch-ceiling-declared')).toHaveTextContent('declared ceiling: 9 spending lane(s)')

    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())
    expect(launchBody(launchFetchImpl)).toEqual({
      lane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{}, {}, {}],
      runs: 2,
      ceilingOverride: 9,
    })
  })

  it("a value the server refuses is sent as typed and its refusal comes back verbatim — the panel does not pre-judge it", async () => {
    // `runs` of 0 reaches the estimate route first, and the route's own
    // sentence is what the operator reads — not a disabled button with none.
    const refusal = '"runs" must be a positive integer when present (prd53 ruling 1)'
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: { error: refusal }, estimateOk: false })} />)
    await seatCheckpoint()
    fireEvent.change(screen.getByTestId('launch-runs'), { target: { value: '0' } })
    await click(screen.getByTestId('launch-review'))

    await waitFor(() => expect(screen.getByTestId('launch-estimate-error')).toBeInTheDocument())
    expect(screen.getByTestId('launch-estimate-error')).toHaveTextContent(refusal)
  })

  it('launch another experiment clears both fields — the next launch starts from the server defaults again', async () => {
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    fireEvent.change(screen.getByTestId('launch-runs'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('launch-ceiling-override'), { target: { value: '9' } })
    await review()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())

    await click(screen.getByTestId('launch-again'))
    expect(screen.getByTestId('launch-runs')).toHaveValue(null)
    expect(screen.getByTestId('launch-ceiling-override')).toHaveValue(null)
  })
})

describe('LaunchPanel — the Workspace seam (prd53 S1, ruling 7)', () => {
  it('initialCheckpointId seats the panel on the marker the operator chose, and follows it when it moves', async () => {
    const fetchImpl = ((async (input: string | URL | Request) => {
      const href = String(input)
      if (href === '/api/lab/checkpoints') return { ok: true, status: 200, json: async () => ({ checkpoints: [CHECKPOINT] }) } as Response
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown) as FetchLike
    const { rerender } = render(<LaunchPanel fetchImpl={fetchImpl} initialCheckpointId="ckpt-1" />)
    await waitFor(() => expect(screen.getByTestId('launch-checkpoint-ckpt-1')).toBeInTheDocument())
    expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true)
    rerender(<LaunchPanel fetchImpl={fetchImpl} initialCheckpointId={null} />)
    expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true)
  })
})

describe('LaunchPanel — prefilled from a proposal (prd-55 ruling 4, wave 6 widening)', () => {
  it("initialArms seats each arm's model, replacing the default three — brief always starts empty", async () => {
    render(<LaunchPanel fetchImpl={fetchImplFor({})} initialArms={[{ model: 'sonnet' }, { model: 'opus' }]} />)
    await waitFor(() => expect(screen.getByTestId(`launch-checkpoint-${CHECKPOINT.checkpointId}`)).toBeInTheDocument())

    const selects = modelSelects()
    expect(selects).toHaveLength(2)
    expect(selects[0]).toHaveValue('sonnet')
    expect(selects[1]).toHaveValue('opus')
    for (const brief of screen.getAllByPlaceholderText('brief (no brief if blank)')) {
      expect(brief).toHaveValue('')
    }
  })

  it('a proposalId travels in the launch body, unchanged, beside the arms and checkpoint it prefilled', async () => {
    const launchFetchImpl = answering(ANSWER)
    render(
      <LaunchPanel
        fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })}
        launchFetchImpl={launchFetchImpl}
        initialCheckpointId="ckpt-1"
        initialArms={[{ model: 'sonnet' }, { model: 'opus' }]}
        proposalId="proposal-1"
      />,
    )
    await waitFor(() => expect((screen.getByTestId('launch-checkpoint-ckpt-1').querySelector('input') as HTMLInputElement).checked).toBe(true))
    await review()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())

    // MUTATION: dropping the `...(proposalId === undefined ? {} : { proposalId })`
    // spread from LaunchPanel's request construction turns this assertion red
    // — `proposalId` would be absent from the body entirely (verified: see
    // this wave's report).
    expect(launchBody(launchFetchImpl)).toEqual({
      lane: 'feature',
      checkpointId: 'ckpt-1',
      arms: [{ model: 'sonnet' }, { model: 'opus' }],
      proposalId: 'proposal-1',
    })
  })

  it('with no proposalId, the body carries none — an operator-configured launch is not silently attributed to a proposal', async () => {
    const launchFetchImpl = answering(ANSWER)
    render(<LaunchPanel fetchImpl={fetchImplFor({ estimate: AVAILABLE_ESTIMATE })} launchFetchImpl={launchFetchImpl} />)
    await seatCheckpoint()
    await review()
    await click(screen.getByTestId('launch-confirm'))
    await waitFor(() => expect(screen.getByTestId('launch-result')).toBeInTheDocument())

    expect(Object.keys(launchBody(launchFetchImpl))).not.toContain('proposalId')
  })
})
