import type { IngestKeyRow, IngestKeysPort } from './port.js'

export interface IngestKeysFakeOptions {
  /**
   * Makes {@link IngestKeysFake.findIngestKey} throw — a database that cannot
   * answer *"is this key revoked?"*.
   *
   * Not a kindness for the sake of coverage: the only safe answer to that
   * question going unanswered is to refuse the batch, and the tempting
   * implementation accepts it because the `catch` sits one level above the
   * check. Mutable, so one fake can fail a request and serve the next.
   */
  readonly failFindIngestKey?: boolean
}

export interface IngestKeysFake extends IngestKeysPort {
  /** `ingest_keys`, keyed by hash. Ruling 8's rows, and never a plaintext. */
  readonly ingestKeys: Map<string, IngestKeyRow>
  /**
   * Every hash {@link IngestKeysFake.findIngestKey} was asked for, in order.
   *
   * This is what "checked once per batch" is asserted against: its LENGTH after
   * a multi-event batch is 1, and after two batches it is 2. A call log is the
   * only way to falsify "once per event" and "cached across batches" at once —
   * both produce correct responses and a different number of reads.
   */
  readonly keyLookups: string[]
  /** See {@link IngestKeysFakeOptions.failFindIngestKey}. Live and mutable. */
  failFindIngestKey: boolean
}

export function createIngestKeysFake(calls: string[], options: IngestKeysFakeOptions): IngestKeysFake {
  const ingestKeys = new Map<string, IngestKeyRow>()
  const keyLookups: string[] = []
  // Closure state rather than a plain field, so `findIngestKey` reads it without
  // `this`. The composing class forwards a getter/setter pair onto this, and a
  // method that depended on its own receiver would break the moment anything
  // spread or destructured the port.
  let failFindIngestKey = options.failFindIngestKey ?? false

  return {
    ingestKeys,
    keyLookups,
    get failFindIngestKey(): boolean {
      return failFindIngestKey
    },
    set failFindIngestKey(value: boolean) {
      failFindIngestKey = value
    },

    /**
     * Idempotent on the hash, because the adapter's insert is
     * `ON CONFLICT (key_hash) DO NOTHING` and this double must not be kinder than
     * it. A re-seed that overwrote the row would silently un-revoke a revoked key.
     */
    async insertIngestKey(row: IngestKeyRow): Promise<void> {
      calls.push('insertIngestKey')
      if (ingestKeys.has(row.keyHash)) return
      ingestKeys.set(row.keyHash, row)
    },

    async findIngestKey(keyHash: string): Promise<IngestKeyRow | null> {
      calls.push('findIngestKey')
      keyLookups.push(keyHash)
      if (failFindIngestKey) {
        throw new Error('the fake storage was told to fail the ingest key read')
      }
      return ingestKeys.get(keyHash) ?? null
    },

    /**
     * Skips rows that are already revoked, so `revokedAtMs` records when the key
     * was retired rather than when a boot last noticed — the adapter's predicate
     * says the same thing with `revoked_at IS NULL`.
     */
    async revokeIngestKeys(request: {
      projectId: string
      exceptKeyHash?: string | undefined
      atMs: number
    }): Promise<number> {
      calls.push('revokeIngestKeys')
      let changed = 0
      for (const [hash, row] of ingestKeys) {
        if (row.projectId !== request.projectId) continue
        if (row.revokedAtMs !== null) continue
        if (request.exceptKeyHash !== undefined && hash === request.exceptKeyHash) continue
        ingestKeys.set(hash, { ...row, revokedAtMs: request.atMs })
        changed += 1
      }
      return changed
    },
  }
}
