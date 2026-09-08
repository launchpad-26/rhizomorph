import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TeamStorage } from '../storage/contract.js'

/**
 * THE MIGRATION RUNNER (prd-51 ruling 13, ADR-0035).
 *
 * Migrations are tracked SQL files applied in order against a `_migrations`
 * table, and running them twice is a no-op. This module contains **no SQL** —
 * every statement it applies came out of a file, and every statement it needs
 * for its own bookkeeping lives behind {@link TeamStorage}. That is ruling 5's
 * discipline, and `no-sql-outside-storage-law.test.ts` holds it.
 *
 * ## Refusals, not exceptions
 *
 * Every rule below returns `{ ok: false, error }` rather than throwing,
 * following `parseIngestRequest`'s result shape in
 * `packages/core/src/wire/protocol.ts`. A migration runner is the first thing a
 * deployment touches, and the caller needs a sentence it can print, not a stack.
 *
 * ## Atomicity is per migration, not per run
 *
 * Each migration is one transaction and is committed before the next begins. A
 * failure mid-run therefore leaves an applied *prefix*, and the next run
 * resumes from it. That is said out loud because the alternative — one
 * transaction around the whole run — is what a reader assumes, and it is not
 * what happens: it cannot be, because DDL that has to see the previous
 * migration's table cannot share its transaction across a connection reset.
 *
 * ## The plan phase
 *
 * Every consistency check runs **before** the first apply: a checksum mismatch
 * on `0001` must not land `0002` on its way to discovering the problem. That is
 * the difference between a per-file check inside the apply loop and this.
 */

/** `0001_events.sql` — four digits, an underscore, a lowercase slug. Anything else is a refusal. */
const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/

export interface MigrationFile {
  /** `0001_events` — the filename without its extension. */
  readonly id: string
  /** The parsed integer prefix. Ordering is numeric, never a string compare. */
  readonly ordinal: number
  readonly checksum: string
  readonly sql: string
}

export type ReadMigrationDirResult = MigrationFile[] | { error: string }

export type RunResult =
  | { ok: true; applied: string[]; alreadyApplied: string[] }
  | { ok: false; error: string }

/** The tracked migrations that ship with this package. */
export const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * sha-256 hex of the text, with `\r\n` normalised to `\n` first.
 *
 * The normalise is not a nicety. A Windows checkout with `core.autocrlf=true`
 * writes every tracked `.sql` with CRLF line endings, so a checksum over the
 * raw bytes would make every already-applied migration look tampered on that
 * machine — and only on that machine, which is the worst place for a bug to
 * live. The repo has been bitten by exactly this shape before: literal
 * comparisons against tracked text redden only on the `windows-suite` leg.
 */
export function checksumOf(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

/**
 * Reads and validates a migration directory.
 *
 * Three directory-level refusals live here rather than in {@link runMigrations},
 * because each is a fact about the *set* of files and none of them can be
 * decided one file at a time:
 *
 * - a `.sql` file whose name does not match {@link MIGRATION_FILE_RE} is a
 *   refusal **by name**. Silently skipping it is how a typo'd migration never
 *   runs and nobody finds out until the column is missing in production.
 * - two files at the same ordinal is a refusal naming both. Last-write-wins
 *   discovery would pick one arbitrarily.
 * - a gap in the ordinals is a refusal naming the missing one. Ordinals are
 *   `1..N` contiguous, so a missing `0002` means a file was lost, not that the
 *   author skipped a number.
 *
 * Files that are not `.sql` at all are ignored — a `README.md` beside the
 * migrations is not an error.
 */
export function readMigrationDir(dir: string = MIGRATIONS_DIR): ReadMigrationDirResult {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if (isNotFound(error)) return { error: `migration directory does not exist: ${dir}` }
    return { error: `migration directory could not be read: ${dir} (${String(error)})` }
  }

  const files: MigrationFile[] = []
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.sql')) continue
    const match = MIGRATION_FILE_RE.exec(entry)
    if (!match) {
      return {
        error: `migration file is not named NNNN_slug.sql: ${entry} — rename it or remove it; a file this runner cannot order is a file it must not skip`,
      }
    }
    const text = readFileSync(path.join(dir, entry), 'utf8')
    files.push({
      id: entry.slice(0, -'.sql'.length),
      ordinal: Number.parseInt(match[1] as string, 10),
      checksum: checksumOf(text),
      sql: text,
    })
  }

  files.sort((a, b) => a.ordinal - b.ordinal)

  const seen = new Map<number, string>()
  for (const file of files) {
    const previous = seen.get(file.ordinal)
    if (previous !== undefined) {
      return { error: `two migrations share ordinal ${file.ordinal}: ${previous}.sql and ${file.id}.sql` }
    }
    seen.set(file.ordinal, file.id)
  }

  for (let expected = 1; expected <= files.length; expected += 1) {
    const file = files[expected - 1]
    if (!file || file.ordinal !== expected) {
      return {
        error: `migration ordinals must be contiguous from 0001: ${String(expected).padStart(4, '0')} is missing`,
      }
    }
  }

  return files
}

/**
 * Applies every migration the database has not seen, in ordinal order.
 *
 * The sequence is fixed: read and validate the directory, ensure the
 * bookkeeping table, read what is already applied, **check everything**, and
 * only then apply. Nothing is applied by a run that is going to refuse.
 */
export async function runMigrations(storage: TeamStorage, dir: string = MIGRATIONS_DIR): Promise<RunResult> {
  const discovered = readMigrationDir(dir)
  if (!Array.isArray(discovered)) return { ok: false, error: discovered.error }

  await storage.ensureMigrationsTable()
  const applied = await storage.listAppliedMigrations()
  const byId = new Map(discovered.map((file) => [file.id, file]))

  // The plan phase. Every check here runs before the first apply.
  for (const row of applied) {
    const file = byId.get(row.id)
    if (!file) {
      return {
        ok: false,
        error: `_migrations records ${row.id}, which no tracked file provides — this image is older than the database it is pointed at`,
      }
    }
    if (file.checksum !== row.checksum) {
      return {
        ok: false,
        error: `${row.id} has changed since it was applied (recorded ${row.checksum}, computed ${file.checksum}) — migrations are append-only, so write a new NNNN file instead of editing this one`,
      }
    }
  }

  const appliedIds = new Set(applied.map((row) => row.id))
  const alreadyApplied = discovered.filter((file) => appliedIds.has(file.id)).map((file) => file.id)
  const pending = discovered.filter((file) => !appliedIds.has(file.id))

  const justApplied: string[] = []
  for (const file of pending) {
    try {
      await storage.applyMigration({ id: file.id, checksum: file.checksum, sql: file.sql })
    } catch (error) {
      return {
        ok: false,
        error: `${file.id} failed to apply (${error instanceof Error ? error.message : String(error)}) — ${justApplied.length} migration(s) were applied before it and remain applied; fix the cause and re-run`,
      }
    }
    justApplied.push(file.id)
  }

  return { ok: true, applied: justApplied, alreadyApplied }
}
