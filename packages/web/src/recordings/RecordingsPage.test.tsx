import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import type { FetchLike } from '../replay/api.js'
import { RecordingsPage } from './RecordingsPage.js'
import type { DownloadEnv } from './export.js'
import type { LabelFetchLike } from './label.js'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/recordings')
})

const AUTHORITATIVE = {
  id: '1000',
  fileName: 'session-1000.jsonl',
  startedAt: 1000,
  sizeBytes: 4096,
  title: 'the morning run',
  label: 'the morning run',
  lanes: 3,
  landed: 2,
  durationMs: 65_000,
  outputTokens: 12_345,
  costUsd: 4.5,
  costIsAuthoritative: true,
}

const ESTIMATED = {
  id: '2000',
  fileName: 'session-2000.jsonl',
  startedAt: 2000,
  sizeBytes: 2048,
  title: '2 lanes, 1 landed',
  label: null,
  lanes: 2,
  landed: 1,
  durationMs: 30_000,
  outputTokens: 5_000,
  costUsd: 1.1,
  costIsAuthoritative: false,
}

const NO_COST_FEED = {
  id: '3000',
  fileName: 'session-3000.jsonl',
  startedAt: 3000,
  sizeBytes: 1024,
  title: 'no telemetry',
  label: null,
  lanes: 1,
  landed: 0,
  durationMs: 10_000,
  outputTokens: 900,
  costUsd: 0,
  costIsAuthoritative: null,
  transcriptCapture: null,
}

function fetchImplFor(recordings: unknown[]): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return { ok: true, status: 200, json: async () => ({ sessions: recordings }) } as Response
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

function renderPage(options: {
  recordings?: unknown[]
  fetchImpl?: FetchLike
  labelFetchImpl?: LabelFetchLike
  downloadEnv?: DownloadEnv
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetchImplFor(options.recordings ?? [AUTHORITATIVE, ESTIMATED, NO_COST_FEED])
  return render(
    <ModeProvider fetchImpl={fetchImpl}>
      <RecordingsPage fetchImpl={fetchImpl} labelFetchImpl={options.labelFetchImpl} downloadEnv={options.downloadEnv} />
    </ModeProvider>,
  )
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('RecordingsPage', () => {
  it('lists every recording with what GET /api/sessions already computed — nothing recomputed', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    expect(screen.getByTestId('rename-start-1000')).toHaveTextContent('the morning run')
    const row = screen.getByTestId('recording-row-1000')
    expect(row).toHaveTextContent('3') // lanes
    expect(row).toHaveTextContent('2') // landed
    expect(row).toHaveTextContent('1:05') // duration
    expect(row).toHaveTextContent('$4.50')
  })

  it('shows the honest gap for an estimated cost — a real dollar figure, marked, not hidden', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-2000')
    expect(row).toHaveTextContent('$1.10')
    expect(row).toHaveTextContent('est.')
  })

  it('never renders a null costIsAuthoritative as $0 — tokens and the gap marker instead', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-3000')
    expect(row).not.toHaveTextContent('$0.00')
    expect(row).toHaveTextContent('900 tok out')
    expect(screen.getByTestId('recording-cost-gap-3000')).toBeInTheDocument()
  })

  it('says so honestly when transcript capture never ran for a session', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const row = screen.getByTestId('recording-row-3000')
    expect(row).toHaveTextContent('no transcripts captured')
    expect(screen.getByTestId('recording-capture-gap-3000')).toBeInTheDocument()
  })

  it('shows an empty state rather than a bare blank page', async () => {
    renderPage({ recordings: [] })
    await waitFor(() => expect(screen.getByTestId('recordings-empty')).toBeInTheDocument())
  })

  it('shows the fetch failure rather than silently rendering nothing', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as FetchLike
    renderPage({ fetchImpl })
    await waitFor(() => expect(screen.getByTestId('recordings-error')).toBeInTheDocument())
  })

  it('renaming a row updates its title in place, without a full reload of the listing', async () => {
    const labelFetchImpl: LabelFetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: '2000', label: 'renamed run' }),
    }))
    const fetchImpl = vi.fn(fetchImplFor([AUTHORITATIVE, ESTIMATED, NO_COST_FEED]))
    renderPage({ fetchImpl, labelFetchImpl })
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    const initialCalls = fetchImpl.mock.calls.length
    await click(screen.getByTestId('rename-start-2000'))
    await act(async () => {
      fireEvent.change(screen.getByTestId('rename-input-2000'), { target: { value: 'renamed run' } })
    })
    await click(screen.getByTestId('rename-save-2000'))

    expect(labelFetchImpl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('rename-start-2000')).toHaveTextContent('renamed run')
    // No re-fetch of the whole listing — the row updated from the save's own answer.
    expect(fetchImpl.mock.calls.length).toBe(initialCalls)
  })

  it('opening a row selects it in the existing replay session and returns to the balcony', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await click(screen.getByTestId('recording-open-1000'))

    expect(window.location.pathname).toBe('/')
  })

  it('exporting a row triggers exactly one download of the portable record', async () => {
    const anchor = { href: '', download: '', click: vi.fn() }
    const downloadEnv: DownloadEnv = {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
      createAnchor: vi.fn(() => anchor),
      appendAnchor: vi.fn(),
      removeAnchor: vi.fn(),
    }
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return { ok: true, status: 200, json: async () => ({ sessions: [AUTHORITATIVE] }) } as Response
      }
      if (href === '/api/meta') {
        return { ok: true, status: 200, json: async () => ({ repoName: 'demo' }) } as Response
      }
      if (href === '/api/sessions/1000/events') {
        return { ok: true, status: 200, json: async () => ({ events: [] }) } as Response
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike

    renderPage({ fetchImpl, downloadEnv })
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    await click(screen.getByTestId('recording-export-1000'))
    await waitFor(() => expect(anchor.click).toHaveBeenCalledTimes(1))
    expect(anchor.download).toBe('demo-1000.rhizorecord.json')
  })

  it('renders no live-fleet surface — no scene, no panel, no fleet strip', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('recordings-table')).toBeInTheDocument())

    expect(screen.queryByTestId('fleet-table')).toBeNull()
    expect(document.querySelector('[data-panel]')).toBeNull()
  })
})
