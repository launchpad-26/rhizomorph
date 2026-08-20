import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, BRIDGE_GLOBAL, HOST_CAPABILITIES } from './bridge-contract.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const PRELOAD = path.join(REPO_ROOT, 'packages', 'app', 'src', 'main', 'preload.ts')
const ENTRY = path.join(REPO_ROOT, 'packages', 'app', 'src', 'main', 'entry.ts')

const preload = readFileSync(PRELOAD, 'utf8')
const entry = readFileSync(ENTRY, 'utf8')

/**
 * The CODE, with comments stripped. The preload's own doc explains what it
 * deliberately does not expose — `require`, `ipcRenderer` — and a law that read
 * the prose would fail on the sentence promising the thing it checks for.
 */
const preloadCode = preload.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * THE BRIDGE LAW. The preload is bundled separately and spells its channel
 * names as literals (it cannot import the contract), and the main process
 * answers them from the contract's constants. A law is the only thing that
 * keeps the two spellings the same — and the failure it prevents is silent on
 * both sides: settings calls a method that never resolves, and nothing logs.
 */
describe('the preload exposes exactly what the contract declares (#564)', () => {
  it('found the preload to read', () => {
    expect(preload).toContain('contextBridge.exposeInMainWorld')
  })

  it('exposes it under the declared global', () => {
    expect(preload).toContain(`exposeInMainWorld('${BRIDGE_GLOBAL}'`)
  })

  /**
   * `descriptor` is the one synchronous channel, so it is `sendSync`/`ipcMain.on`
   * rather than `invoke`/`ipcMain.handle`. The distinction is encoded here rather
   * than the law being loosened to "some kind of IPC": which of the two a channel
   * uses is a real property — `settings/host.ts` reads the host descriptor while
   * it builds the registry and cannot await, and every other call is awaited and
   * must not block. Getting that backwards is exactly the kind of thing this law
   * is for.
   */
  const SYNCHRONOUS: readonly string[] = ['descriptor']
  const asyncChannels = Object.entries(BRIDGE_CHANNELS).filter(([name]) => !SYNCHRONOUS.includes(name))
  const syncChannels = Object.entries(BRIDGE_CHANNELS).filter(([name]) => SYNCHRONOUS.includes(name))

  it.each(asyncChannels)('invokes the declared %s channel', (_name, channel) => {
    expect(preload).toContain(`ipcRenderer.invoke('${channel}'`)
  })

  it.each(syncChannels)('reads the declared %s channel synchronously', (_name, channel) => {
    expect(preload).toContain(`ipcRenderer.sendSync('${channel}')`)
  })

  it('is answered on every channel it invokes — an unanswered `invoke` never resolves', () => {
    const handled = [...entry.matchAll(/ipcMain\.handle\(BRIDGE_CHANNELS\.(\w+)/g)].map((match) => match[1])
    expect(handled.sort()).toEqual(asyncChannels.map(([name]) => name).sort())
  })

  it('answers the synchronous channel too, and with `on` — an unanswered `sendSync` hangs the renderer', () => {
    // Worse than an unresolved promise: `sendSync` blocks the renderer's main
    // thread, so a missing handler is a white window rather than a dead control.
    const listened = [...entry.matchAll(/ipcMain\.on\(BRIDGE_CHANNELS\.(\w+)/g)].map((match) => match[1])
    expect(listened.sort()).toEqual(syncChannels.map(([name]) => name).sort())
  })

  it('reaches for NOTHING the contract does not declare', () => {
    const used = [
      ...[...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]),
      ...[...preload.matchAll(/ipcRenderer\.sendSync\('([^']+)'/g)].map((match) => match[1]),
    ]
    expect(used.sort()).toEqual([...Object.values(BRIDGE_CHANNELS)].sort())
  })
})

describe('the preload hands the page nothing else', () => {
  it('exposes no `ipcRenderer`, no `require`, no event listener', () => {
    // Everything a page could use to reach past its three calls. Each of these
    // has been a real Electron CVE in somebody's app.
    expect(preloadCode).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/)
    expect(preloadCode).not.toContain('ipcRenderer.on(')
    expect(preloadCode).not.toContain('ipcRenderer.send(')
    expect(preloadCode).not.toMatch(/\brequire\b/)
    expect(preloadCode).not.toContain('window.')
    // The stripper is doing its job rather than emptying the file.
    expect(preloadCode).toContain('contextBridge.exposeInMainWorld')
  })

  it('is one exposure, not several', () => {
    expect([...preload.matchAll(/exposeInMainWorld/g)]).toHaveLength(1)
  })
})

describe('the window opens on the closed posture', () => {
  it('keeps Node out of the renderer, isolates the context and keeps the sandbox on', () => {
    expect(entry).toContain('nodeIntegration: false')
    expect(entry).toContain('contextIsolation: true')
    expect(entry).toContain('sandbox: true')
    expect(entry).toContain('webSecurity: true')
  })

  it('sends a link to anywhere else to the OS rather than opening a browser of its own', () => {
    expect(entry).toContain('setWindowOpenHandler')
    expect(entry).toContain("action: 'deny'")
  })
})

describe('capabilities are reported, not assumed', () => {
  it('declares the four a desktop build can have', () => {
    expect([...HOST_CAPABILITIES].sort()).toEqual(['launch-on-login', 'notifications', 'tray-badge', 'updates'])
  })

  it('withholds `updates` while there is no feed — ruling 9 defers signing', () => {
    // The entry filters the list, and this is what keeps a settings surface
    // from rendering an update control that cannot do anything.
    //
    // Asserted against the value passed to the filter rather than an inline
    // `if`, because the filter moved: it used to be two hand-written branches
    // here, one of which asked `app.isPackaged` and therefore let a packaged
    // LINUX build advertise `launch-on-login` that `setLoginItemSettings`
    // silently ignores. It is `honestCapabilities` now, fed from the same plan
    // that does the applying — see `login-item.ts`.
    expect(entry).toContain('honestCapabilities(HOST_CAPABILITIES')
    expect(entry).toContain("updatesAvailable: updates.phase !== 'unavailable'")
  })

  it('decides launch-on-login from the plan that applies it, not from isPackaged alone', () => {
    // The defect this pins: `capability === 'launch-on-login' ? app.isPackaged`
    // is true on a packaged .deb, where the API is a documented no-op. If that
    // shortcut ever comes back, the switch starts saving and lying again.
    expect(entry).toContain('loginItem: currentLoginItemPlan()')
    expect(entry).not.toContain("if (capability === 'launch-on-login') return app.isPackaged")
  })
})
