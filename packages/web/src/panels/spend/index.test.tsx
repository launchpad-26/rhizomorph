import { act, cleanup, render, screen, within } from '@testing-library/react'
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
import { formatTokens, formatUsd, formatUsdPerHour } from '../../lib/format.js'
import { formatCostOrGap, formatCostOverhead, selectCostOverhead } from './format.js'
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

    // The headline is output tokens (500), never the all-tier sum (2_610).
    const headline = screen.getByTestId('spend-total-tokens')
    expect(headline).toHaveTextContent(formatTokens(500))
    expect(headline).toHaveTextContent('output tokens — work produced')
    expect(headline).not.toHaveTextContent(formatTokens(2_610))
    expect(screen.queryByTestId('spend-total-cost')).not.toBeInTheDocument()
    expect(screen.queryByTestId('spend-rate')).not.toBeInTheDocument()
    expect(screen.getByTestId('spend-honesty')).toHaveTextContent(
      'Tokens only — no cost events yet. Dollars are notional on subscription plans anyway.',
    )
    // The role split (tokens-only) still renders — it never depends on dollars.
    expect(screen.getByTestId('spend-role-worker')).toHaveTextContent(formatTokens(500))
  })

  it('shows the conductor as an instrumentation gap, never a ratio, when only its tokens are seen', () => {
    // The exact incident this guards against: sessionlog --extra-sessions tags
    // a whole directory role: conductor, so tokens show up with no llm.cost
    // event ever arriving. A token-derived ratio would render a misleading
    // number (e.g. 0.14×) here; the fix must say "not instrumented" instead.
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'gap' })
    f.sessionStarted()
    f.llmUsage({
      lane: '2-core',
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    })
    f.llmCost({
      lane: '2-core',
      role: 'worker',
      model: 'claude-opus-5',
      costUsd: 0.42,
      authoritative: true,
    })
    f.llmUsage({
      lane: 'conductor',
      role: 'conductor',
      model: 'claude-sonnet-5',
      tokens: { input: 12, output: 5_600, cacheRead: 410_000, cacheCreation: 9_800 },
    })

    renderPanel(f.all())

    expect(screen.getByTestId('spend-total-cost')).toBeInTheDocument()
    expect(screen.getByTestId('spend-overhead-ratio')).toHaveTextContent(
      'conductor not instrumented — see docs/telemetry.md',
    )
    expect(screen.getByTestId('spend-overhead-ratio')).not.toHaveTextContent('×')
    // The conductor's OUTPUT tokens (5_600) show up in the role split, never
    // the all-tier sum (425_412) — only the ratio is gated.
    const conductorCard = screen.getByTestId('spend-role-conductor')
    expect(conductorCard).toHaveTextContent(formatTokens(5_600))
    expect(conductorCard).not.toHaveTextContent(formatTokens(425_412))
    // Its dollar figure must read as a gap, not the real-zero `$0.00` — that
    // would silently contradict the "not instrumented" headline right above it.
    expect(conductorCard).toHaveTextContent('no cost data')
    expect(conductorCard).not.toHaveTextContent('$0.00')
  })

  it('renders the full ticker with dollars, rate, honesty line, role split and lane bars', () => {
    const session = reduceAll(fixtureTelemetrySession())
    const totals = selectSessionSpend(session)
    const rate = selectSpendRate(session, { now: NOW })
    const roleSplit = selectRoleSpend(session)
    const lanes = selectLaneSpend(session)

    renderPanel(fixtureTelemetrySession())

    expect(screen.getByTestId('spend-total-tokens')).toHaveTextContent(
      formatTokens(totals.tokens.output),
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

    // The headline metric is on cost, not tokens: a conductor-heavy fixture,
    // instrumented on both sides, ratio computed from costUsd and rendered plainly.
    const overhead = selectCostOverhead(roleSplit.worker, roleSplit.conductor)
    expect(overhead.conductorInstrumented).toBe(true)
    expect(overhead.ratio).not.toBeNull()
    expect(roleSplit.conductor.costUsd).toBeGreaterThan(roleSplit.worker.costUsd)
    expect(screen.getByTestId('spend-overhead-ratio')).toHaveTextContent(
      formatCostOverhead(overhead),
    )

    for (const role of ['worker', 'conductor', 'auxiliary'] as const) {
      // Every role here is fully instrumented, so the gap-aware formatter
      // renders the same real dollar figure `formatUsd` would.
      expect(roleSplit[role].costEventCount).toBeGreaterThan(0)
      const card = screen.getByTestId(`spend-role-${role}`)
      expect(card).toHaveTextContent(formatTokens(roleSplit[role].tokens.output))
      expect(card).toHaveTextContent(formatCostOrGap(roleSplit[role]))
      // All four tiers are visible on the card, not just the output headline.
      expect(card).toHaveTextContent(`in ${formatTokens(roleSplit[role].tokens.input)}`)
      expect(card).toHaveTextContent(`rd ${formatTokens(roleSplit[role].tokens.cacheRead)}`)
      expect(card).toHaveTextContent(`wr ${formatTokens(roleSplit[role].tokens.cacheCreation)}`)
    }

    const laneRows = screen.getAllByTestId('spend-lane')
    expect(laneRows).toHaveLength(lanes.length)
    laneRows.forEach((row, index) => {
      const lane = lanes[index]!
      expect(lane.costEventCount).toBeGreaterThan(0)
      expect(row).toHaveTextContent(lane.lane)
      expect(row).toHaveTextContent(formatTokens(lane.tokens.output))
      expect(row).toHaveTextContent(formatCostOrGap(lane))
      // Never the unlabelled all-tier sum, even when it happens to differ from output.
      if (lane.tokens.total !== lane.tokens.output) {
        expect(row).not.toHaveTextContent(formatTokens(lane.tokens.total))
      }
      // Stacked bar: all four tiers get their own segment, muted for the cache pair.
      for (const key of ['output', 'input', 'cacheRead', 'cacheCreation'] as const) {
        expect(within(row).getByTestId(`spend-lane-segment-${key}`)).toBeInTheDocument()
      }
    })
    // Dearest lane first — the conductor outspent every worker lane here.
    expect(lanes[0]!.lane).toBe('conductor')
  })

  it('renders all four token tiers, labelled, beneath the headline', () => {
    renderPanel(fixtureTelemetrySession())

    const totals = selectSessionSpend(reduceAll(fixtureTelemetrySession()))
    const buckets = screen.getByTestId('spend-token-buckets')
    expect(within(buckets).getByTestId('spend-bucket-output')).toHaveTextContent(
      `output${formatTokens(totals.tokens.output)}`,
    )
    expect(within(buckets).getByTestId('spend-bucket-input')).toHaveTextContent(
      `input${formatTokens(totals.tokens.input)}`,
    )
    expect(within(buckets).getByTestId('spend-bucket-cacheRead')).toHaveTextContent(
      `cache read${formatTokens(totals.tokens.cacheRead)}`,
    )
    expect(within(buckets).getByTestId('spend-bucket-cacheCreation')).toHaveTextContent(
      `cache write${formatTokens(totals.tokens.cacheCreation)}`,
    )
  })

  it('shows the unattributed bucket as an actionable gap once a root session has booked spend against it', () => {
    // The exact shape #62 fixes: a repo-root session with nobody claiming it
    // books role: 'unattributed', lane: 'unattributed' — the panel must call
    // this out by name, not blend it silently into the lane list below.
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'root' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'unattributed',
      role: 'unattributed',
      tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    })

    renderPanel(f.all())

    const gap = screen.getByTestId('spend-unattributed-gap')
    expect(gap).toHaveTextContent(
      `${formatTokens(3_100)} output tokens unattributed — claim with --extra-sessions <dir>:<lane> or observatory env`,
    )
    expect(screen.queryByTestId('spend-refusal-gap')).not.toBeInTheDocument()
    // The unattributed bucket is not one of the three role-split columns.
    expect(screen.queryByTestId('spend-role-unattributed')).not.toBeInTheDocument()
  })

  it('renders no unattributed gap line when nothing has ever booked against that lane', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'clean' })
    f.sessionStarted()
    f.llmUsage({ lane: 'feature', role: 'worker' })

    renderPanel(f.all())

    expect(screen.queryByTestId('spend-unattributed-gap')).not.toBeInTheDocument()
  })

  it('surfaces refused telemetry.refused posts as a setup gap, counting throttled counts across multiple offenders', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'refused' })
    f.sessionStarted()
    f.llmUsage({ lane: 'feature', role: 'worker' })
    f.make('telemetry.refused', {
      instance: 'some-other-repo',
      expectedInstance: 'this-repo',
      count: 3,
    })
    f.make('telemetry.refused', {
      instance: null,
      expectedInstance: 'this-repo',
      count: 2,
    })

    renderPanel(f.all())

    expect(screen.getByTestId('spend-refusal-gap')).toHaveTextContent(
      '5 posts refused from unknown instance',
    )
  })

  it('renders no refusal gap line when nothing has ever been refused', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'norefuse' })
    f.sessionStarted()
    f.llmUsage({ lane: 'feature', role: 'worker' })

    renderPanel(f.all())

    expect(screen.queryByTestId('spend-refusal-gap')).not.toBeInTheDocument()
  })
})
