import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAME_PROCESS_WARNING } from '../connect/links.js'
import { HOST_GLOBAL } from './host.js'
import { adoptRepoScope, readPreference, readRecordOverlay, writePreference } from './registry.js'
import { SettingsPage } from './SettingsPage.js'
import { TelemetryBlock } from './TelemetryBlock.js'

/**
 * THE SETTINGS SURFACE, AS A PERSON MEETS IT (prd-35 S1, #550).
 *
 * The structural claims — every key covered, every group present, every
 * unavailable control carrying its reason — are `coverage-law.test.tsx`'s. This
 * file is the behaviour: choosing a thing changes the document, the change
 * survives a reload, the change is visibly a change, and it can be put back.
 */

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  adoptRepoScope(null)
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
  document.documentElement.removeAttribute('data-motion')
})

afterEach(cleanup)

/** A `window.matchMedia` that answers for exactly the two queries this page asks about. */
function mockSystem(system: { light?: boolean; reduced?: boolean }): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? system.reduced === true : system.light === true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

function choose(prefId: string, value: string): void {
  act(() => {
    fireEvent.click(screen.getByTestId(`pref-${prefId}-${value}`))
  })
}

describe('the theme switch (prd-32 ruling 4, given its home by prd-35 ruling 1)', () => {
  it('applies the chosen theme to the document and persists it across a reload', () => {
    const restore = mockSystem({})
    try {
      render(<SettingsPage />)
      choose('appearance.theme', 'light')

      expect(document.documentElement.dataset.theme).toBe('light')
      expect(readPreference('appearance.theme')).toBe('light')

      // A reload: the document loses its attributes, the page is built again,
      // and the choice has to come back from storage rather than from memory.
      cleanup()
      document.documentElement.removeAttribute('data-theme')
      render(<SettingsPage />)

      expect(document.documentElement.dataset.theme).toBe('light')
      expect((screen.getByTestId('pref-appearance.theme-light') as HTMLInputElement).checked).toBe(true)
    } finally {
      restore()
    }
  })

  it('follows the system when told to, in both directions', () => {
    let restore = mockSystem({ light: true })
    try {
      render(<SettingsPage />)
      expect(document.documentElement.dataset.theme).toBe('light')
    } finally {
      restore()
    }

    cleanup()
    restore = mockSystem({ light: false })
    try {
      render(<SettingsPage />)
      expect(document.documentElement.dataset.theme).toBe('dark')
    } finally {
      restore()
    }
  })

  it('says out loud which surface the choice does not reach, rather than implying it reached all of them', () => {
    render(<SettingsPage />)
    // Law 12's voice: WHAT is missing, WHY it matters, what fixes it.
    //
    // The note was rewritten when #551 landed the light block, and the rewrite
    // is the point rather than housekeeping. It used to read "there is one
    // palette … the colours stay dark, because `theme.css` declares no
    // `[data-theme='light']` block yet" — true when #550 shipped and false the
    // moment #551 merged. A gap that describes a gap which has since closed is
    // worse than no gap at all: it teaches a reader that the honest-gap voice
    // is out of date, and after that they stop reading any of them.
    //
    // So this asserts the *shape* of the surviving gap — the scene, which is
    // genuinely still dark — and not merely that some sentence is present.
    const gap = screen.getByTestId('pref-appearance.theme-gap').textContent ?? ''
    expect(gap).toContain('scene')
    expect(gap).toContain('#551')
    expect(gap).not.toContain('one palette')
  })
})

describe('motion (ruling 5 — a health control, never below the system request)', () => {
  it('applies and persists a choice of still', () => {
    const restore = mockSystem({})
    try {
      render(<SettingsPage />)
      choose('motion.level', 'still')

      expect(document.documentElement.dataset.motion).toBe('still')

      cleanup()
      document.documentElement.removeAttribute('data-motion')
      render(<SettingsPage />)
      expect(document.documentElement.dataset.motion).toBe('still')
    } finally {
      restore()
    }
  })

  it('never returns to full because the system said reduced — a stored still outlives the OS going the other way', () => {
    writePreference('motion.level', 'still')

    const restore = mockSystem({ reduced: false })
    try {
      render(<SettingsPage />)
      expect(document.documentElement.dataset.motion).toBe('still')
    } finally {
      restore()
    }
  })

  it('takes the system request as a floor when the person asked for nothing in particular', () => {
    const restore = mockSystem({ reduced: true })
    try {
      render(<SettingsPage />)
      expect(document.documentElement.dataset.motion).toBe('reduced')
    } finally {
      restore()
    }
  })
})

