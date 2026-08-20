import { contextBridge, ipcRenderer } from 'electron'

/**
 * THE PRELOAD (#564) — the only thing the page can see of the shell, and it is
 * deliberately tiny.
 *
 * A preload runs with the page and with Node's privileges, which makes it the
 * single most dangerous file in an Electron app: anything exposed here is
 * reachable by every script the page runs. So the exposure is a fixed record of
 * three async calls carrying plain data, plus two inert fields, built through
 * `contextBridge` (never assigned onto `window` directly, which would hand the
 * page a live reference across the isolation boundary).
 *
 * **No `ipcRenderer` escapes.** The page cannot send an arbitrary channel,
 * cannot listen on one, and cannot reach `require`. The calls it gets are the
 * shell's own preferences — not the instrument's data, which the page already
 * has over HTTP with its own capability token (ADR-0012).
 *
 * ## Why `name` and `capabilities` sit beside the three functions
 *
 * Because `packages/web/src/settings/host.ts` reads this exact global and
 * validates it as a DESCRIPTOR — `{ name, capabilities }` — synchronously. It
 * used to find three functions, no `name`, and therefore concluded it was
 * running in a browser: inside the desktop app, every desktop-only control
 * rendered disabled and told the person to go and get the thing they were
 * already running.
 *
 * The two shapes are one object now. The functions are the shell's private
 * bridge; the two fields are the public announcement the settings page reads.
 * `host-descriptor.ts` explains which capability vocabulary is used and why the
 * web one wins, and `capability-law.test.ts` holds it to that file's own list.
 *
 * The literals below are spelled out rather than imported from the contract
 * because a preload is bundled separately and must stay standalone; the law is
 * what keeps the duplication honest.
 */

/**
 * Read synchronously, on purpose — see `BRIDGE_CHANNELS.descriptor`. The page's
 * registry asks `hostProvides()` while it is being built, so an awaited
 * descriptor would paint every desktop-only control disabled and then flip it.
 *
 * A failure here reads as "a browser" rather than crashing the preload: a page
 * with its desktop groups disabled is a degraded app, and a page with a broken
 * preload is no app at all.
 */
function announcement(): { name: string; capabilities: string[] } | null {
  try {
    const value: unknown = ipcRenderer.sendSync('rhizomorph:host:descriptor')
    if (value === null || typeof value !== 'object') return null
    const record = value as { name?: unknown; capabilities?: unknown }
    if (typeof record.name !== 'string' || record.name.length === 0) return null
    if (!Array.isArray(record.capabilities)) return null
    return {
      name: record.name,
      capabilities: (record.capabilities as unknown[]).filter((c): c is string => typeof c === 'string'),
    }
  } catch {
    return null
  }
}

const announced = announcement()

contextBridge.exposeInMainWorld('rhizomorphHost', {
  // The announcement `settings/host.ts` reads. Spread rather than always
  // present: if the main process could not describe itself these are absent,
  // and the page correctly decides it is a browser instead of being handed a
  // half-truth it would have to validate around.
  ...(announced === null ? {} : { name: announced.name, capabilities: announced.capabilities }),
  describe: () => ipcRenderer.invoke('rhizomorph:host:describe'),
  getPreferences: () => ipcRenderer.invoke('rhizomorph:host:get-preferences'),
  setPreference: (id: string, value: unknown) => ipcRenderer.invoke('rhizomorph:host:set-preference', id, value),
})
