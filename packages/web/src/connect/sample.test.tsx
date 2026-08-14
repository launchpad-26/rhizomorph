import { createEvent, specFor, type RhizomorphEvent } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { STREAM_SOURCE_KEYS, StreamProvider, useStream } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike as ReplayFetchLike } from '../replay/api.js'
import { SampleFleetControl } from './sample.js'

/**
 * THE SAMPLE-FLEET AFFORDANCE'S OWN LAW (#259, prd-19 ruling 6): activating
 * the sample renders the fixture's own `provenance` string verbatim, and
 * returning to live restores `source === 'live'` without a reload. Driven
 * through a real `StreamProvider` — the same one `index.test.tsx` mounts —
 * rather than a stubbed `useStream()`, so "restores `source === 'live'`" is a
 * claim about the real context, not an argument handed to the component.
 */

afterEach(cleanup)

/** Pinned so the fixture's own tick timer (`FIXTURE_TICK_MS`) never arms while a test is mid-assertion. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(_event: RhizomorphEvent) {}

  close() {}
}

/**
 * Stands in for `useFixtureKeys`' keypress: the only way to reach `pathology`
 * from this control, which offers `fleet20` and nothing else.
 */
function SourceDriver() {
  const { setSource } = useStream()
  return (
    <button type="button" data-testid="drive-pathology" onClick={() => setSource('pathology')}>
      drive pathology
    </button>
  )
}

async function renderControl(extra?: ReactNode) {
  let source: FakeEventSource | null = null

  await act(async () => {
    render(
      <StreamProvider
        url="/api/stream"
        now={NOW}
        createSource={() => {
          source = new FakeEventSource()
          return source
        }}
      >
        <SampleFleetControl />
        {extra}
      </StreamProvider>,
    )
  })

  const live = source as FakeEventSource | null
  if (live === null) throw new Error('the stream never asked for a source')
  act(() => live.open())
}

describe('the sample-fleet affordance', () => {
  it('starts live: the activation button and the key-doc line are visible, no banner', async () => {
    await renderControl()

    expect(screen.getByTestId('connect-sample-activate')).toBeInTheDocument()
    expect(screen.queryByTestId('connect-sample-banner')).not.toBeInTheDocument()

    // Each key against what that key actually does, read out of
    // `STREAM_SOURCE_KEYS` itself. `toContain('1')` — which is what this
    // asserted first — passes just as well for "1 staged pathologies · 2
    // sample fleet · 3 live", and a mismapping is the one thing this line can
    // get wrong.
    const keys = screen.getByTestId('connect-sample-keys').textContent ?? ''
    expect(Object.keys(STREAM_SOURCE_KEYS)).toEqual(['1', '2', '3'])
    expect(keys).toContain('1 live')
    expect(keys).toContain('2 sample fleet')
    expect(keys).toContain('3 staged pathologies')
    expect(STREAM_SOURCE_KEYS['1']).toBe('live')
    expect(STREAM_SOURCE_KEYS['2']).toBe('fleet20')
    expect(STREAM_SOURCE_KEYS['3']).toBe('pathology')
  })

  /** THE LAW, FIRST HALF: activating the sample renders the fixture's own provenance string verbatim. */
  it('renders the fixture\'s own provenance string, verbatim, the instant the sample is activated', async () => {
    await renderControl()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-activate'))
    })

    expect(screen.getByTestId('connect-sample-banner').textContent).toContain(specFor('fleet20').provenance)
    expect(screen.getByTestId('connect-sample-banner').textContent).toContain('synthetic · 20 lanes · real schema events')
    expect(screen.queryByTestId('connect-sample-activate')).not.toBeInTheDocument()
  })

  /**
   * THE LAW, FIRST HALF, MADE UNFAKEABLE. One fixture proves nothing about
   * "verbatim": delete `provenance` from the `useStream()` read and hardcode
   * the twenty-lane string into the banner — a control that can no longer
   * render any fixture's own provenance, which is the exact thing ruling 6
   * forbids — and every assertion above still passes. Two fixtures with
   * different strings cannot both be satisfied by one literal.
   */
  it('renders whichever fixture is driving, not one string it happens to know', async () => {
    await renderControl(<SourceDriver />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('drive-pathology'))
    })

    const banner = screen.getByTestId('connect-sample-banner').textContent ?? ''
    expect(banner).toContain(specFor('pathology').provenance)
    expect(banner).toContain('synthetic · one lane per pathology · real schema events')
    expect(banner).not.toContain(specFor('fleet20').provenance)
    // Still the honest banner, not the activation button: `pathology` is no
    // more live than `fleet20` is.
    expect(screen.queryByTestId('connect-sample-activate')).not.toBeInTheDocument()
    expect(screen.getByTestId('connect-sample-return')).toBeInTheDocument()
  })

  /** THE LAW, SECOND HALF: returning to live restores `source === 'live'` without a reload. */
  it('restores the live source, with no reload, the instant "return to live" is clicked', async () => {
    await renderControl()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-activate'))
    })
    expect(screen.getByTestId('connect-sample-banner')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-return'))
    })

    // The same mounted component, the same render tree — only the context's
    // `source` changed, which is exactly what flips this control back to the
    // activation button rather than the banner.
    expect(screen.queryByTestId('connect-sample-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('connect-sample-activate')).toBeInTheDocument()
  })
})

/**
 * REPLAY IS NOT ONE OF THE THREE LOGS. `StreamContext`'s replay branch returns
 * before its fixture branch, so while a recording is loaded `setSource` moves
 * nothing and `provenance` reads `replay · recorded session` whatever `source`
 * says. Before this test the control rendered its live face there, and the
 * observed sequence was: "view a sample fleet" offered while the page's own
 * banner already said the checklist was not live → clicking it produced no
 * sample fleet, only `reading replay · recorded session — not the live log`
 * → **"return to live" did not return to live.** A control whose whole job is
 * provenance honesty must not be the surface that lies.
 */
describe('the sample-fleet affordance, while replaying', () => {
  const REPLAY_EVENTS = [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: 'evt-1', ts: 1000 },
    ),
  ]

  /** `ModeProvider`'s two reads: the session list, then the selected session's events. */
  const replayFetch = (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return { ok: true, status: 200, json: async () => ({ sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 100 }] }) }
    }
    if (href === '/api/sessions/s1/events') return { ok: true, status: 200, json: async () => ({ events: REPLAY_EVENTS }) }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as ReplayFetchLike

  /** Stands in for the replay controls — the only thing that puts the app in replay mode. */
  function ReplayDriver() {
    const { sessions, selectSession } = useReplay()
    return (
      <button type="button" data-testid="drive-replay" onClick={() => selectSession(sessions[0]?.id ?? null)}>
        select session
      </button>
    )
  }

  it('stands down entirely — no button to offer a fleet it cannot show, no "return to live" that would not', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={replayFetch}>
          <StreamProvider url="/api/stream" now={NOW} createSource={() => new FakeEventSource()}>
            <ReplayDriver />
            <SampleFleetControl />
          </StreamProvider>
        </ModeProvider>,
      )
    })

    // Live, before a recording is selected: the control is there as ever.
    await waitFor(() => expect(screen.getByTestId('connect-sample-activate')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByTestId('drive-replay'))
    })

    await waitFor(() => expect(screen.queryByTestId('connect-sample')).not.toBeInTheDocument())
    expect(screen.queryByTestId('connect-sample-activate')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connect-sample-return')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connect-sample-keys')).not.toBeInTheDocument()
  })
})