describe('ruling 4 — a changed setting looks changed, and can be put back', () => {
  it('marks the control modified and offers the way back, per scope', () => {
    render(<SettingsPage />)

    expect(screen.queryByTestId('pref-appearance.theme-modified')).toBeNull()
    expect((screen.getByTestId('restore-appearance-machine') as HTMLButtonElement).disabled).toBe(true)

    choose('appearance.density', 'compact')

    expect(screen.getByTestId('pref-appearance.density-modified')).toBeInTheDocument()
    const restoreMachine = screen.getByTestId('restore-appearance-machine') as HTMLButtonElement
    expect(restoreMachine.disabled).toBe(false)

    act(() => {
      fireEvent.click(restoreMachine)
    })

    expect(screen.queryByTestId('pref-appearance.density-modified')).toBeNull()
    expect(readPreference('appearance.density')).toBe('comfortable')
    expect(document.documentElement.dataset.density).toBe('comfortable')
  })

  it('restores one scope without touching the other scope in the same group', () => {
    adoptRepoScope('/repos/a')
    writePreference('appearance.panelsCollapsed', { fleet: true })
    render(<SettingsPage repoPath="/repos/a" />)
    choose('appearance.theme', 'dark')

    act(() => {
      fireEvent.click(screen.getByTestId('restore-appearance-machine'))
    })

    expect(readPreference('appearance.theme')).toBe('system')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })
    // The repo-scoped restore is a separate button, and it is the one that
    // reaches the panels.
    act(() => {
      fireEvent.click(screen.getByTestId('restore-appearance-repo'))
    })
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({})
  })

  it('shows what a preference whose control lives elsewhere is currently set to, in words', () => {
    render(<SettingsPage />)

    // `true`/`false` says nothing with the panel nowhere on screen.
    act(() => writePreference('appearance.panelsCollapsed', { fleet: true }))
    const state = screen.getByTestId('pref-appearance.panelsCollapsed-state').textContent ?? ''
    expect(state).toContain('fleet collapsed')
    expect(screen.getByTestId('pref-appearance.hideFinished-state').textContent).toContain('visible')
    // The dock's tab is the third elsewhere-owned key (#552) — its state names
    // the tab in the person's own words, not a stored id.
    expect(screen.getByTestId('pref-appearance.dockTab-state').textContent).toContain('Spend')
  })
})

describe('S1 error state — a setting that failed to persist says so, and keeps the value', () => {
  it('keeps the chosen value in memory and names what happened, rather than snapping back in silence', () => {
    render(<SettingsPage />)
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

    try {
      choose('appearance.density', 'compact')

      // The control shows what the person chose…
      expect((screen.getByTestId('pref-appearance.density-compact') as HTMLInputElement).checked).toBe(true)
      // …and says plainly that it will not be there after a reload.
      expect(screen.getByTestId('pref-appearance.density-error').textContent).toContain('refused to store')
    } finally {
      setItem.mockRestore()
    }

    // …which is the truth: nothing was stored.
    expect(readPreference('appearance.density')).toBe('comfortable')
  })
})

describe('ruling 3 — the page adopts the repo the fold names', () => {
  it('buckets repo-scoped preferences under the repo it was given', () => {
    render(<SettingsPage repoPath="/repos/a" />)

    act(() => {
      writePreference('appearance.panelsCollapsed', { fleet: true })
    })

    expect(JSON.parse(localStorage.getItem('rhizomorph.prefs.repo.v1') ?? '{}')).toEqual({
      '/repos/a': { 'appearance.panelsCollapsed': { fleet: true } },
    })
  })

  it('names the repo it is configuring, and says so honestly when it has none', () => {
    render(<SettingsPage repoPath="/repos/a" />)
    expect(screen.getByTestId('settings-watched-repo').textContent).toContain('/repos/a')

    cleanup()
    render(<SettingsPage />)
    expect(screen.getByTestId('settings-watched-repo').textContent).toContain('unavailable')
  })
})

