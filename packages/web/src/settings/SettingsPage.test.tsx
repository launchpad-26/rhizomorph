import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptRepoScope, readPreference, readRecordOverlay, writePreference } from './registry.js'
import { SettingsPage } from './SettingsPage.js'

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

  it('says out loud that the light palette does not exist yet, rather than implying it drew one', () => {
    render(<SettingsPage />)
    // Law 12's voice: WHAT is missing, WHY it matters, what fixes it.
    const gap = screen.getByTestId('pref-appearance.theme-gap').textContent ?? ''
    expect(gap).toContain('one palette')
    expect(gap).toContain('#551')
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
    const state = screen.getByTestId('pref-appearance.panelsCollapsed-state').textContent ?? ''
    expect(state).toContain('feed collapsed')
    expect(state).toContain('collisions expanded')
    expect(screen.getByTestId('pref-appearance.hideFinished-state').textContent).toContain('visible')
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
