import { act, cleanup, render } from '@testing-library/react'
import { createEventFactory } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { StatusBar } from './StatusBar.js'
import { StreamProvider } from './StreamContext.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/** A server that has not shipped `.swarm/lanes.json` — not this test's concern. */
const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

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

function renderBar() {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <StatusBar />
      </FleetProvider>
    </StreamProvider>,
  )
  return { ...utils, source: () => source }
}

function pill(container: HTMLElement, key: 'git' | 'tmux' | 'workmux' | 'sessionlog' | 'otel'): HTMLElement {
  const el = container.querySelector(`[data-source="${key}"]`)
  if (el === null) throw new Error(`no pill for ${key}`)
  return el as HTMLElement
}

describe('StatusBar', () => {
  it('shows every source as live before any collector event arrives', () => {
    const { container } = renderBar()

    for (const key of ['git', 'tmux', 'workmux', 'sessionlog', 'otel'] as const) {
      expect(pill(container, key).dataset.health).toBe('live')
    }
  })

  it('surfaces a disabled collector with its reason on hover/focus', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' }))
    })

    const workmux = pill(container, 'workmux')
    expect(workmux.dataset.health).toBe('disabled')
    expect(workmux.title).toBe('workmux not found on PATH')
    expect(workmux.getAttribute('aria-label')).toContain('workmux not found on PATH')

    // Untouched sources stay live.
    expect(pill(container, 'git').dataset.health).toBe('live')
    expect(pill(container, 'tmux').dataset.health).toBe('live')
    expect(pill(container, 'sessionlog').dataset.health).toBe('live')
    expect(pill(container, 'otel').dataset.health).toBe('live')
  })

  it('surfaces a disabled sessionlog collector — the most likely stranger failure — with its reason', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'sessionlog', reason: 'no Claude session logs found' }))
    })

    const sessionlog = pill(container, 'sessionlog')
    expect(sessionlog.dataset.health).toBe('disabled')
    expect(sessionlog.title).toBe('no Claude session logs found')
  })

  it('surfaces an errored collector with its last message on hover/focus', () => {
    const { container, source } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' }))
    })

    const tmux = pill(container, 'tmux')
    expect(tmux.dataset.health).toBe('errored')
    expect(tmux.title).toBe('capture-pane timed out')
    expect(tmux.getAttribute('aria-label')).toContain('capture-pane timed out')
  })

  it('renders no gap voice while nothing has degraded', () => {
    const { queryAllByTestId } = renderBar()
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('speaks the gap voice — WHAT, WHY, and the command — for a dead collector', () => {
    const { source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' }))
    })

    const lines = queryAllByTestId('gap-voice')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('WORKMUX COLLECTOR DISABLED')
    expect(lines[0]).toHaveTextContent('workmux not found on PATH')
    expect(lines[0]).toHaveTextContent('rhizomorph doctor')
  })

  it('does not speak the gap voice for a merely errored (not dead) collector', () => {
    const { source, queryAllByTestId } = renderBar()
    const f = createEventFactory()

    act(() => {
      source()?.emit(f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' }))
    })

    // Errored already reads on the pill above, and escalates to the
    // attention strip separately (buildFleet's ladder) — this bar's gap
    // voice is reserved for the dead (disabled), not the merely broken.
    expect(queryAllByTestId('gap-voice')).toHaveLength(0)
  })

  it('reflects the live SSE connection state', () => {
    const { container, source } = renderBar()

    act(() => source()?.open())

    const sse = container.querySelector('[aria-label^="Stream:"]') as HTMLElement | null
    expect(sse?.title).toBe('live')
  })
})
