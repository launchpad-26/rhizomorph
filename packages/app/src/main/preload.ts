import { contextBridge, ipcRenderer } from 'electron'

/**
 * THE PRELOAD (#564) — the only thing the page can see of the shell, and it is
 * three functions long on purpose.
 *
 * A preload runs with the page and with Node's privileges, which makes it the
 * single most dangerous file in an Electron app: anything exposed here is
 * reachable by every script the page runs. So the exposure is a fixed record of
 * three async calls that carry plain data, built through `contextBridge` (never
 * assigned onto `window` directly, which would hand the page a live reference
 * across the isolation boundary).
 *
 * **No `ipcRenderer` escapes.** The page cannot send an arbitrary channel,
 * cannot listen on one, and cannot reach `require`. The three calls it gets are
 * the shell's own preferences — not the instrument's data, which the page
 * already has over HTTP with its own capability token (ADR-0012).
 *
 * The names and shapes are declared in `../host/bridge-contract.ts`, and
 * `bridge-law.test.ts` reads this file to prove the two agree — a preload that
 * quietly grew a fourth channel is exactly the drift that law exists for.
 * The literals below are spelled out rather than imported from the contract
 * because a preload is bundled separately and must stay standalone; the law is
 * what keeps the duplication honest.
 */

contextBridge.exposeInMainWorld('rhizomorphHost', {
  describe: () => ipcRenderer.invoke('rhizomorph:host:describe'),
  getPreferences: () => ipcRenderer.invoke('rhizomorph:host:get-preferences'),
  setPreference: (id: string, value: unknown) => ipcRenderer.invoke('rhizomorph:host:set-preference', id, value),
})
