import type { HostPreferences } from './prefs.js'

/**
 * WHAT THE PAGE MAY ASK THE SHELL (#564) — the seam between this package and
 * `packages/web/src/settings/`, declared here so neither side has to guess.
 *
 * ## Why a contract module and not an import
 *
 * prd-34 ruling 8 puts the notification toggles in settings, and prd-35's
 * Application and Notifications groups are where a person meets them. But
 * `packages/web` cannot import this package (it would be a build-time
 * dependency on a desktop shell for an app that also runs in a browser), and
 * this package must not enter `packages/web/src/settings/` — it is another
 * lane's ground, and the shell growing a private fork of a surface is exactly
 * what ruling 4 forbids.
 *
 * So the shell **exposes** and settings **reads**, and this file is the written
 * form of that: the global's name, the channel names, and the shape. The
 * precedent is the same one `wizard.tsx` follows for the harness registry — a
 * second statement of a fact, with a law holding it to the first.
 * `bridge-law.test.ts` reads `main/preload.ts` and fails if the preload
 * exposes anything this file does not declare, or omits anything it does.
 *
 * ## How a surface uses it
 *
 * ```ts
 * const host = (window as { rhizomorphHost?: HostBridge }).rhizomorphHost
 * if (host === undefined) return null   // a browser tab: these controls do not exist here
 * const preferences = await host.getPreferences()
 * ```
 *
 * The absence is the feature. A browser tab has no tray, no login item and no
 * updater, and a settings page that rendered those controls anyway would be
 * offering four switches that do nothing — which is the shape of dishonesty
 * this repo's honest-gap voices exist to prevent. `capabilities` says which of
 * them this build can actually honour, so the answer is per-platform rather
 * than per-guess.
 */

/** The global the preload defines. Namespaced, because a page's globals are shared with everything else on it. */
export const BRIDGE_GLOBAL = 'rhizomorphHost'

/** The IPC channels, all of them, named in one place. */
export const BRIDGE_CHANNELS = {
  describe: 'rhizomorph:host:describe',
  getPreferences: 'rhizomorph:host:get-preferences',
  setPreference: 'rhizomorph:host:set-preference',
} as const

/**
 * What a desktop build can do that a browser tab cannot. Reported rather than
 * assumed: `launch-on-login` is unavailable on a Linux build with no autostart
 * directory, and `updates` is unavailable until an update feed exists (ruling 9
 * defers signing, so today it is not).
 */
export type HostCapability = 'notifications' | 'tray-badge' | 'launch-on-login' | 'updates'

export const HOST_CAPABILITIES: readonly HostCapability[] = [
  'notifications',
  'tray-badge',
  'launch-on-login',
  'updates',
]

export interface HostDescription {
  /** The app's version — the shell's, which is the repo's. */
  version: string
  /** `darwin` / `win32` / `linux`. A settings surface says what the OS will call the login item. */
  platform: string
  /** Only the capabilities this build can honour. A capability absent here must not render a control. */
  capabilities: HostCapability[]
}

export interface SetPreferenceResult {
  preferences: HostPreferences
  /** Null when it was accepted. A sentence when it was not — settings shows it rather than reverting silently. */
  refused: string | null
}

/** The whole surface a page may reach. Nothing here mutates the instrument; these are the shell's own settings. */
export interface HostBridge {
  describe(): Promise<HostDescription>
  getPreferences(): Promise<HostPreferences>
  setPreference(id: string, value: unknown): Promise<SetPreferenceResult>
}
