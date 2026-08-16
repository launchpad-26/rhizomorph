import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PREFERENCES, SETTINGS_GROUPS } from './registry.js'
import { SettingsPage } from './SettingsPage.js'

/**
 * THE COVERAGE LAW (prd-35 S1's first acceptance criterion, #550).
 *
 * **A preference cannot be persisted and forgotten.** Two claims, held here
 * rather than hoped for:
 *
 * 1. Every key the registry declares is accounted for on the settings page,
 *    exactly once — as a control, or (for the two keys whose one control is
 *    direct manipulation elsewhere) as its state and its default. The sets are
 *    compared exactly, not "at least": a key with no row fails, and so does a
 *    row for a key nobody declared.
 * 2. Nothing outside the registry persists anything at all. The whole web
 *    package is swept for `localStorage`/`sessionStorage` and for
 *    `rhizomorph.*` storage keys; `settings/registry.ts` is the only non-test
 *    file allowed to name either.
 *
 * Together those two are what make ruling 2's law (`non-negotiables.ts`)
 * enforceable rather than advisory: there is no path to a rendered toggle, or to
 * a persisted key, that does not pass through the enumeration the law audits.
 * That is the structural claim, and this file is where it is checked — the law
 * itself cannot see a control that was never declared.
 */

const SETTINGS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(SETTINGS_DIR, '..')
const REGISTRY = path.join(SETTINGS_DIR, 'registry.ts')

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(cleanup)

describe('every persisted preference is rendered by exactly one control', () => {
  it('renders every declared key, once, and nothing it did not declare', () => {
    render(<SettingsPage />)

    const rendered = [...document.querySelectorAll('[data-pref]')].map((node) =>
      node.getAttribute('data-pref'),
    )
    expect([...rendered].sort()).toEqual(PREFERENCES.map((entry) => entry.id).sort())
    // Exactly once each — a key rendered twice is two places to change it from,
    // which is the duplication ruling 1 forbids in its other direction.
    expect(new Set(rendered).size).toBe(rendered.length)
  })

  it('gives a control to what settings owns, and no second copy of what it does not', () => {
    render(<SettingsPage />)

    for (const entry of PREFERENCES) {
      const row = document.querySelector(`[data-pref="${entry.id}"]`)
      expect(row, `${entry.id} has no row`).not.toBeNull()
      const inputs = row?.querySelectorAll('input, select, textarea, button') ?? []

      if (entry.control === 'settings') {
        expect(inputs.length, `${entry.id} is settings' own control and offers nothing`).toBeGreaterThan(0)
        continue
      }
      // Ruling 1: its one control lives on another surface, so this page shows
      // the state and offers nothing that changes it.
      expect(inputs.length, `${entry.id} grew a second control here`).toBe(0)
      expect(screen.getByTestId(`pref-${entry.id}-state`).textContent).toContain(entry.control.surface)
    }
  })

  /**
   * Ruling 1's "exactly once" held across the whole app, not just across this
   * page. A key whose control lives elsewhere declares that control's own
   * `data-testid`; this proves the testId is rendered by exactly one non-test
   * source file, and that the file is not one of settings'. The registry itself
   * names the id (that is where the declaration is) and is excluded — a
   * declaration is not a second control.
   */
  it('leaves an elsewhere-owned control where it lives — one source renders it, and it is not this page', () => {
    const elsewhere = PREFERENCES.map((entry) => entry.control).filter(
      (control): control is Exclude<typeof control, 'settings'> => control !== 'settings',
    )
    const declared = elsewhere.filter((control) => control.testId !== null)
    expect(declared.length).toBeGreaterThan(0)

    for (const control of declared) {
      const owners = sourceFiles()
        .filter((file) => file.name !== path.relative(WEB_SRC, REGISTRY))
        .filter((file) => file.text.includes(control.testId as string))
        .map((file) => file.name)

      expect(owners, `${control.testId} is not rendered exactly once`).toHaveLength(1)
      expect(owners[0]?.startsWith('settings')).toBe(false)
    }
  })

  it('shows every control its default, and says which are modified (ruling 4)', () => {
    render(<SettingsPage />)

    for (const entry of PREFERENCES) {
      expect(screen.getByTestId(`pref-${entry.id}-default`).textContent).toMatch(/^default: \S/)
      expect(document.querySelector(`[data-pref="${entry.id}"]`)?.getAttribute('data-overridden')).toBe('false')
    }
  })

  it('renders all eight groups in S1 order, each disabled one carrying its reason', () => {
    render(<SettingsPage />)

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headings).toEqual(SETTINGS_GROUPS.map((group) => group.title))

    for (const group of SETTINGS_GROUPS) {
      const section = screen.getByTestId(`settings-group-${group.id}`)
      if (group.unavailable === null) {
        expect(section.getAttribute('data-unavailable')).toBeNull()
        continue
      }
      // Never hidden, never absent — disabled WITH ITS REASON.
      expect(section.getAttribute('data-unavailable')).toBe('true')
      expect(screen.getByTestId(`settings-group-${group.id}-reason`).textContent).toContain(group.unavailable)
    }
  })

  it('states the reason for every control that cannot act, and the gap for every one half-wired', () => {
    render(<SettingsPage />)

    for (const entry of PREFERENCES) {
      if (entry.unavailable !== null) {
        expect(screen.getByTestId(`pref-${entry.id}-unavailable`).textContent).toContain(entry.unavailable)
        // …and it really is disabled, not merely explained.
        for (const input of document.querySelectorAll(`[data-pref="${entry.id}"] input`)) {
          expect((input as HTMLInputElement).disabled).toBe(true)
        }
      }
      if (entry.gap !== null) {
        expect(screen.getByTestId(`pref-${entry.id}-gap`).textContent).toContain(entry.gap)
      }
    }
  })
})

