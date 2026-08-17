import { describe, expect, it } from 'vitest'
import { badgeFor, unreachableBadge } from './badge.js'
import { DEFAULT_PREFERENCES } from './prefs.js'
import type { ServerPhase } from './supervisor.js'
import { actionableIds, trayMenu, type TrayMenuInput } from './tray-menu.js'
import { unavailableUpdates } from './update-gate.js'

function menuFor(overrides: Partial<TrayMenuInput> = {}) {
  const input: TrayMenuInput = {
    badge: badgeFor('calm'),
    serverPhase: 'running',
    preferences: DEFAULT_PREFERENCES,
    updates: unavailableUpdates(),
    ...overrides,
  }
  return trayMenu(input)
}

describe('what S2 says the menu offers', () => {
  it('offers open, settings, demo mode and quit', () => {
    const ids = actionableIds(menuFor())
    expect(ids).toContain('open')
    expect(ids).toContain('settings')
    expect(ids).toContain('demo-fleet')
    expect(ids).toContain('quit')
  })

  it('leads with the badge\'s own reading, in words', () => {
    const menu = menuFor({ badge: badgeFor('needs-you') })
    expect(menu[0]?.label).toContain('NEEDS YOU')
    // A header is a reading, not a button.
    expect(menu[0]?.enabled).toBe(false)
  })
})

describe('quitting is explicit, and always available (ruling 2)', () => {
  const phases: ServerPhase[] = ['starting', 'running', 'failed', 'stopped']

  it.each(phases)('offers an enabled Quit while the server is %s', (serverPhase) => {
    expect(actionableIds(menuFor({ serverPhase }))).toContain('quit')
  })

  it('offers Quit even with no reading at all', () => {
    expect(actionableIds(menuFor({ badge: unreachableBadge('the stream closed'), serverPhase: 'failed' }))).toContain(
      'quit',
    )
  })

  it('always offers a way back to the window, however badly the server is doing', () => {
    for (const serverPhase of phases) {
      expect(actionableIds(menuFor({ serverPhase }))).toContain('open')
    }
  })
})

describe('what a dead server takes away, and what it does not', () => {
  it('withholds settings and demo mode — both live in the SPA the server serves', () => {
    const ids = actionableIds(menuFor({ serverPhase: 'failed' }))
    expect(ids).not.toContain('settings')
    expect(ids).not.toContain('demo-fleet')
  })

  it('still shows them, disabled, rather than hiding them', () => {
    // A vanished menu item reads as a feature that does not exist; a disabled
    // one reads as a feature that is not available right now.
    const labels = menuFor({ serverPhase: 'failed' }).map((item) => item.label)
    expect(labels).toContain('Settings…')
    expect(labels).toContain('Demonstration fleet')
  })
})

describe('demo mode is an act, never a setting (ruling 6, prd-35 ruling 2)', () => {
  it('carries no checkbox and no checked state', () => {
    const demo = menuFor().find((item) => item.id === 'demo')
    expect(demo?.kind).toBe('submenu')
    for (const item of demo?.items ?? []) {
      expect(item.kind).toBe('normal')
      expect(item.checked).toBeUndefined()
    }
  })

  it('offers both fixtures and the way back to live', () => {
    const ids = actionableIds(menuFor())
    expect(ids).toContain('demo-fleet')
    expect(ids).toContain('demo-pathology')
    expect(ids).toContain('demo-live')
  })
})

describe('the toggles read the preferences they name', () => {
  it('checks launch-on-login only when it is on', () => {
    expect(menuFor().find((item) => item.id === 'launch-on-login')?.checked).toBe(false)
    expect(
      menuFor({ preferences: { ...DEFAULT_PREFERENCES, 'application.launchOnLogin': true } }).find(
        (item) => item.id === 'launch-on-login',
      )?.checked,
    ).toBe(true)
  })

  it('checks close-to-tray from its own key, not from the one above it', () => {
    const menu = menuFor({
      preferences: { ...DEFAULT_PREFERENCES, 'application.launchOnLogin': true, 'application.closeToTray': false },
    })
    expect(menu.find((item) => item.id === 'close-to-tray')?.checked).toBe(false)
    expect(menu.find((item) => item.id === 'launch-on-login')?.checked).toBe(true)
  })
})

describe('the update line', () => {
  it('is a reading, not a button, while there is nothing to apply', () => {
    expect(actionableIds(menuFor())).not.toContain('update')
    expect(menuFor().find((item) => item.id === 'update')?.label).toContain('unavailable')
  })

  it('becomes pressable exactly when an update is downloaded and waiting', () => {
    const ids = actionableIds(
      menuFor({ updates: { phase: 'ready', version: '0.2.0', detail: null, unsigned: true } }),
    )
    expect(ids).toContain('update')
  })
})

describe('actionable ids', () => {
  it('counts submenu children and not their parent — a submenu opens, it does not act', () => {
    expect(actionableIds(menuFor())).not.toContain('demo')
  })

  it('counts no separator, and no disabled item', () => {
    const ids = actionableIds(menuFor({ serverPhase: 'failed' }))
    expect(ids.some((id) => id.startsWith('separator'))).toBe(false)
    expect(ids).not.toContain('header')
  })
})
