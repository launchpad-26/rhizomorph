import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SAME_PROCESS_WARNING } from '../connect/links.js'
import { HOST_GLOBAL, type HostCapability } from './host.js'
import { groupUnavailabilityOf, PREFERENCES, SETTINGS_GROUPS, unavailabilityOf } from './registry.js'
import { SettingsPage } from './SettingsPage.js'

/**
 * THE COVERAGE LAW (prd-35 S1's first acceptance criterion, #550).
 *
 * **A preference cannot be persisted and forgotten.** Two claims, held here
 * rather than hoped for:
 *
 * 1. Every key the registry declares is accounted for on the settings page,
 *    exactly once — as a control, or (for the two keys whose one control is
 *    direct manipulation elsewhere) as its state and its default, or (for the
 *    one settings-owned record the page cannot draw a control for yet,
 *    `lab.models`) as its default and its declared gap. The sets are compared
 *    exactly, not "at least": a key with no row fails, and so does a row for a
 *    key nobody declared.
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

afterEach(() => {
  cleanup()
  withoutHost()
})

/**
 * Put a host on the real global for one test — the seam prd-34's shell uses
 * (`host.ts`), exercised here because the coverage law's claims have to hold on
 * BOTH sides of it. A page hosted by a shell renders more controls, not
 * different ones.
 */
function withHost(name: string, capabilities: readonly HostCapability[]): void {
  ;(globalThis as Record<string, unknown>)[HOST_GLOBAL] = { name, capabilities }
}

function withoutHost(): void {
  delete (globalThis as Record<string, unknown>)[HOST_GLOBAL]
}

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

  it('gives a control to what settings owns (a record it cannot draw yet says so instead), and no second copy of what it does not', () => {
    render(<SettingsPage />)

    for (const entry of PREFERENCES) {
      const row = document.querySelector(`[data-pref="${entry.id}"]`)
      expect(row, `${entry.id} has no row`).not.toBeNull()
      const inputs = row?.querySelectorAll('input, select, textarea, button') ?? []

      if (entry.control === 'settings' && entry.kind === 'record') {
        // The page has no control for a map of flags: `SettingsPage.tsx` draws
        // a flag as a checkbox and everything else as a radio group over
        // `options`, and a record has none — so `lab.models` (prd-55 ruling 5,
        // wave 1) reaches the page with its default and its gap and NO input.
        // This branch is the record of that gap, not its acceptance: the row
        // has to say so in the honest-gap voice rather than stand as an empty
        // fieldset in silence, and the day the page grows a record control the
        // zero below goes red and this branch is rewritten in that diff — never
        // deleted from this one.
        expect(inputs.length, `${entry.id} grew a control this law has not read`).toBe(0)
        expect(entry.gap, `${entry.id} offers nothing and does not say so`).not.toBeNull()
        continue
      }
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
      const reason = groupUnavailabilityOf(group)
      if (reason === null) {
        expect(section.getAttribute('data-unavailable')).toBeNull()
        continue
      }
      // Never hidden, never absent — disabled WITH ITS REASON.
      expect(section.getAttribute('data-unavailable')).toBe('true')
      expect(screen.getByTestId(`settings-group-${group.id}-reason`).textContent).toContain(reason)
    }
  })

  /**
   * The reason has to be ON SCREEN beside the control, not in a particular
   * paragraph. A group states its blocker once and its rows are then merely
   * disabled (`unavailabilityOf`'s group-first ordering), so this asserts over
   * the section a person is actually looking at — which holds for a row whose
   * reason is its own and for a row whose reason is the group's, and would fail
   * for a disabled control whose reason went nowhere.
   */
  it('states the reason for every control that cannot act, and the gap for every one half-wired', () => {
    render(<SettingsPage />)

    for (const entry of PREFERENCES) {
      const reason = unavailabilityOf(entry)
      if (reason !== null) {
        expect(screen.getByTestId(`settings-group-${entry.group}`).textContent, `${entry.id}`).toContain(reason)
        // …and it really is disabled, not merely explained.
        const inputs = document.querySelectorAll(`[data-pref="${entry.id}"] input`)
        for (const input of inputs) expect((input as HTMLInputElement).disabled).toBe(true)
      }
      if (entry.gap !== null) {
        expect(screen.getByTestId(`pref-${entry.id}-gap`).textContent).toContain(entry.gap)
      }
    }
  })
})

/**
 * THE HOST SEAM (#574). prd-35's Notifications and Application groups ride
 * prd-34's shell, and this repo has to hold one of two shapes: either the shell
 * lane edits `registry.ts` later, or the controls exist now and the shell turns
 * them on by announcing itself. It is the second, so these are the tests that
 * make the second one real — without them the claim "the shell needs no edit
 * here" is a comment in a doc block.
 */
