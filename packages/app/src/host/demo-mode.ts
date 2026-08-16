/**
 * DEMO MODE, REACHED THE WAY THE PAGE ALREADY OFFERS IT (#564's tray entry;
 * prd-34 rulings 5 and 6).
 *
 * The SPA has switched its driving log on `1`/`2`/`3` since prd-19
 * (`app/StreamContext.tsx`'s `useFixtureKeys`), and #411 put the keys on screen
 * beside the sample-fleet button so they are documented rather than secret. The
 * tray therefore **presses the key**: `main/entry.ts` sends a synthetic keydown
 * to the window and the page does what it does when a person presses it.
 *
 * That is a deliberate choice over the two alternatives, and the reason is
 * ruling 6's one hard rule — *a screenshot of demo mode must never be
 * mistakable for telemetry*:
 *
 * - **A new IPC channel into the page** would need `packages/web` to listen for
 *   it, which is another lane's ground and a shell-shaped hole in a surface
 *   that has none today.
 * - **The shell driving the fixture itself** — folding the fixture log in the
 *   main process and rendering it — is the forked surface ruling 4 forbids, and
 *   it would arrive *without* `SampleFleetControl`'s banner and the provenance
 *   bar, which is precisely a screenshot that could pass for telemetry.
 *
 * Pressing the key gets the fixture **and its chrome together**, because they
 * are the same code path a person already uses. The shell has no way to switch
 * a fixture on without the banner that says so, which is the strongest form the
 * rule can take: not a promise, an absence of any mechanism to break it.
 *
 * `demo-mode.test.ts` holds this map against `STREAM_SOURCE_KEYS` in
 * `packages/web/src/app/StreamContext.tsx` — a second statement of a fact, with
 * a law keeping it true, the same shape `wizard.tsx` uses for the harness
 * registry.
 */

/** The three logs the page can be driven by. `live` is the way back, and it is on the menu for that reason. */
export type DemoSource = 'live' | 'fleet20' | 'pathology'

/** The key each source answers to, in the page's own binding. */
export const STREAM_SOURCE_KEY: Record<DemoSource, string> = {
  live: '1',
  fleet20: '2',
  pathology: '3',
}

/** How each reads in a menu. Named, never ranked — and the simulated ones say so in their own labels. */
export const DEMO_LABEL: Record<DemoSource, string> = {
  live: 'Back to the live log',
  fleet20: 'Twenty lanes, working',
  pathology: 'Staged pathologies',
}

/**
 * ## Why the key is DISPATCHED rather than typed, and verified rather than assumed
 *
 * The first version sent a synthetic keypress with `webContents.sendInputEvent`
 * — and on a real packaged build it silently did nothing: the DevTools protocol
 * read the page back and it still said `live`, over an empty fleet, at the one
 * moment a stranger is looking. Two races, neither visible: input goes to a
 * *focused* window and the window is still being shown, and `useFixtureKeys`
 * attaches its listener in an effect that has not necessarily run when
 * `loadURL` resolves.
 *
 * So the shell dispatches the page's own event on the page's own `window`, and
 * then **reads the page back to check it took**, retrying a few times. Both
 * halves matter: dispatching is focus-independent and reaches exactly the
 * listener `useFixtureKeys` registered, and checking turns "the demonstration
 * fleet did not open" from an invisible failure into a line on stderr.
 *
 * This is still *pressing the page's key*. It defines no state, sets no source
 * and knows nothing about fixtures — the chrome comes with it, because the page
 * is what does the switching.
 */

/** The event the page is listening for, as the script that raises it. */
export function demoDispatchScript(source: DemoSource): string {
  return `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(
    STREAM_SOURCE_KEY[source],
  )}, bubbles: true }))`
}

/**
 * The word the page shows once a fixture is driving: every simulated spec's
 * `provenance` begins `synthetic ·` (core's `fleet/fixtures.ts`), and
 * `ConnectionBadge` renders that string verbatim in the top dock on every
 * route. `demo-mode.test.ts` holds this against core's own fixtures, so a
 * reworded provenance fails there rather than leaving this check quietly
 * passing on nothing.
 */
export const SIMULATED_MARK = 'synthetic'

/** Reads the page back: is a simulated log driving right now? */
export const DEMO_VERIFY_SCRIPT = `document.body.textContent.includes(${JSON.stringify(SIMULATED_MARK)})`

/** What {@link DEMO_VERIFY_SCRIPT} should answer once `source` is driving. */
export function expectSimulated(source: DemoSource): boolean {
  return source !== 'live'
}

/** How many times to dispatch before giving up and saying so. */
export const DEMO_ATTEMPTS = 8

/** How long to wait between attempts. Eight of these is two seconds — longer than a mount, shorter than a person's patience. */
export const DEMO_RETRY_MS = 250
