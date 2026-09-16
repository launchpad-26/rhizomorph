import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultDataRoot } from './paths.js'

/**
 * THE INSTALLATION ID — prd-57 ruling 7.
 *
 * ## Why a second identity, when the instrument already has one
 *
 * The OTLP inbox keys on `ctx.recorder.sessionId` today (`api/otel.ts`). That
 * id is minted when a session starts, persisted with it, and carried across a
 * restart by a resumed run — exactly the lifetime a *lane's env block* needs,
 * because the block is pasted per launch and a launch belongs to a session.
 *
 * prd-57 ruling 4 writes telemetry configuration into a harness's USER-LEVEL
 * file, once, for every future session in every repo. That configuration has no
 * session at all. Keyed on a session id it would be correct until the next
 * fresh boot and then silently wrong — the instrument would refuse its own
 * agents' telemetry and book it as a foreign export, which is the invisible
 * failure prd-19 exists to end.
 *
 * So: one id, minted once into the data root, stable across every boot, resume,
 * rotation and repo. **The recorder's session id is unchanged and remains the
 * record's identity** — this is a second key for a second lifetime, not a
 * replacement for the first.
 *
 * ## Why it must not look like a session id
 *
 * A recorder session id is a numeric epoch: `api/meta.ts` computes `startedAt`
 * by `Number()`-ing it. Two ids that both parse as numbers, travelling the same
 * attribution paths, are two ids a call site can silently swap. This one is a
 * UUID behind an `rzi_` prefix, so a swap is visible to a reader and a parse
 * failure to anything that tries to read it as a clock.
 *
 * The prefix is deliberately not `rzk_`, which ADR-0050 fixes as the shape of a
 * machine KEY. An installation id is not a credential: it is written into a
 * configuration file in the clear, it authorises nothing, and ADR-0019 clause 5
 * — this hand holds no secret — stays true precisely because of that
 * distinction.
 */

/** Under the data root, not under a repo slug: the point is that it outlives any one repo. */
export const INSTALLATION_ID_FILE = 'installation-id'

const ID_PATTERN = /^rzi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface InstallationIdOptions {
  /** Overridable so a test needs no real home directory. */
  readonly dataRoot?: string
  /** Injectable so the mint is deterministic under test. */
  readonly mint?: () => string
}

/**
 * What the read found. A caller can tell "already here" from "replaced because
 * it was unusable" — the second is worth reporting and the first never is.
 */
export type InstallationIdOutcome =
  | { readonly id: string; readonly minted: false }
  | { readonly id: string; readonly minted: true; readonly replaced: string | null }

export function isInstallationId(candidate: string): boolean {
  return ID_PATTERN.test(candidate)
}

export function installationIdPath(dataRoot: string = defaultDataRoot()): string {
  return path.join(dataRoot, INSTALLATION_ID_FILE)
}

/**
 * Mint-once, enforced by the filesystem rather than by a module-level cache.
 *
 * A cache would make this idempotent within one process and useless across two,
 * which is the case that actually matters: the CLI mints, the server reads, and
 * they are different processes. So every call reads the file, and the only
 * write is a create.
 *
 * **Two processes racing the very first call settle on one id.** The create
 * uses the `wx` flag — fail if the path exists — which is the atomic
 * create-if-absent primitive; the loser catches `EEXIST`, re-reads, and returns
 * the winner's id rather than the one it just minted. Without that re-read each
 * process would return its own, and an enlist written by one would be refused
 * by the other. A temp file plus `rename` would NOT do this: `rename` replaces
 * the target on both POSIX and Windows, so both writers would "succeed" and the
 * second would clobber a live id.
 *
 * Replacing an unusable stored value is a deliberate overwrite and takes the
 * ordinary write path, because `wx` would just fail against the corrupt file
 * forever. Two processes replacing the same corrupt value can still race; both
 * write a valid id, the last wins, and every read after that is consistent.
 */
export function readOrMintInstallationId(options: InstallationIdOptions = {}): InstallationIdOutcome {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const mint = options.mint ?? (() => `rzi_${randomUUID()}`)
  const file = installationIdPath(dataRoot)

  const stored = readStored(file)
  if (stored !== null && isInstallationId(stored)) return { id: stored, minted: false }

  mkdirSync(dataRoot, { recursive: true })
  const candidate = mint()
  if (!isInstallationId(candidate)) {
    throw new Error(`minted an installation id that is not one: ${candidate}`)
  }

  if (stored === null) {
    try {
      writeFileSync(file, `${candidate}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch {
      const winner = readStored(file)
      if (winner !== null && isInstallationId(winner)) return { id: winner, minted: false }
      throw new Error(`could not mint or read an installation id at ${file}`)
    }
    return { id: candidate, minted: true, replaced: null }
  }

  writeFileSync(file, `${candidate}\n`, 'utf8')
  return { id: candidate, minted: true, replaced: stored }
}

function readStored(file: string): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text.length === 0 ? '' : text
  } catch {
    return null
  }
}
