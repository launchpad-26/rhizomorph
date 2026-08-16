/**
 * WHAT THE HOST PROVIDES (prd-35 S1's *unavailable* state, wave 2; #574).
 *
 * **The decision this module is.** prd-35's Notifications and Application
 * groups ride prd-34's desktop shell (#564, in flight in another lane). There
 * were two honest ways to sequence that:
 *
 * 1. Declare both groups disabled with a reason naming #564, and let the shell
 *    lane come back and edit `registry.ts` to turn them on.
 * 2. Declare the keys and their controls now, wired to a capability the HOST
 *    announces — so the shell enables them by *existing*, and never enters
 *    `packages/web/src/settings/` at all.
 *
 * **This is (2), and the reason is that (1) is a fence widening waiting to
 * happen.** #564's own proposed fence already reads "the app package only, plus
 * the corresponding controls in `packages/web/src/settings/`" — two lanes in one
 * directory, on a dependency that only ever points one way. Under (2) the shell
 * lane's fence is the app package, full stop: it injects a descriptor, and eight
 * controls that already exist, already persist and already say why they are
 * disabled become live. Nothing here changes when it lands.
 *
 * **What the shell announces, and what it does not.** The descriptor is a
 * capability list, not a settings store. prd-34's open question — "where the
 * shell's own settings live (run-on-login, update cadence) — tray menu or a
 * settings page" — is answered here in the only way prd-35 ruling 1 permits: a
 * control that changes something lives in settings and appears exactly once, so
 * the VALUE lives in the registry with every other preference (which is also
 * what `coverage-law.test.tsx` requires of anything persisted at all), and the
 * shell reads it back through the registry's own `readFlag`/`readChoice` and
 * hears about changes through `subscribeToPreferences`. Which of those two the
 * shell uses, and how it carries the answer to its main process, is prd-34's
 * call and #564's to make — it needs nothing from this file to make it.
 *
 * **Why a global and not a `<meta>` tag.** `recordings/capability.ts` reads its
 * token off the served page, because the server mints it and templates it in.
 * The shell does not template the page — it spawns the same server and points a
 * window at it — so announcing itself in the HTML would mean a flag through
 * `packages/server` to reach a fact the window already knows. An injected
 * global is the seam that costs the shell one preload and this file one read.
 *
 * **A host that will not say what it is gets nothing.** The descriptor is
 * validated rather than trusted: a non-empty name, and at least one capability
 * this file knows. An unparseable descriptor reads as no host, which fails
 * closed — the groups stay disabled with their reason, which is the state that
 * tells the truth when the truth is unknown.
 */

/**
 * The things a host may provide that the browser cannot. Each one clears
 * exactly one group or control's stated reason for being disabled — see
 * `registry.ts`'s `requires` field.
 *
 * They are separate rather than a single `desktop` flag because they genuinely
 * arrive separately: prd-34's own risk section names the Linux tray as the
 * shaky one, so a shell that has notifications and updates but no working tray
 * is a real host, and the two tray controls should say so on their own rather
 * than take the whole Application group down with them.
 */
export type HostCapability = 'shell' | 'tray' | 'notify' | 'launchAtLogin' | 'updates'

/** The capabilities as data, so "these five and no others" is checkable. */
export const HOST_CAPABILITIES = ['shell', 'tray', 'notify', 'launchAtLogin', 'updates'] as const satisfies
  readonly HostCapability[]

/**
 * The global the host announces itself under. Deliberately undotted: the
 * coverage law sweeps the whole package for `rhizomorph.*` string literals and
 * allows them in `registry.ts` alone, and a host descriptor is not a storage
 * key — it should not have to be exempted from a law about storage.
 */
export const HOST_GLOBAL = 'rhizomorphHost'

export interface HostDescriptor {
  /** What this host is, in words a person reads on the page — "the desktop shell". */
  readonly name: string
  readonly capabilities: readonly HostCapability[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The host this page is running in, or `null` for a browser tab.
 *
 * `scope` is a parameter so the tests can install and remove a host without
 * touching the real global — and so a future non-window host (an embedded view)
 * has somewhere to be read from other than `globalThis`.
 */
export function readHost(scope: object = globalThis): HostDescriptor | null {
  const raw = (scope as Record<string, unknown>)[HOST_GLOBAL]
  if (!isRecord(raw)) return null

  const name = raw.name
  if (typeof name !== 'string' || name.length === 0) return null

  const declared = Array.isArray(raw.capabilities) ? raw.capabilities : []
  const capabilities = HOST_CAPABILITIES.filter((capability) => declared.includes(capability))
  if (capabilities.length === 0) return null

  return { name, capabilities }
}

/** Whether the current host provides `capability`. `false` in a browser, always. */
export function hostProvides(capability: HostCapability, scope: object = globalThis): boolean {
  return readHost(scope)?.capabilities.includes(capability) === true
}

/**
 * What is hosting this page, for the line the Application group shows. A person
 * looking at a disabled group deserves to know which side of the answer they
 * are on, and "a browser" is the answer far more often than it is the fault.
 */
export function hostName(scope: object = globalThis): string {
  return readHost(scope)?.name ?? 'a browser'
}
