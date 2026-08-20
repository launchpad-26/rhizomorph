import type { LoginItemPlan } from './login-item.js'

/**
 * WHAT THE PAGE IS TOLD THIS HOST IS — the seam between the shell and
 * `packages/web/src/settings/host.ts`, and the fix for the two halves never
 * meeting.
 *
 * ## The defect this exists to end
 *
 * `settings/host.ts` reads one global, `rhizomorphHost`, and validates it as a
 * DESCRIPTOR: `{ name: string, capabilities: [...] }`. If `name` is not a
 * non-empty string, or no capability survives its filter, `readHost` returns
 * null — and null means "a browser", so prd-35's Notifications and Application
 * groups stay disabled with a reason that says they need the desktop app.
 *
 * The preload exposed that same global as three async FUNCTIONS. So inside the
 * desktop app, `readHost()` found no `name`, returned null, and every
 * desktop-only control rendered disabled, telling a person to go and get the
 * thing they were already running. On first launch — the one path prd-34 exists
 * to make good — that is what a stranger would have found in Settings.
 *
 * It was worse than a shape mismatch. The two packages had independently
 * invented two vocabularies for the same list:
 *
 * | side | names |
 * | --- | --- |
 * | `settings/host.ts` (web) | `shell`, `tray`, `notify`, `launchAtLogin`, `updates` |
 * | `bridge-contract.ts` (app) | `notifications`, `tray-badge`, `launch-on-login`, `updates` |
 *
 * Only `updates` overlapped, so even a correctly-shaped descriptor would have
 * cleared exactly one control. Neither lane's tests could see it: each proved
 * its own half against its own declaration, and nothing stood at the join.
 *
 * ## Which vocabulary wins, and why
 *
 * The web one. It is the CONSUMER — `registry.ts` entries name these strings in
 * their `requires` field, and each one is the condition that clears a stated
 * reason. Renaming them would mean editing every entry that depends on them to
 * match a producer, which is backwards. The app keeps its own names for its own
 * internal logic (`bridge-contract.ts` is unchanged) and translates here, at
 * the boundary, where the translation is visible and tested.
 *
 * `capability-law.test.ts` holds this file's copy of the vocabulary against
 * `settings/host.ts`'s own, so the two cannot drift apart again silently — the
 * same "two statements of one fact, with a law between them" this repo uses for
 * the window ground and prd-32's floor.
 */

/**
 * The web surface's capability names, mirrored. Held to
 * `packages/web/src/settings/host.ts` by `capability-law.test.ts`.
 *
 * Not imported: `packages/web` is a browser package and this is a Node one;
 * a build-time dependency from the shell to the SPA is exactly what prd-34
 * ruling 1 ("the server and SPA ship unmodified") rules out.
 */
export type PageCapability = 'shell' | 'tray' | 'notify' | 'launchAtLogin' | 'updates'

export const PAGE_CAPABILITIES: readonly PageCapability[] = ['shell', 'tray', 'notify', 'launchAtLogin', 'updates']

/** The global `settings/host.ts` reads. Mirrored from its `HOST_GLOBAL`, and held to it by the law. */
export const PAGE_HOST_GLOBAL = 'rhizomorphHost'

/**
 * What a person reads on the settings page — it renders `running in: {name}`.
 * `settings/host.ts`'s own doc gives "the desktop shell" as the example, and a
 * browser reads as "a browser", so this is the other side of that sentence.
 */
export const HOST_NAME = 'the desktop shell'

export interface PageHostDescriptor {
  name: string
  capabilities: PageCapability[]
}

export interface DescriptorFacts {
  /** The login-item plan for this build — its `supported` decides `launchAtLogin`. */
  loginItem: Pick<LoginItemPlan, 'supported'>
  /** Whether an update feed exists. Ruling 9 defers signing, so today this is false. */
  updatesAvailable: boolean
  /** Whether a tray was actually created. Linux tray support is a stated risk in prd-34, so it is reported rather than assumed. */
  trayPresent: boolean
}

/**
 * The descriptor for this build.
 *
 * `shell` and `notify` are unconditional: this process IS the shell, and
 * Electron's Notification API is available on every platform it supports. The
 * other three are facts about the running build, and each one gates exactly one
 * group of controls — so a build that cannot do a thing does not offer a switch
 * for it, which is the whole reason `settings/host.ts` validates rather than
 * trusts.
 */
export function pageHostDescriptor(facts: DescriptorFacts): PageHostDescriptor {
  const capabilities: PageCapability[] = ['shell', 'notify']
  if (facts.trayPresent) capabilities.push('tray')
  if (facts.loginItem.supported) capabilities.push('launchAtLogin')
  if (facts.updatesAvailable) capabilities.push('updates')
  // Declaration order, so the page sees a stable list rather than one that
  // depends on which conditions happened to be true.
  return { name: HOST_NAME, capabilities: PAGE_CAPABILITIES.filter((c) => capabilities.includes(c)) }
}

/**
 * Whether a descriptor would survive `settings/host.ts`'s own validation.
 *
 * Restated here so the app can test its output against the consumer's rules
 * without importing the consumer: a non-empty name, and at least one capability
 * the page knows. A descriptor that fails this reads as "a browser", which is
 * precisely the bug — so it is worth asserting rather than assuming.
 */
export function survivesPageValidation(descriptor: PageHostDescriptor): boolean {
  if (typeof descriptor.name !== 'string' || descriptor.name.length === 0) return false
  return descriptor.capabilities.some((capability) => PAGE_CAPABILITIES.includes(capability))
}
