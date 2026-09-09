import { readFile, stat } from 'node:fs/promises'
import { ingestKeyPath } from './config.js'
import { writeAtomicFile } from './cursor.js'

/**
 * ONE CREDENTIAL, ONE SHAPE, ONE PLACE (ADR-0034 clause 2, prd-38 ruling 4).
 *
 * The `rzk_` ingest key is project-scoped, minted by the team and revocable by
 * the team. It lives in exactly one file at mode `0600` and is readable
 * through exactly one method, {@link IngestKey.headerValue}, called at exactly
 * one site in the codebase (`post.ts` — `hand-law.test.ts`'s clause 2b sweeps
 * for it).
 *
 * **Everything that renders a value renders the redaction.** `toString`,
 * `toJSON` and Node's custom-inspect hook all yield `rzk_[redacted]`, so a
 * template literal, a `JSON.stringify` of an options bag and a `console.log`
 * of the whole object each produce the same harmless string. The value cannot
 * arrive somewhere by accident; it has to be asked for by name.
 *
 * **{@link IngestKey.redact} is the other half, and it is the one that
 * matters.** A team server can echo the key back in a 500 body, and a `fetch`
 * rejection can carry it in an error message — neither of those is this
 * process's mistake, and laundering either one into a log line would be.
 * Every string this hand derives from a response or a thrown error goes
 * through `redact` before it becomes a `detail`, which is what
 * `no-key-in-output-law.test.ts` runs a failing server to prove.
 *
 * **No log call anywhere under `shipper/`.** Not a redacted one, not a
 * key-free one: `hand-law.test.ts`'s `logsAKey` is a substring sweep over a
 * call's whole argument span, so even `log.warn('no ingest key here')` would
 * redden it. The hand returns result values and `cli/connect-team.ts` prints
 * them.
 */

/** The one grant. ADR-0034 clause 2 says a second prefix under `shipper/` is a violation of the record, not an extension of it. */
export const INGEST_KEY_PREFIX = 'rzk_'

/** What every rendering of a key yields. Never a truncation of the real value — a prefix of a secret is still a piece of one. */
export const REDACTED_KEY = 'rzk_[redacted]'

/** Short enough to admit any plausible minting scheme, long enough that a typo or a shell variable that expanded to nothing is refused. */
export const MIN_INGEST_KEY_BODY = 16

/** POSIX mode the key file must carry. Pinned beside its writer, which is what the law's third declared skip asked wave 2 to do. */
export const INGEST_KEY_MODE = 0o600

const INSPECT_CUSTOM: unique symbol = Symbol.for('nodejs.util.inspect.custom')

export class IngestKey {
  readonly #value: string

  constructor(raw: string) {
    const value = raw.trim()
    if (!value.startsWith(INGEST_KEY_PREFIX)) {
      throw new Error(
        `that is not an ingest key: a team ingest key begins "${INGEST_KEY_PREFIX}" — ` +
          'copy the value your team server minted for this project',
      )
    }
    if (value.length - INGEST_KEY_PREFIX.length < MIN_INGEST_KEY_BODY) {
      throw new Error(
        `that ingest key is too short to be one (needs at least ${MIN_INGEST_KEY_BODY} characters after "${INGEST_KEY_PREFIX}") — ` +
          'check the value made it through the pipe intact',
      )
    }
    if (/\s/.test(value)) {
      throw new Error('that ingest key contains whitespace — pipe the value alone, with nothing around it')
    }
    this.#value = value
  }

  /** The real value, for the one header that carries it. The ONLY reader; `hand-law.test.ts` clause 2b holds that. */
  headerValue(): string {
    return this.#value
  }

  /**
   * Replace every occurrence of the value in text this process did not
   * author — a response body, a thrown error's message — with the redaction.
   * A plain `split`/`join`, never a `RegExp`: the value is opaque and could
   * contain a metacharacter.
   */
  redact(text: string): string {
    return text.split(this.#value).join(REDACTED_KEY)
  }

  toString(): string {
    return REDACTED_KEY
  }

  toJSON(): string {
    return REDACTED_KEY
  }

  [INSPECT_CUSTOM](): string {
    return REDACTED_KEY
  }
}

/**
 * The stored key, or `null` when there is none.
 *
 * `null` means the file is absent. A present file whose contents are not a key
 * throws — the same reasoning `readTeamConfig` gives: "no credential" is a
 * state with a remedy, and reading a corrupt one as absent would hide it
 * behind the wrong remedy.
 */
export async function readIngestKey(sessionDir: string): Promise<IngestKey | null> {
  const file = ingestKeyPath(sessionDir)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null
    throw new Error(`the shipper's credential at ${file} could not be read: ${describe(err)}`)
  }
  try {
    return new IngestKey(raw)
  } catch (err) {
    throw new Error(
      `the shipper's credential at ${file} is not usable: ${describe(err)} — ` +
        're-run `rhizomorph connect team <url> --project <id>` with a fresh value on stdin',
    )
  }
}

/** Validates and stores the key at {@link INGEST_KEY_MODE}, atomically. The value plus one trailing newline, and nothing else in the file. */
export async function writeIngestKey(sessionDir: string, raw: string): Promise<IngestKey> {
  const key = new IngestKey(raw)
  await writeAtomicFile(ingestKeyPath(sessionDir), `${key.headerValue()}\n`, INGEST_KEY_MODE, {
    what: 'credential',
  })
  return key
}

/**
 * The key file's POSIX permission bits, or `null` when there is no file — and
 * `null` on win32, where the bits are not meaningful and reporting `0666`
 * would read as a finding rather than as "this platform does not answer that
 * question".
 */
export async function ingestKeyMode(sessionDir: string): Promise<number | null> {
  if (process.platform === 'win32') return null
  try {
    const info = await stat(ingestKeyPath(sessionDir))
    return info.mode & 0o777
  } catch {
    return null
  }
}

/** `true` when the key file exists at all — the presence `doctor` reports, with no reading of the value. */
export async function ingestKeyPresent(sessionDir: string): Promise<boolean> {
  try {
    await stat(ingestKeyPath(sessionDir))
    return true
  } catch {
    return false
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
