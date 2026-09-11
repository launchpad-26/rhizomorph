import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writeAtomicJson } from './cursor.js'

/**
 * WHERE THE HAND KEEPS ITS THREE FILES, AND WHAT "ENABLED" MEANS ON DISK
 * (ADR-0034 clause 2, prd-51 rulings 2 and 7).
 *
 * ```
 * <dataRoot>/<repoSlug>/shipper/team.json      0644  the enable record
 * <dataRoot>/<repoSlug>/shipper/ingest.key     0600  the credential, and nothing else
 * <dataRoot>/<repoSlug>/shipper/cursor.json    0644  ruling 7's one cursor file
 * ```
 *
 * Flat, beside the session logs, one directory deeper than them — `shipper/`
 * adds nine characters to the per-repo path, well inside ruling 7's
 * 251-character Windows budget.
 *
 * **Absent `team.json` is the off state, and off is the only state in which
 * nothing can leave.** There is no flag, no environment variable and no field
 * elsewhere that can turn the hand on: ADR-0001 refuses a flag precisely
 * because it makes a power a configuration detail. The enable record carries
 * the destination and the project and no credential — the credential is a
 * separate file at a separate mode, so a `cat` of the enable record can never
 * be the leak.
 *
 * A present-but-unparseable `team.json` throws by name rather than reading as
 * "off": silently treating a corrupt enable record as disabled would mean the
 * hand stops shipping and says nothing, which is the one failure a person
 * running `--ship` cannot see.
 */

export const TEAM_CONFIG_VERSION = 1

/** The enable record. No key, no cursor — those are their own files at their own modes. */
export interface TeamConfig {
  version: 1
  /** The single team-server base URL this repo ships to. Validated at write. */
  url: string
  /** The team server's project id. Never `repoSlug`: a slug carries a hash of a local absolute path and means nothing to a server. */
  project: string
  enabledAt: number
}

export const teamConfigSchema = z.object({
  version: z.literal(TEAM_CONFIG_VERSION),
  url: z.string().min(1),
  project: z.string().min(1),
  enabledAt: z.number().int().nonnegative(),
})

export function shipperDirFor(sessionDir: string): string {
  return path.join(sessionDir, 'shipper')
}

export function teamConfigPath(sessionDir: string): string {
  return path.join(shipperDirFor(sessionDir), 'team.json')
}

export function ingestKeyPath(sessionDir: string): string {
  return path.join(shipperDirFor(sessionDir), 'ingest.key')
}

export function cursorPath(sessionDir: string): string {
  return path.join(shipperDirFor(sessionDir), 'cursor.json')
}

/**
 * Loopback spellings a `http:` destination may use.
 *
 * This is NOT a second copy of `server/mutation-guard.ts`'s `LOOPBACK_HOSTNAMES`,
 * which answers a different question — whether an INBOUND request's `Host`
 * header is same-origin. This one answers whether an OUTBOUND destination the
 * operator typed is their own machine, which is the only case in which
 * plaintext is acceptable. Sharing one set would couple an outbound
 * convenience to an inbound security decision, and the coupling registry
 * already records what it costs to move that file.
 */
const LOOPBACK_URL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The destination must be `https:`, or `http:` to a loopback host so a team
 * server can be developed against. Anything else is refused by name at write
 * time rather than at post time: a hand that accepts `http://team.example`
 * and then fails on every tick has already told the operator it was enabled.
 */
export function assertShippableUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return failUrl(raw, 'it is not a URL')
  }
  if (url.protocol === 'https:') return assertBaseIsOnlyADestination(raw, url)
  if (url.protocol === 'http:' && LOOPBACK_URL_HOSTS.has(url.hostname)) return assertBaseIsOnlyADestination(raw, url)
  if (url.protocol === 'http:') {
    return failUrl(raw, 'plain http is only accepted for a loopback host (127.0.0.1, localhost, ::1)')
  }
  return failUrl(raw, `"${url.protocol}" is not a scheme this hand speaks`)
}

