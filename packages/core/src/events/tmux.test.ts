import { describe, expect, it } from 'vitest'
import { paneActivityPayloadSchema, paneDiscoveredPayloadSchema } from './tmux.js'

/**
 * The tmux payloads' key-sets, stated structurally (#292).
 *
 * `pane.activity` is the one event derived from a `tmux capture-pane` — the
 * rendered contents of somebody's terminal. Its allowlist IS the boundary
 * between "that pane changed, at this time" and "here is what it said": a
 * content hash and a line count carry the whole signal the flatline detector
 * and the fleet read, and nothing else from the capture has anywhere to land.
 *
 * `preview` used to. It held the last non-empty captured line verbatim, which
 * went into the session log and out through `export-record` into a
 * hash-chained record that cannot be redacted afterwards. Widening this list
 * is how the next attempt to put pane text on an event gets noticed.
 */

describe('paneActivityPayloadSchema', () => {
  it('has a fixed allowlist of fields — a hash and a count, never the text', () => {
    expect(Object.keys(paneActivityPayloadSchema.shape).sort()).toEqual(
      ['contentHash', 'lines', 'paneId', 'previousHash'].sort(),
    )
  })

  it('carries no `preview`, nor the obvious names it would come back under', () => {
    for (const field of ['preview', 'tail', 'footer', 'glance', 'snippet', 'lastLine']) {
      expect(Object.keys(paneActivityPayloadSchema.shape)).not.toContain(field)
    }
  })

  it('strips a legacy `preview` on parse rather than failing the line', () => {
    // Backward compatibility: a pre-#292 log line still reads, it just arrives
    // without the captured text. Old recordings stay readable; nothing about
    // them re-enters a record built now.
    const parsed = paneActivityPayloadSchema.parse({
      paneId: '%1',
      contentHash: 'h1',
      lines: 42,
      preview: 'sk-live-SENTINEL-9f2a',
    })
    expect(parsed).toEqual({ paneId: '%1', contentHash: 'h1', lines: 42 })
    expect(Object.keys(parsed)).not.toContain('preview')
  })
})

describe('paneDiscoveredPayloadSchema', () => {
  /**
   * A change detector, not a privacy boundary. `title`, `windowName` and
   * `currentCommand` are free-form text a program or shell can set, and they
   * legitimately live here — narrowing THAT is separate work
   * (`docs/follow-up-292.md`). This test exists so a new field arrives
   * deliberately.
   */
  it('has a fixed key-set', () => {
    expect(Object.keys(paneDiscoveredPayloadSchema.shape).sort()).toEqual(
      [
        'currentCommand',
        'currentPath',
        'paneId',
        'sessionName',
        'title',
        'windowIndex',
        'windowName',
        'worktreePath',
      ].sort(),
    )
  })
})
