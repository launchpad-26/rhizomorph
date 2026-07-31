import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Where a collector's snapshot lives between runs.
 *
 * Snapshots are how a collector knows what it has already seen — sessionlog's
 * per-file byte offsets above all. Held only in the poll loop's Map they die
 * with the process, so every restart re-reads every log from byte 0 and
 * records another full copy of history. Persisting them is what turns a
 * restart into *resuming the run*.
 *
 * The store is deliberately dumb: JSON in, JSON out, keyed by collector name.
 * It never interprets a snapshot, so collectors stay free to change their own
 * shape — the only contract is that a snapshot must survive `JSON.stringify`
 * (plain objects, arrays and primitives; no `Map`, `Set` or `Date`).
 */
export interface SnapshotStore {
  /**
   * The stored snapshot for `collectorName`, or `{ found: false }` when there
   * isn't a usable one. Never throws and never rejects: a missing file, a
   * half-written one, an unreadable directory all mean the same thing to a
   * collector — start fresh.
   */
  load(collectorName: string): Promise<LoadedSnapshot>
  /** Persists `snapshot` for `collectorName`, replacing any previous one. */
  save(collectorName: string, snapshot: unknown): Promise<void>
}

export type LoadedSnapshot = { found: true; snapshot: unknown } | { found: false }

const NOTHING: LoadedSnapshot = { found: false }

/**
 * File name for a collector's snapshot: readable stem plus a short hash of the
 * exact name, the same trick `log/paths.ts` uses for repo slugs. The hash is
 * what stops two names that sanitize alike (`otel`, `oTel`) from silently
 * sharing one file — a collector eating another's offsets would be invisible.
 */
export function snapshotFileName(collectorName: string): string {
  const stem = collectorName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha1').update(collectorName).digest('hex').slice(0, 8)
  return `${stem || 'collector'}-${hash}.json`
}

/**
 * Snapshots as one JSON file per collector under `dir`. The caller owns the
 * directory (the CLI passes one alongside the session logs) so tests can point
 * it at a temp dir and nothing writes into the watched repo.
 */
export function createFileSnapshotStore(dir: string): SnapshotStore {
  let tmpCounter = 0

  function filePathFor(collectorName: string): string {
    return path.join(dir, snapshotFileName(collectorName))
  }

  return {
    async load(collectorName) {
      let raw: string
      try {
        raw = await readFile(filePathFor(collectorName), 'utf8')
      } catch {
        return NOTHING
      }
      try {
        return { found: true, snapshot: JSON.parse(raw) }
      } catch {
        // Corrupt (truncated by a kill mid-write, hand-edited, garbage). A
        // fresh start costs a re-read; crashing the boot costs the whole run.
        return NOTHING
      }
    },

    async save(collectorName, snapshot) {
      const serialized = JSON.stringify(snapshot)
      if (serialized === undefined) {
        // `undefined`, a function, a symbol — nothing a collector should hold.
        // Loud here beats a file that reads back as something else next boot.
        throw new TypeError(`snapshot for "${collectorName}" is not JSON-serialisable`)
      }
      const filePath = filePathFor(collectorName)
      await mkdir(dir, { recursive: true })
      tmpCounter += 1
      // Write-then-rename: a reader (this process next boot, or a curious
      // human) only ever sees a whole snapshot, never a half-written one.
      const tmpPath = `${filePath}.${process.pid}-${tmpCounter}.tmp`
      try {
        await writeFile(tmpPath, `${serialized}\n`, 'utf8')
        await rename(tmpPath, filePath)
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}
