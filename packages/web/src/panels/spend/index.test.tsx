import { act, cleanup, render, screen } from '@testing-library/react'
import {
  FIXTURE_START_TS,
  createEventFactory,
  fixtureSession,
  fixtureTelemetrySession,
  reduceAll,
  selectLaneSpend,
  selectRoleSpend,
  selectSessionSpend,
  selectSpendRate,
} from '@observatory/core'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import { formatOverheadRatio, formatTokens, formatUsd, formatUsdPerHour } from './format.js'
import SpendPanel from './index.js'

afterEach(cleanup)

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

/** Matches the moment `core`'s own spend fixtures were authored against. */
const NOW = FIXTURE_START_TS + 10 * 60_000

function renderPanel(events: ReturnType<typeof fixtureSession> = [], open = true) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <SpendPanel now={NOW} />
    </StreamProvider>,
  )
  if (open) act(() => source?.open())
  act(() => {
    for (const event of events) source?.emit(event)
  })
  return utils
}

describe('SpendPanel', () => {
  it('renders a header and a waiting state before any connection or data', () => {
    render(
      <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
        <SpendPanel now={NOW} />
      </StreamProvider>,
    )
    expect(screen.getByText('Spend ticker')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no telemetry', () => {
    renderPanel(fixtureSession())

    expect(screen.getByText('No spend recorded yet this session.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('enters tokens-only mode when usage arrives with no cost event, and says so', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'tok' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'solo',
      role: 'worker',
      tokens: { input: 10, output: 500, cacheRead: 2_000, cacheCreation: 100 },
    })

    renderPanel(f.all())

    expect(screen.getByTestId('spend-total-tokens')).toHaveTextContent(formatTokens(2_610))
    expect(screen.queryByTestId('spend-total-cost')).not.toBeInTheDocument()
    expect(screen.queryByTestId('spend-rate')).not.toBeInTheDocument()
    expect(screen.getByTestId('spend-honesty')).toHaveTextContent(
      'Tokens only — no cost events yet. Dollars are notional on subscription plans anyway.',
    )
    // The role split (tokens-only) still renders — it never depends on dollars.
    expect(screen.getByTestId('spend-role-worker')).toHaveTextContent(formatTokens(2_610))
  })

  it('renders the full ticker with dollars, rate, honesty line, role split and lane bars', () => {
    const session = reduceAll(fixtureTelemetrySession())
    const totals = selectSessionSpend(session)
    const rate = selectSpendRate(session, { now: NOW })
    const roleSplit = selectRoleSpend(session)
    const lanes = selectLaneSpend(session)

    renderPanel(fixtureTelemetrySession())

    expect(screen.getByTestId('spend-total-tokens')).toHaveTextContent(
      formatTokens(totals.tokens.total),
    )
    expect(screen.getByTestId('spend-total-cost')).toHaveTextContent(formatUsd(totals.costUsd))
    // A mix of authoritative and estimated dollars must say so, not blend silently.
    expect(totals.costIsAuthoritative).toBe(false)
    expect(screen.getByTestId('spend-total-cost')).toHaveTextContent('incl. estimate')
    expect(screen.getByTestId('spend-rate')).toHaveTextContent(
      formatUsdPerHour(rate.costUsdPerHour),
    )
    expect(screen.getByTestId('spend-honesty')).toHaveTextContent(
      'Dollars are notional on subscription plans',
    )

    // The headline metric: a conductor-heavy fixture, ratio not null, rendered plainly.
    expect(roleSplit.overheadRatio).not.toBeNull()
    expect(roleSplit.conductor.tokens.total).toBeGreaterThan(roleSplit.worker.tokens.total)
    expect(screen.getByTestId('spend-overhead-ratio')).toHaveTextContent(
      formatOverheadRatio(roleSplit.overheadRatio),
    )

    for (const role of ['worker', 'conductor', 'auxiliary'] as const) {
      expect(screen.getByTestId(`spend-role-${role}`)).toHaveTextContent(
        formatTokens(roleSplit[role].tokens.total),
      )
      expect(screen.getByTestId(`spend-role-${role}`)).toHaveTextContent(
        formatUsd(roleSplit[role].costUsd),
      )
    }

    const laneRows = screen.getAllByTestId('spend-lane')
    expect(laneRows).toHaveLength(lanes.length)
    laneRows.forEach((row, index) => {
      const lane = lanes[index]!
      expect(row).toHaveTextContent(lane.lane)
      expect(row).toHaveTextContent(formatTokens(lane.tokens.total))
      expect(row).toHaveTextContent(formatUsd(lane.costUsd))
    })
    // Dearest lane first — the conductor outspent every worker lane here.
    expect(lanes[0]!.lane).toBe('conductor')
  })
})
