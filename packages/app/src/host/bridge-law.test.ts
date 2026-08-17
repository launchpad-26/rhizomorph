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

  it.each(Object.entries(BRIDGE_CHANNELS))('invokes the declared %s channel', (_name, channel) => {
    expect(preload).toContain(`ipcRenderer.invoke('${channel}'`)
  })

  it('is answered on every channel it invokes — an unanswered `invoke` never resolves', () => {
    const registered = [...entry.matchAll(/ipcMain\.handle\(BRIDGE_CHANNELS\.(\w+)/g)].map((match) => match[1])
    expect(registered.sort()).toEqual(Object.keys(BRIDGE_CHANNELS).sort())
  })

  it('invokes NOTHING the contract does not declare', () => {
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
    const declared = Object.values(BRIDGE_CHANNELS)
    expect(invoked.sort()).toEqual([...declared].sort())
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
    // The entry filters the list; this is the branch that keeps a settings
    // surface from rendering an update control that cannot do anything.
    expect(entry).toContain("if (capability === 'updates') return updates.phase !== 'unavailable'")
  })
})