describe('nothing outside the registry persists anything', () => {
  it('has the whole package to sweep, not one directory', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(80)
    expect(files.map((file) => file.name)).toContain(path.join('app', 'panelPrefs.ts'))
    expect(files.map((file) => file.name)).toContain(path.join('scene', 'SceneView.tsx'))
  })

  it('names a browser store in exactly one file — the registry', () => {
    const storing = sourceFiles()
      .filter((file) => /\blocalStorage\b|\bsessionStorage\b/.test(file.text))
      .map((file) => file.name)

    expect(storing).toEqual([path.relative(WEB_SRC, REGISTRY)])
  })

  it('names a `rhizomorph.*` storage key in exactly one file — the same one', () => {
    const keyed = sourceFiles()
      .filter((file) => /['"`]rhizomorph\.[A-Za-z0-9.]+['"`]/.test(file.text))
      .map((file) => file.name)

    expect(keyed).toEqual([path.relative(WEB_SRC, REGISTRY)])
  })

  it('the detectors bite — a store or a key added anywhere else would be caught', () => {
    expect(/\blocalStorage\b|\bsessionStorage\b/.test("localStorage.setItem('x', '1')")).toBe(true)
    expect(/\blocalStorage\b|\bsessionStorage\b/.test("sessionStorage.getItem('x')")).toBe(true)
    expect(/['"`]rhizomorph\.[A-Za-z0-9.]+['"`]/.test("const KEY = 'rhizomorph.myPref.v1'")).toBe(true)
    // …and do not fire on ordinary code, so the sweep is not vacuous.
    expect(/\blocalStorage\b|\bsessionStorage\b/.test('const store = new Map()')).toBe(false)
    // The capability meta name is not a storage key and must not be read as one.
    expect(/['"`]rhizomorph\.[A-Za-z0-9.]+['"`]/.test("const META = 'rhizomorph-capability'")).toBe(false)
  })
})

interface SourceFile {
  name: string
  text: string
}

/**
 * Comments come out before either sweep. Prose that NAMES a store is not a
 * store — `app/panelPrefs.ts`'s header explains at length which two keys it
 * used to own and where they went, and a law that read the explanation as a
 * violation would push the next person to delete the explanation rather than
 * the behaviour. Same reasoning, and the same shape, as `theme/tokens.ts`'s own
 * `stripComments`. Whole-line `//` comments only, so a `://` inside a string
 * cannot swallow the rest of a real line of code.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        visit(full)
        continue
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      out.push({ name: path.relative(WEB_SRC, full), text: stripComments(readFileSync(full, 'utf8')) })
    }
  }
  visit(WEB_SRC)
  return out
}
