/**
 * THE API VERSION — prd-58 ruling 8.
 *
 * > `/api/meta` gains `apiVersion`; the client compares on boot and refuses a
 * > mismatch by name in `/connect`'s voice, naming both versions and the
 * > remedy.
 *
 * **Why now, when one artefact shipped fine without it.** prd-57 made the CLI a
 * first-class surface and the Electron shell updates independently of the
 * server it talks to, so two independently-updating clients is the situation
 * rather than a hypothetical. A mismatch without a handshake does not fail — it
 * **half-works**, which is worse: a client reading a frame shape it does not
 * know drops fields silently and draws a fleet that is wrong rather than
 * absent.
 *
 * Wave 1 is the proof. `data` went from the event to `{ colony, event }`, and
 * the only reason a stale client still folds is that `parseStreamFrame` was
 * written to accept both. That leniency is a kindness this version number
 * exists to stop relying on.
 *
 * **One integer, bumped when a client that does not know about the change would
 * mis-read the wire.** Not a semver, not a date, not the package version: those
 * move for reasons a client does not care about, and a version that moves for
 * unrelated reasons trains everyone to ignore it.
 */
export const API_VERSION = 1

/**
 * What a client does about the version it was handed.
 *
 * - **`ok`** — the same number. Proceed.
 * - **`unknown`** — the server sent no version at all, which is every server
 *   built before ruling 8. Proceed, because refusing here would break every
 *   client against every server that predates the handshake, and the whole
 *   point of adding a version is to stop guessing rather than to start
 *   refusing retroactively. It is reported so a surface can say so.
 * - **`mismatch`** — two numbers that disagree. Refuse, by name.
 */
export type ApiVersionVerdict =
  | { kind: 'ok'; version: number }
  | { kind: 'unknown' }
  | { kind: 'mismatch'; client: number; server: number }

/**
 * Compare the version a client was built against with the one it was handed.
 *
 * Deliberately NOT "older or newer" — the verdict is the same either way. An
 * old client against a new server and a new client against an old server both
 * mis-read the wire, and a rule that only refused one direction would leave
 * exactly half the failures silent. What differs is the remedy, and
 * {@link apiVersionRefusal} is where that difference is spoken.
 */
export function compareApiVersion(served: unknown, client: number = API_VERSION): ApiVersionVerdict {
  if (typeof served !== 'number' || !Number.isInteger(served)) return { kind: 'unknown' }
  return served === client ? { kind: 'ok', version: served } : { kind: 'mismatch', client, server: served }
}

/**
 * The refusal, in `/connect`'s voice: **both versions and the remedy.**
 *
 * Success 8 is *"not met while a version mismatch produces anything other than
 * a `/connect`-voice refusal naming both versions and the remedy"*, so the two
 * numbers and an action are the criterion rather than the style. A message
 * saying only "version mismatch" would satisfy nobody at 3am: the operator
 * cannot tell which half is stale, and both halves are things they can update.
 */
export function apiVersionRefusal(verdict: Extract<ApiVersionVerdict, { kind: 'mismatch' }>): string {
  const { client, server } = verdict
  const stale = client < server ? 'this view' : 'the server'
  const remedy =
    client < server
      ? 'reload this page — the server was updated under it'
      : 'restart `rhizomorph` — it is older than this view expects'
  return (
    `This view speaks API v${client} and the server speaks v${server}, so ${stale} is behind. ` +
    `Nothing is shown rather than something wrong: a client reading a shape it does not know ` +
    `drops fields quietly. To fix it, ${remedy}.`
  )
}
