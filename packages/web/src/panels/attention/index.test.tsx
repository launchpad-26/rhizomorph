import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider, useSelection } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import AttentionStrip from './index.js'

/**
 * The wiring test: does the default export actually read the shared fleet and
 * the shared selection, through the real providers `app/App.tsx` nests it in
 * — as opposed to `AttentionStripView.test.tsx`, which drives the rendering
 * logic directly against a `Fleet` it builds by hand.
 */

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

class SilentEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

function SelectedProbe() {
  const { selectedId } = useSelection()
  return <span data-testid="selected">{selectedId ?? 'none'}</span>
}

async function renderStrip() {
  await act(async () => {
    render(
      <StreamProvider url="/api/stream" now={NOW} createSource={() => new SilentEventSource()}>
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <AttentionStrip />
            <SelectedProbe />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
  })
}

describe('AttentionStrip (wired)', () => {
  it('reads the shared fleet: calm before anything has happened', async () => {
    await renderStrip()
    expect(screen.getByText('ALL CLEAR')).toBeInTheDocument()
  })

  it('reads the shared fleet: the staged-pathology fixture reaches the strip', async () => {
    await renderStrip()

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })

    expect(screen.getByText('NEED ATTENTION')).toBeInTheDocument()
  })

  it('clicking a chip writes into the one shared selection context', async () => {
    await renderStrip()
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })

    expect(screen.getByTestId('selected').textContent).toBe('none')

    const frozenChip = document.querySelector('[data-chip-kind="frozen"]') as HTMLButtonElement
    expect(frozenChip).not.toBeNull()

    await act(async () => {
      fireEvent.click(frozenChip)
    })

    expect(screen.getByTestId('selected').textContent).toBe('42-otel-receiver')
  })
})
