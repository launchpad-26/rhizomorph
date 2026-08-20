import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFlag } from '../settings/registry.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { StreamProvider } from './StreamContext.js'
import { Welcome } from './Welcome.js'

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/**
 * THE FIRST-RUN WELCOME (professionalisation loop 1). The card is the one
 * moment the instrument explains itself to a stranger, so the laws here are
 * about that moment staying honest and staying dismissable:
 *
 * - it shows exactly once — dismissal is a machine-scoped preference, so a
 *   reload does not resurrect it (and "restore defaults" deliberately does);
 * - the sample copy names the sample as a sample (prd-34 ruling 6's stance:
 *   nothing synthetic may pass as telemetry);
 * - it never traps: Esc dismisses from anywhere, and the card steals no focus.
 */

function mount() {
  return render(
    <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
      <Welcome />
    </StreamProvider>,
  )
}

describe('the first-run welcome', () => {
  beforeEach(() => localStorage.clear())
  afterEach(cleanup)

  it('greets an unwelcomed boot, and leads with what the picture is', () => {
    mount()
    const card = screen.getByTestId('welcome-card')
    expect(card).toBeInTheDocument()
    expect(card.textContent).toContain("agent's worktree")
    // The default source is live, so the copy speaks to the live repo.
    expect(card.textContent).toContain('live repository')
  })

  it('names the sample as a sample when a fixture is on', () => {
    mount()
    // The fixture keys are the SPA's own affordance (StreamContext).
    fireEvent.keyDown(window, { key: '2' })
    const card = screen.getByTestId('welcome-card')
    expect(card.textContent).toContain('sample fleet')
    expect(card.textContent).toContain('synthetic')
    expect(card.textContent).toContain('1 live · 2 sample fleet · 3 staged pathologies')
  })

  it('dismisses on the button, persists the dismissal, and stays gone on remount', () => {
    mount()
    fireEvent.click(screen.getByTestId('welcome-dismiss'))
    expect(screen.queryByTestId('welcome-card')).not.toBeInTheDocument()
    expect(readFlag('onboarding.welcomed')).toBe(true)

    cleanup()
    mount()
    expect(screen.queryByTestId('welcome-card')).not.toBeInTheDocument()
  })

  it('dismisses on Escape from anywhere — the card never traps', () => {
    mount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('welcome-card')).not.toBeInTheDocument()
    expect(readFlag('onboarding.welcomed')).toBe(true)
  })

  it('counts connecting as being welcomed — the link is a dismissal too', () => {
    mount()
    const link = screen.getByTestId('welcome-connect')
    expect(link.getAttribute('href')).toBe('/connect')
    fireEvent.click(link)
    expect(readFlag('onboarding.welcomed')).toBe(true)
  })

  it('is a region, not a dialog — the instrument stays usable under it', () => {
    mount()
    const card = screen.getByTestId('welcome-card')
    expect(card.getAttribute('role')).toBe('region')
    expect(card.getAttribute('aria-label')).toBe('welcome')
    // No focus theft: nothing inside the card holds focus at mount.
    expect(card.contains(document.activeElement)).toBe(false)
  })
})
