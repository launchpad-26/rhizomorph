import { describe, expect, it } from 'vitest'
import { eventToLine, lineToEvent, parseJsonl } from '../jsonl.js'
import { buildRecord } from './build.js'
import { verifyRecord } from './verify.js'

/**
 * THE RE-SERIALIZATION LAW (#292).
 *
 * `build.ts` does `events.map(eventToLine)` — a record's body is re-serialized
 * from PARSED events, never copied out of the log file's bytes. That single
 * fact is what makes the event schema an allowlist on the way into a shareable
 * record: zod strips keys the schema does not declare, so a field removed from
 * a payload cannot ride an old log line into a new record.
 *
 * `pane.activity.preview` is why this is written down. A pre-change log holds
 * the last non-empty line of a terminal capture verbatim; a record built after
 * #292 must not. The record is hash-chained, so there is no redacting it after
 * the fact — the strip has to happen at build time or never.
 *
 * The law below is deliberately stated over the MECHANISM rather than over
 * `preview` alone: it fails the moment anyone reinstates verbatim line copying
 * (keeping the log's own text, or threading unknown keys through the parser),
 * which is the change that would quietly pipe legacy `preview` values — and
 * every future dropped field — straight back into new records.
 */

const ACTOR = { instance: 'session-legacy-1', handle: 'alice', declared: true }

/**
 * A session log as an older build wrote it: real, current-schema events, but
 * carrying payload keys this build no longer declares — `preview` on
 * `pane.activity` plus two invented ones standing in for whatever gets dropped
 * next. Written as raw text, because the point is what happens to bytes that
 * are already on disk.
 */
const LEGACY_LOG = [
  JSON.stringify({
    v: 1,
    id: 'e1',
    ts: 1000,
    source: 'tmux',
    type: 'pane.discovered',
    payload: { paneId: '%1', windowName: 'w', currentPath: '/repo' },
  }),
  JSON.stringify({
    v: 1,
    id: 'e2',
    ts: 2000,
    source: 'tmux',
    type: 'pane.activity',
    payload: {
      paneId: '%1',
      contentHash: 'h1',
      lines: 42,
      preview: 'sk-live-LEGACY-PREVIEW-4c1d',
      footer: 'esc to interrupt',
      capturedText: 'the whole pane, hypothetically',
    },
  }),
  JSON.stringify({
    v: 1,
    id: 'e3',
    ts: 3000,
    source: 'tmux',
    type: 'pane.activity',
    payload: { paneId: '%1', contentHash: 'h2', previousHash: 'h1', lines: 43 },
  }),
].join('\n')

describe('record body re-serialization law', () => {
  it('parses the legacy log without losing a line — the fixture is a real log, not a broken one', () => {
    const { events, errors } = parseJsonl(LEGACY_LOG)
    expect(errors).toEqual([])
    expect(events).toHaveLength(3)
  })

  it('emits no body line that the current schema would not itself emit', () => {
    const { events } = parseJsonl(LEGACY_LOG)
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    expect(record.body).toHaveLength(3)
    for (const link of record.body) {
      const parsed = lineToEvent(link.line)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      // The fixed point: re-serializing the line's own event reproduces the
      // line byte for byte. A verbatim copy of a legacy line would not.
      expect(eventToLine(parsed.event)).toBe(link.line)
    }
  })

  it('leaves no trace of the dropped keys anywhere in the record', () => {
    const { events } = parseJsonl(LEGACY_LOG)
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })
    const serialized = JSON.stringify(record)

    expect(serialized).not.toContain('sk-live-LEGACY-PREVIEW-4c1d')
    expect(serialized).not.toContain('preview')
    expect(serialized).not.toContain('footer')
    expect(serialized).not.toContain('capturedText')
  })

  it('strips rather than drops — every legacy line is still a link, and the chain still verifies', () => {
    const { events } = parseJsonl(LEGACY_LOG)
    const record = buildRecord(events, { repoSlug: 'rhizomorph-abc123', actor: ACTOR })

    expect(record.manifest.eventCount).toBe(3)
    expect(verifyRecord(record)).toEqual({ ok: true })
    // The signal the fleet actually reads survives the strip.
    expect(record.body[1]?.line).toContain('"contentHash":"h1"')
    expect(record.body[1]?.line).toContain('"lines":42')
  })
})
