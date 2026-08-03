import { eventToLine } from '../jsonl.js'
import type { RhizomorphEvent } from '../events/index.js'
import { sha256Hex } from './hash.js'
import { RECORD_SCHEMA_VERSION, type Actor, type RecordLink, type SessionRecord } from './schema.js'

export interface BuildRecordMeta {
  repoSlug: string
  actor: Actor
  /** Defaults to {@link RECORD_SCHEMA_VERSION}; only a future format revision passes another. */
  schemaVersion?: number
}

/** Binds the chain to this record's identity, so tampering with `repoSlug`/`actor.instance`/`schemaVersion` breaks link 1 even if every line is byte-identical. */
function genesisSeed(meta: Required<BuildRecordMeta>): string {
  return `rhizomorph-record:${meta.schemaVersion}:${meta.repoSlug}:${meta.actor.instance}`
}

function chainLines(lines: readonly string[], seed: string): { links: RecordLink[]; chainDigest: string } {
  let prevHash = sha256Hex(seed)
  const links: RecordLink[] = []
  for (const line of lines) {
    const hash = sha256Hex(prevHash + line)
    links.push({ line, prevHash, hash })
    prevHash = hash
  }
  return { links, chainDigest: prevHash }
}

/** Min/max over an event array without spreading it onto the call stack — a long session's log can hold many thousands of lines. */
function tsRange(events: readonly RhizomorphEvent[]): { startTs: number; endTs: number } {
  if (events.length === 0) return { startTs: 0, endTs: 0 }
  let startTs = events[0]!.ts
  let endTs = events[0]!.ts
  for (const event of events) {
    if (event.ts < startTs) startTs = event.ts
    if (event.ts > endTs) endTs = event.ts
  }
  return { startTs, endTs }
}

/**
 * Folds an event log into a portable, integrity-checked session record. The
 * body holds the log's own lines verbatim (via {@link eventToLine} — the same
 * serialization the session log itself uses), so a record is byte-identical
 * to what was recorded, not a re-derivation of it.
 */
export function buildRecord(events: readonly RhizomorphEvent[], meta: BuildRecordMeta): SessionRecord {
  const schemaVersion = meta.schemaVersion ?? RECORD_SCHEMA_VERSION
  const full: Required<BuildRecordMeta> = { repoSlug: meta.repoSlug, actor: meta.actor, schemaVersion }

  const lines = events.map(eventToLine)
  const { links, chainDigest } = chainLines(lines, genesisSeed(full))
  const { startTs, endTs } = tsRange(events)

  return {
    manifest: {
      schemaVersion,
      repoSlug: meta.repoSlug,
      actor: meta.actor,
      startTs,
      endTs,
      eventCount: events.length,
      chainDigest,
      signature: null,
    },
    body: links,
  }
}

export { genesisSeed as recordGenesisSeed }