describe('a group riding the host turns on by the host existing, not by an edit here', () => {
  const HOSTED = ['notifications.needsHuman', 'application.launchAtLogin', 'application.updateChannel'] as const

  it('leaves them disabled with their reason in a browser', () => {
    render(<SettingsPage />)

    for (const id of ['notifications', 'application'] as const) {
      expect(screen.getByTestId(`settings-group-${id}`).getAttribute('data-unavailable')).toBe('true')
      expect(screen.getByTestId(`settings-group-${id}-reason`).textContent).toContain('not yet')
    }
    expect(screen.getByTestId('settings-host').textContent).toContain('a browser')

    for (const id of HOSTED) {
      for (const input of document.querySelectorAll(`[data-pref="${id}"] input`)) {
        expect((input as HTMLInputElement).disabled).toBe(true)
      }
    }
  })

  it('renders them for real once a shell announces the capabilities they name', () => {
    withHost('the desktop shell', ['shell', 'tray', 'notify', 'launchAtLogin', 'updates'])
    render(<SettingsPage />)

    for (const id of ['notifications', 'application'] as const) {
      expect(screen.getByTestId(`settings-group-${id}`).getAttribute('data-unavailable')).toBeNull()
      expect(screen.queryByTestId(`settings-group-${id}-reason`)).toBeNull()
    }
    expect(screen.getByTestId('settings-host').textContent).toContain('the desktop shell')

    for (const id of HOSTED) {
      const inputs = [...document.querySelectorAll(`[data-pref="${id}"] input`)]
      expect(inputs.length, `${id} renders no control`).toBeGreaterThan(0)
      for (const input of inputs) expect((input as HTMLInputElement).disabled, id).toBe(false)
    }
  })

  it('keeps a control whose own capability is missing disabled, with its own reason, inside a live group', () => {
    // prd-34's risk register names the Linux tray as the shaky one, so a shell
    // with no tray is a real host — and the two tray controls say so on their
    // own rather than taking the group down with them.
    withHost('the desktop shell', ['shell', 'launchAtLogin', 'updates'])
    render(<SettingsPage />)

    expect(screen.getByTestId('settings-group-application').getAttribute('data-unavailable')).toBeNull()
    for (const id of ['application.closeToTray', 'application.trayBadge'] as const) {
      expect(screen.getByTestId(`pref-${id}-unavailable`).textContent).toContain('no tray')
      expect((document.querySelector(`[data-pref="${id}"] input`) as HTMLInputElement).disabled).toBe(true)
    }
    // …while the two the shell did claim are live in the same group.
    expect((document.querySelector('[data-pref="application.launchAtLogin"] input') as HTMLInputElement).disabled).toBe(
      false,
    )
  })

  it('says the same thing once, not once per row — a group reason is not repeated onto its controls', () => {
    render(<SettingsPage />)

    // The whole Application group is blocked by one missing shell. Eight copies
    // of that sentence is how a person learns to skip the `not yet` colour, and
    // the row that DOES carry its own reason is then the one they skip.
    for (const entry of PREFERENCES.filter((candidate) => candidate.group === 'application')) {
      expect(screen.queryByTestId(`pref-${entry.id}-unavailable`), entry.id).toBeNull()
    }
    expect(screen.getAllByTestId('settings-group-application-reason')).toHaveLength(1)
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

/**
 * RULING 1's OTHER HALF (#574). The Telemetry group shows the same env block
 * and the same warning `/connect` shows. "Reuse the existing copy, never
 * reimplement it" is the issue's own condition, and it is not a style
 * preference: {@link SAME_PROCESS_WARNING} is a verbatim record of a real
 * incident (`.workmux.yaml`, 2026-08-04), and the failure mode of a second
 * surface stating it in its own words is that one of the two ends up stating
 * the old version. Same posture, and the same shape, as
 * `recordings/capability-guidance.test.ts`'s own one-file check.
 */
describe('the copy this page shows is imported, never restated', () => {
  it('leaves the same-process warning written out in exactly one source file', () => {
    const writers = sourceFiles()
      .filter((file) => file.text.includes(SAME_PROCESS_WARNING))
      .map((file) => file.name)

    expect(writers).toEqual([path.join('connect', 'links.ts')])
  })

  it('has the settings surface import the warning and the command it explains', () => {
    const block = sourceFiles().find((file) => file.name === path.join('settings', 'TelemetryBlock.tsx'))
    expect(block, 'the telemetry block is not where this law thinks it is').toBeDefined()

    const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/connect\/links\.js'/.exec(block?.text ?? '')
    expect(imported, 'the telemetry block imports nothing from the surface it reuses').not.toBeNull()
    for (const name of ['SAME_PROCESS_WARNING', 'envCommand', 'envApplyNote']) {
      expect(imported?.[1]).toContain(name)
    }
  })

  it('the detector bites — a restatement in a second file would be caught', () => {
    // The sweep is over a sentence, so a paraphrase slips past it. That is the
    // honest limit of this check: it catches the copy-paste, and the import
    // check above is what makes the copy-paste the only way to have the
    // sentence at all.
    expect(SAME_PROCESS_WARNING.length).toBeGreaterThan(20)

    const restated = { name: path.join('settings', 'Restated.tsx'), text: `const w = '${SAME_PROCESS_WARNING}'` }
    const writers = [...sourceFiles(), restated]
      .filter((file) => file.text.includes(SAME_PROCESS_WARNING))
      .map((file) => file.name)

    expect(writers).toEqual([path.join('connect', 'links.ts'), restated.name])
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