/**
 * A BASE IS AN ORIGIN AND AN OPTIONAL PATH PREFIX. NOTHING ELSE.
 *
 * A prefix is accepted and kept — a team server behind a proxy mounted on a
 * path is an ordinary deployment, and `post.ts`'s `ingestUrlFor` preserves it.
 * The three parts refused here are refused because accepting them is worse
 * than saying no, and each has its own reason.
 *
 * **Userinfo is the one that matters, and it is a leak.** The enable record is
 * `0644` on purpose: this docblock's own promise a few lines up is that a `cat`
 * of it can never be the leak, because the hand's one credential lives in a
 * separate `0600` file. A base spelled `https://user:pw@team.example` puts a
 * SECOND credential straight into that world-readable file, and `cli/doctor.ts`
 * then prints it verbatim — in the same sentence that says the credential's
 * value is never shown or logged. `no-key-in-output-law` does not catch it
 * either: it redacts the `rzk_` value, and this secret never passes through
 * `IngestKey` at all. Refusing at write time is the only place the operator is
 * still standing there to be told.
 *
 * **A query string and a fragment are refused for a smaller reason:** neither
 * survives `new URL(INGEST_PATH, base)`, so a base carrying either would be
 * silently stripped and every batch would go somewhere the operator did not
 * ask for. That is the shape of the defect `8c751e10` fixed for the path, and
 * the same answer is owed here — except that for these two, preserving them is
 * not obviously right (a token in a query is a credential in a `0644` file
 * again), so the destination is refused rather than guessed at.
 */
function assertBaseIsOnlyADestination(raw: string, url: URL): URL {
  if (url.username.length > 0 || url.password.length > 0) {
    // NOT `failUrl(raw, …)`: `raw` carries the value, and this message is
    // printed to the operator's terminal and can reach a log. The destination
    // is named in a spelling the value has been taken out of.
    throw new Error(
      `refusing to ship to "${withoutUserinfo(url)}": it carries a username or password in the URL, ` +
        'and the enable record it would be written to is world-readable (0644) — ' +
        'give the proxy its credential some other way, and pass a plain https:// team server URL',
    )
  }
  if (url.search.length > 0) {
    return failUrl(raw, 'a query string on the base is dropped when the ingest path is appended, so it would never be sent')
  }
  if (url.hash.length > 0) {
    return failUrl(raw, 'a fragment is never sent to a server, so a base carrying one does not mean what it says')
  }
  return url
}

/** The destination with any userinfo taken out — the only spelling of a userinfo-bearing base that is safe to print. */
function withoutUserinfo(url: URL): string {
  const clean = new URL(url.toString())
  clean.username = ''
  clean.password = ''
  return clean.toString()
}

function failUrl(raw: string, why: string): never {
  throw new Error(`refusing to ship to "${raw}": ${why} — pass an https:// team server URL`)
}

/**
 * The enable record, or `null` for "the hand is off".
 *
 * `null` means one thing only: there is no file. Every other failure is a
 * throw that names the path, because "off" is a promise about what cannot
 * leave and a corrupt file is not evidence for it.
 */
export async function readTeamConfig(sessionDir: string): Promise<TeamConfig | null> {
  const file = teamConfigPath(sessionDir)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null
    throw new Error(`the shipper's enable record at ${file} could not be read: ${describe(err)}`)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `the shipper's enable record at ${file} is not valid JSON (${describe(err)}) — ` +
        'delete that directory to turn the shipper off, or re-run `rhizomorph connect team <url> --project <id>`',
    )
  }

  const parsed = teamConfigSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error(
      `the shipper's enable record at ${file} is not a version ${TEAM_CONFIG_VERSION} record: ${parsed.error.message} — ` +
        'delete that directory to turn the shipper off, or re-run `rhizomorph connect team <url> --project <id>`',
    )
  }

  return parsed.data
}

/** Writes the enable record atomically at `0644`. The URL is validated here so an unusable destination is refused before anything is stored. */
export async function writeTeamConfig(sessionDir: string, config: TeamConfig): Promise<void> {
  assertShippableUrl(config.url)
  const parsed = teamConfigSchema.parse(config)
  await writeAtomicJson(teamConfigPath(sessionDir), parsed, 0o644, { what: 'team configuration' })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
