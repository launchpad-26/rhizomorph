import type { RhizomorphEvent } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
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

async function renderControl() {
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
    expect(screen.getByTestId('connect-sample-keys').textContent).toContain('1')
    expect(screen.getByTestId('connect-sample-keys').textContent).toContain('2')
    expect(screen.getByTestId('connect-sample-keys').textContent).toContain('3')
    expect(screen.queryByTestId('connect-sample-banner')).not.toBeInTheDocument()
  })

  /** THE LAW, FIRST HALF: activating the sample renders the fixture's own provenance string verbatim. */
  it('renders the fixture\'s own provenance string, verbatim, the instant the sample is activated', async () => {
    await renderControl()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-sample-activate'))
    })

    expect(screen.getByTestId('connect-sample-banner').textContent).toContain('synthetic · 20 lanes · real schema events')
    expect(screen.queryByTestId('connect-sample-activate')).not.toBeInTheDocument()
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