describe('a hosted group, once a shell announces itself (#574)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HOST_GLOBAL]
  })

  function withShell(): void {
    ;(globalThis as Record<string, unknown>)[HOST_GLOBAL] = {
      name: 'the desktop shell',
      capabilities: ['shell', 'tray', 'notify', 'launchAtLogin', 'updates'],
    }
  }

  it('turns a flag on, says what that MEANS, and puts it back', () => {
    withShell()
    render(<SettingsPage />)

    const toggle = screen.getByTestId('pref-notifications.landed-toggle') as HTMLInputElement
    expect(toggle.type).toBe('checkbox')
    expect(toggle.checked).toBe(false)

    act(() => {
      fireEvent.click(toggle)
    })

    expect(readPreference('notifications.landed')).toBe(true)
    expect(screen.getByTestId('pref-notifications.landed-modified')).toBeInTheDocument()
    // `true` says nothing with the tray nowhere on screen — the entry's own two
    // words are what a person reads.
    expect((screen.getByTestId('pref-notifications.landed-toggle') as HTMLInputElement).checked).toBe(true)
    expect(document.querySelector('[data-pref="notifications.landed"]')?.textContent).toContain('interrupts you')

    act(() => {
      fireEvent.click(screen.getByTestId('restore-notifications-machine'))
    })
    expect(readPreference('notifications.landed')).toBe(false)
  })

  it('keeps the chosen value and says so when a flag fails to persist', () => {
    withShell()
    render(<SettingsPage />)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    try {
      act(() => {
        fireEvent.click(screen.getByTestId('pref-application.launchAtLogin-toggle'))
      })

      expect((screen.getByTestId('pref-application.launchAtLogin-toggle') as HTMLInputElement).checked).toBe(true)
      expect(screen.getByTestId('pref-application.launchAtLogin-error').textContent).toContain('refused to store')
    } finally {
      setItem.mockRestore()
    }

    expect(readPreference('application.launchAtLogin')).toBe(false)
  })

  it('offers nothing to act with in a browser, and refuses the write beneath it too', () => {
    render(<SettingsPage />)
    const toggle = screen.getByTestId('pref-notifications.landed-toggle') as HTMLInputElement

    // Disabled at the control…
    expect(toggle.disabled).toBe(true)
    // …and refused underneath it, which is the half that holds when the caller
    // is code rather than a person. (A click is not the probe here: jsdom
    // dispatches one at a disabled input where a browser would not, so a test
    // built on it would be asserting jsdom's behaviour, not the page's.)
    expect(() => writePreference('notifications.landed', true)).toThrow(/unavailable/)
    expect(readPreference('notifications.landed')).toBe(false)
  })
})

describe('the telemetry group — the env block, reused rather than restated', () => {
  it('shows the command for this instance with the warning /connect gives it', () => {
    render(<TelemetryBlock location={{ port: '4317', protocol: 'http:' }} />)

    const command = screen.getByTestId('settings-telemetry-command').textContent ?? ''
    expect(command).toContain('rhizomorph env')
    expect(command).toContain('--port 4317')
    // No lane is guessed: a handle invented here would hand a person a command
    // that instruments a lane which does not exist.
    expect(command).toContain('<lane>')

    expect(screen.getByTestId('settings-telemetry-warning').textContent).toBe(SAME_PROCESS_WARNING)
    expect(screen.getByTestId('settings-telemetry-apply').textContent).toContain('eval')
  })

  it('copies exactly what it showed, and says so when the clipboard refuses', async () => {
    const copied: string[] = []
    render(
      <TelemetryBlock
        location={{ port: '', protocol: 'https:' }}
        onCopy={async (text) => {
          copied.push(text)
        }}
      />,
    )

    // `location.port` is empty on the default port for the scheme — the honest
    // fallback, never a guess.
    expect(screen.getByTestId('settings-telemetry-command').textContent).toContain('--port 443')

    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-telemetry-copy'))
    })
    expect(copied).toEqual([screen.getByTestId('settings-telemetry-command').textContent])
    expect(screen.getByTestId('settings-telemetry-copied').textContent).toContain('copied')

    cleanup()
    render(
      <TelemetryBlock location={{ port: '5173', protocol: 'http:' }} onCopy={() => Promise.reject(new Error('no'))} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-telemetry-copy'))
    })
    // The command stays on screen either way — a person who cannot use the
    // clipboard still has it in front of them.
    expect(screen.getByTestId('settings-telemetry-copied').textContent).toContain('copy it by hand')
    expect(screen.getByTestId('settings-telemetry-command').textContent).toContain('rhizomorph env')
  })

  it('makes no claim that any of it worked — that is /connect, and it links there', () => {
    render(<SettingsPage />)

    expect(screen.getByTestId('settings-group-telemetry').getAttribute('data-unavailable')).toBeNull()
    expect((screen.getByTestId('settings-telemetry-connect') as HTMLAnchorElement).getAttribute('href')).toBe(
      '/connect',
    )
  })
})

describe('the keyboard path is the browser\'s own', () => {
  it('renders every choice as a real, focusable radio inside a labelled group', () => {
    render(<SettingsPage />)

    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBeGreaterThan(0)

    const theme = screen.getByTestId('pref-appearance.theme-dark') as HTMLInputElement
    expect(theme.tagName).toBe('INPUT')
    expect(theme.type).toBe('radio')
    theme.focus()
    expect(document.activeElement).toBe(theme)
  })
})
