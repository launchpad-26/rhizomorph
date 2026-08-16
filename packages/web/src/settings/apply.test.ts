import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPreferences, readSystemPreferences, resolveTheme } from './apply.js'
import { writePreference } from './registry.js'

/**
 * The resolvers, on their own. Ruling 5's floor has a law of its own
 * (`non-negotiables-law.test.ts`, over every option the control offers); what is
 * left here is the theme's three-way resolution and the two ways the
 * environment can refuse to answer.
 */

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
  document.documentElement.removeAttribute('data-motion')
})

describe('resolveTheme', () => {
  it('takes the person over the system, in both directions', () => {
    expect(resolveTheme('dark', { prefersLight: true, prefersReducedMotion: false })).toBe('dark')
    expect(resolveTheme('light', { prefersLight: false, prefersReducedMotion: false })).toBe('light')
  })

  it('follows the system when asked to, and defaults to following it', () => {
    expect(resolveTheme('system', { prefersLight: true, prefersReducedMotion: false })).toBe('light')
    expect(resolveTheme('system', { prefersLight: false, prefersReducedMotion: false })).toBe('dark')
    // An unrecognised stored value is not a third theme — it follows the system,
    // which is the declared default.
    expect(resolveTheme('sepia', { prefersLight: true, prefersReducedMotion: false })).toBe('light')
  })
})

describe('readSystemPreferences', () => {
  it('answers "the system asked for nothing" where there is no matchMedia at all', () => {
    // A test tree, a non-browser host, an embed with the API removed: the honest
    // answer is that nothing was requested, not a throw that takes the surface
    // down with it.
    expect(readSystemPreferences({} as unknown as Window)).toEqual({
      prefersLight: false,
      prefersReducedMotion: false,
    })
  })

  it('reads both queries when there is one', () => {
    const view = {
      matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
    } as unknown as Window

    expect(readSystemPreferences(view)).toEqual({ prefersLight: false, prefersReducedMotion: true })
  })
})

describe('applyPreferences', () => {
  it('writes all three attributes, and only those three', () => {
    writePreference('appearance.theme', 'dark')
    writePreference('appearance.density', 'compact')
    writePreference('motion.level', 'reduced')

    const root = document.createElement('div')
    applyPreferences(root, { prefersLight: true, prefersReducedMotion: false })

    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-motion')).toBe('reduced')
    expect(root.attributes.length).toBe(3)
  })

  it('is idempotent — applying twice says the same thing', () => {
    const root = document.createElement('div')
    const system = { prefersLight: false, prefersReducedMotion: false }

    applyPreferences(root, system)
    const first = root.outerHTML
    applyPreferences(root, system)

    expect(root.outerHTML).toBe(first)
  })
})
