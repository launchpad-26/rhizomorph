import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS } from './bridge-contract.js'
import {
  HOST_NAME,
  PAGE_CAPABILITIES,
  PAGE_HOST_GLOBAL,
  pageHostDescriptor,
  survivesPageValidation,
} from './host-descriptor.js'
import { loginItemPlan } from './login-item.js'

/**
 * THE LAW THAT WAS MISSING.
 *
 * `bridge-law.test.ts` proves the preload matches `bridge-contract.ts`.
 * `packages/web/src/settings/host.test.ts` proves `readHost` validates what it
 * is given. Both passed while the desktop app told every one of its own users
 * that the desktop-only settings needed a desktop app — because nothing stood
 * at the join between them.
 *
 * The join has two halves and both were broken:
 *
 *  1. **Shape.** The page reads `rhizomorphHost` as `{ name, capabilities }`.
 *     The preload exposed three functions and no `name`, so `readHost` returned
 *     null, which means "a browser".
 *  2. **Vocabulary.** The two packages had independently named the same list —
 *     `shell/tray/notify/launchAtLogin/updates` on the page,
 *     `notifications/tray-badge/launch-on-login/updates` in the shell. Only
 *     `updates` overlapped, so even a correct shape would have cleared one
 *     control out of eight.
 *
 * This file reads the web source and fails if either half drifts again. It is
 * the same cross-package move `window-frame.test.ts` already makes for the
 * window's ground colour and prd-32's size prose — the app package reading the
 * web package's own text, so a mirror cannot go stale in silence.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const WEB_HOST = path.join(REPO_ROOT, 'packages', 'web', 'src', 'settings', 'host.ts')
const PRELOAD = path.join(HERE, '..', 'main', 'preload.ts')
const ENTRY = path.join(HERE, '..', 'main', 'entry.ts')

const webHost = readFileSync(WEB_HOST, 'utf8')
const preload = readFileSync(PRELOAD, 'utf8')
const entry = readFileSync(ENTRY, 'utf8')

const PACKAGED_MAC = {
  platform: 'darwin',
  openAtLogin: false,
  packaged: true,
  homeDir: '/Users/operator',
  execPath: '/Applications/rhizomorph.app/Contents/MacOS/rhizomorph',
  appName: 'rhizomorph',
} as const

describe('the shell announces itself in the vocabulary the page reads', () => {
  it('reads the web file it claims to mirror — a law over a moved file passes vacuously', () => {
    expect(webHost).toContain('export const HOST_GLOBAL')
    expect(webHost).toContain('export const HOST_CAPABILITIES')
  })

  it('mirrors the page\'s global exactly', () => {
    const match = /export const HOST_GLOBAL = '([^']+)'/.exec(webHost)
    expect(match?.[1]).toBe(PAGE_HOST_GLOBAL)
  })

  it('mirrors the page\'s capability vocabulary exactly — this is the half that was wrong', () => {
    // Parsed out of the web source rather than restated, so adding a capability
    // there and not here fails immediately.
    const block = /export const HOST_CAPABILITIES = \[([^\]]+)\]/.exec(webHost)?.[1] ?? ''
    const declared = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    expect([...PAGE_CAPABILITIES].sort()).toEqual([...declared].sort())
  })

  it('every capability the shell would announce is one the page knows', () => {
    const descriptor = pageHostDescriptor({
      loginItem: loginItemPlan(PACKAGED_MAC),
      updatesAvailable: true,
      trayPresent: true,
    })
    for (const capability of descriptor.capabilities) {
      expect(PAGE_CAPABILITIES).toContain(capability)
    }
  })
})

describe('what the shell announces would survive the page\'s own validation', () => {
  it('a packaged build with a tray passes, and clears the desktop-only groups', () => {
    const descriptor = pageHostDescriptor({
      loginItem: loginItemPlan(PACKAGED_MAC),
      updatesAvailable: false,
      trayPresent: true,
    })
    expect(survivesPageValidation(descriptor)).toBe(true)
    expect(descriptor.name).toBe(HOST_NAME)
    // The two that gate prd-35's Notifications and Application groups.
    expect(descriptor.capabilities).toContain('notify')
    expect(descriptor.capabilities).toContain('launchAtLogin')
  })

  it('withholds launchAtLogin when the build cannot honour it, rather than offering a dead switch', () => {
    const descriptor = pageHostDescriptor({
      loginItem: loginItemPlan({ ...PACKAGED_MAC, packaged: false }),
      updatesAvailable: false,
      trayPresent: true,
    })
    expect(descriptor.capabilities).not.toContain('launchAtLogin')
    // and is still a valid host: it is a shell, it can notify.
    expect(survivesPageValidation(descriptor)).toBe(true)
  })

  it('withholds updates while ruling 9 defers signing', () => {
    const descriptor = pageHostDescriptor({
      loginItem: loginItemPlan(PACKAGED_MAC),
      updatesAvailable: false,
      trayPresent: true,
    })
    expect(descriptor.capabilities).not.toContain('updates')
  })

  it('withholds tray when no tray was created — prd-34 names Linux tray support as a risk', () => {
    const descriptor = pageHostDescriptor({
      loginItem: loginItemPlan(PACKAGED_MAC),
      updatesAvailable: false,
      trayPresent: false,
    })
    expect(descriptor.capabilities).not.toContain('tray')
  })

  it('a name is always present and never empty — an empty one reads as a browser', () => {
    expect(HOST_NAME.length).toBeGreaterThan(0)
    expect(survivesPageValidation({ name: '', capabilities: ['shell'] })).toBe(false)
    expect(survivesPageValidation({ name: HOST_NAME, capabilities: [] })).toBe(false)
  })
})

describe('the preload actually exposes the announcement', () => {
  it('puts name and capabilities on the same global as the three functions', () => {
    expect(preload).toContain(`exposeInMainWorld('${PAGE_HOST_GLOBAL}'`)
    expect(preload).toContain('name: announced.name')
    expect(preload).toContain('capabilities: announced.capabilities')
  })

  it('reads the descriptor synchronously, because the page cannot await it', () => {
    expect(preload).toContain(`sendSync('${BRIDGE_CHANNELS.descriptor}')`)
  })

  it('the main process answers that channel', () => {
    expect(entry).toContain('ipcMain.on(BRIDGE_CHANNELS.descriptor')
    expect(entry).toContain('pageHostDescriptor(')
  })

  it('a failed descriptor read degrades to a browser rather than breaking the preload', () => {
    // The page losing its desktop groups is a degraded app; a preload that
    // throws is no app at all, because nothing else on the page loads either.
    expect(preload).toContain('catch')
    expect(preload).toContain('return null')
  })
})
