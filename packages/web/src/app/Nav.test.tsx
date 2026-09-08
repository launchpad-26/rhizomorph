import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { discloseText } from '../disclosure/testing.js'
import type { FetchLike } from '../replay/api.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { Nav } from './Nav.js'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

/**
 * THE ONE PRIMARY NAV, TESTED ON ITS OWN (#549) — before this it only ever
 * existed embedded in `Shell.tsx`'s `TopDock`, so `Shell.test.tsx` was the
 * only place it could be exercised, and only for the one route (`balcony`)
 * `Shell` ever mounted under. Extracting it to its own module means every
 * surface can mount the exact same component (`Shell.test.tsx`,
 * `LanePage.test.tsx`, `RecordingsPage.test.tsx`, `LabPage.test.tsx`,
 * `connect/index.test.tsx` each still prove it renders on their own page) —
 * this file is where its own behaviour, once, is pinned.
 */
describe('Nav — the four hands and the settings entry, real anchors', () => {
  it('links to all four hands with real <a href> anchors', () => {
    render(<Nav />)

    const observatory = screen.getByTestId('nav-observatory')
    const recordings = screen.getByTestId('nav-recordings')
    const lab = screen.getByTestId('nav-lab')
    const connect = screen.getByTestId('nav-connect')

    for (const link of [observatory, recordings, lab, connect]) {
      expect(link.tagName).toBe('A')
    }
    expect(observatory.getAttribute('href')).toBe('/')
    expect(recordings.getAttribute('href')).toBe('/recordings')
    expect(lab.getAttribute('href')).toBe('/lab')
    expect(connect.getAttribute('href')).toBe('/connect')
  })

  /**
   * The fifth entry (#550, prd-35 ruling 1 / S1). Not a constitutional hand —
   * it is where a person changes what the instrument does for them — but it is
   * reachable from the SAME strip on every surface, which is the requirement:
   * a settings link that lived in a per-page corner would spend exactly what
   * #549 bought.
   */
  it('reaches the settings surface from the persistent strip, as one more real anchor', () => {
    render(<Nav />)

    const settings = screen.getByTestId('nav-settings')
    expect(settings.tagName).toBe('A')
    expect(settings.getAttribute('href')).toBe('/settings')
  })

  it('carries the one keyboard-reachable focus token (#548) on every hand', () => {
    render(<Nav />)

    for (const testId of ['nav-observatory', 'nav-recordings', 'nav-lab', 'nav-connect', 'nav-settings']) {
      expect(screen.getByTestId(testId).className).toContain('focus-ring')
    }
  })

  it('marks exactly the current route active, and no other', () => {
    window.history.replaceState(null, '', '/connect')
    render(<Nav />)

    expect(screen.getByTestId('nav-connect').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-recordings').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-lab').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('nav-settings').getAttribute('aria-current')).toBeNull()
  })

  it('marks settings itself active on its own route — it has an entry of its own now (#550)', () => {
    window.history.replaceState(null, '', '/settings')
    render(<Nav />)

    expect(screen.getByTestId('nav-settings').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBeNull()
  })

  it('falls back to Observatory for a route with no entry of its own (lane)', () => {
    window.history.replaceState(null, '', '/lane/some-handle')
    render(<Nav />)
    expect(screen.getByTestId('nav-observatory').getAttribute('aria-current')).toBe('page')
  })

  it('navigates via pushState on a plain click, not a full reload', async () => {
    render(<Nav />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-connect'), { button: 0 })
    })

    expect(window.location.pathname).toBe('/connect')
  })

  it('leaves a modifier-clicked link to the browser default (new tab)', async () => {
    render(<Nav />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-recordings'), { button: 0, metaKey: true })
    })

    expect(window.location.pathname).toBe('/')
  })

  it('every hand is keyboard-reachable — a real, independently focusable element, in DOM order', () => {
    render(<Nav />)

    const anchors = screen.getAllByRole('link')
    expect(anchors.map((anchor) => anchor.getAttribute('data-testid'))).toEqual([
      'nav-observatory',
      'nav-recordings',
      'nav-lab',
      'nav-connect',
      'nav-settings',
    ])
    for (const anchor of anchors) {
      anchor.focus()
      expect(document.activeElement).toBe(anchor)
    }
  })
})

// ── S4's unavailable state: the lab during replay, disabled WITH ITS REASON ─

const nextId = createIdFactory('evt')

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function replayFetch(): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1_000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/s1/events') {
      return jsonResponse({
        events: [
          createEvent(
            'session.started',
            { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
            { id: nextId(), ts: 1_000 },
          ),
        ],
      })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

function ReplayEntry() {
  const { sessions, selectSession } = useReplay()
  return <button onClick={() => selectSession(sessions[0]?.id ?? null)}>enter replay</button>
}

describe('Nav — S4 unavailable state (the lab during replay)', () => {
  it('renders Lab as a normal, enabled link while live', () => {
    render(
      <ModeProvider fetchImpl={replayFetch()}>
        <Nav />
      </ModeProvider>,
    )

    const lab = screen.getByTestId('nav-lab')
    expect(lab.tagName).toBe('A')
    expect(lab.getAttribute('aria-disabled')).toBeNull()
  })

  it('disables Lab, with its reason stated, once replay is entered — never hidden', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={replayFetch()}>
          <Nav />
          <ReplayEntry />
        </ModeProvider>,
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByText('enter replay'))
    })
    // `selectSession` fetches the session's events before `isReplaying` (and
    // therefore `mode`) flips — one more tick past the click itself.
    await waitFor(() => expect(screen.getByTestId('nav-lab').getAttribute('aria-disabled')).toBe('true'))

    // Still present, in the same place — never hidden.
    const lab = screen.getByTestId('nav-lab')
    expect(lab).toBeInTheDocument()
    expect(lab.tagName).not.toBe('A')

    // The reason reaches a reader three ways, and this asserts all three
    // rather than describing them. It used to be a `title=` (#220), which was
    // one way, delayed, and not the keyboard's.
    //
    //   1. in the visually-hidden text, for a screen reader passing over it
    expect(lab.textContent).toMatch(/ — \S/)
    //   2. and 3. on hover and on focus, in the card — `discloseText` opens it
    //      both ways and refuses to return unless the two agree (charter §6).
    const card = discloseText(lab)
    expect(card).toContain('this view is unavailable')
    expect(card).toContain('it becomes available again on its own when the mode changes')

    // The other three hands are untouched by the lab's own unavailability.
    expect(screen.getByTestId('nav-observatory').tagName).toBe('A')
    expect(screen.getByTestId('nav-recordings').tagName).toBe('A')
    expect(screen.getByTestId('nav-connect').tagName).toBe('A')
  })
})
