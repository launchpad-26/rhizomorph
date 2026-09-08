import { describe, expect, it } from 'vitest'

/**
 * THE POSITION-KEY LAW (prd-51 ruling 3, ADR-0033).
 *
 * The wire is keyed on `(project, actorInstance, n)`, where `n` is the 1-based
 * position of a line in the source ledger. The briefed design keyed it on the
 * event id instead; executed against a real ledger, that silently discarded
 * **74.5 %** of it, because event ids restart on session resume
 * (`docs/research/2026-08-28-shared-record-s2-shipper.md`, §schema defect).
 *
 * "Nothing in the module reads or exposes the event id as a key" is the
 * issue's own wording, and it is a property of the *source text*, not of any
 * one function's behaviour — a helper that quietly reaches for an id would
 * pass every behavioural test in this directory while reintroducing the exact
 * defect. So this is a grep law, in the style of
 * `events/no-open-payload-law.test.ts` and `fixture-hygiene-law.test.ts`: real
 * source text, a regex, no introspection, legible by eye.
 *
 * **The mutation this law exists to catch**, planted and observed red before
 * this file was committed: adding `const key = event.id` to `protocol.ts`.
 *
 * Scoped by what a file IS (a non-test `.ts` under `wire/`) rather than by
 * what it is called — a guard scoped by a naming convention misses the files
 * that predate it.
 */

/**
 * `import.meta.glob` is Vite's build-time directory read: the bundler
 * enumerates the directory and inlines each file's text, so this walks the
 * directory FOR REAL without `packages/core` growing any Node types (the
 * constraint `../eras/raw.d.ts` documents).
 *
 * Declared locally rather than by adding `vite/client` to this package's
 * tsconfig, which is outside this issue's fence. It merges as an overload with
 * the identical block in `events/no-open-payload-law.test.ts` — verified by
 * `tsc --noEmit -p packages/core`.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Readonly<Record<string, string>>
  }
}

/** Every `.ts` in this directory except this one — Vite excludes the importing module from its own glob. */
const ALL_SOURCES = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true })

const SOURCE_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALL_SOURCES)
    .filter(([file]) => !file.endsWith('.test.ts'))
    .map(([file, source]) => [file.replace(/^\.\//, ''), source]),
)

/**
 * `eventId` in any casing-preserved spelling, and any `.id` property read.
 * `.id` is deliberately broad: `event.id`, `parsed.id`, `e.id` are all the same
 * mistake, and the wire has no legitimate reason to read an `id` off anything.
 */
const EVENT_ID_RE = /\beventId\b|\.id\b/

function findEventIdHits(source: string): string[] {
  const hits: string[] = []
  for (const line of source.split('\n')) {
    const match = EVENT_ID_RE.exec(line)
    if (match) hits.push(match[0])
  }
  return hits
}

describe('the position-key law (#257, prd-51 ruling 3)', () => {
  it('the sweep really reads this directory, and really excludes itself', () => {
    // Keyed to the WALK, not to a hardcoded roster: a glob that matched nothing
    // would make every assertion below vacuously true.
    for (const known of ['protocol.ts', 'reserialize.ts', 'split.ts']) {
      expect(Object.keys(SOURCE_FILES)).toContain(known)
    }
    expect(Object.keys(SOURCE_FILES).length).toBeGreaterThanOrEqual(4)

    // The glob DOES return sibling test files, so the `.test.ts` filter is
    // doing real work rather than being belt to a glob that never matched
    // tests. This file is not among them, and not because of the filter: Vite
    // excludes the importing module from its own glob — which matters here,
    // because the doc comments in this file name the forbidden spellings.
    expect(Object.keys(ALL_SOURCES).some((f) => f.endsWith('protocol.test.ts'))).toBe(true)
    expect(Object.keys(ALL_SOURCES).some((f) => f.endsWith('no-event-id-key-law.test.ts'))).toBe(false)
    expect(Object.keys(SOURCE_FILES).some((f) => f.endsWith('.test.ts'))).toBe(false)
  })

  it('no source under wire/ reads or exposes an event id', () => {
    const violations: Array<{ file: string; hits: string[] }> = []

    for (const [file, source] of Object.entries(SOURCE_FILES)) {
      const hits = findEventIdHits(source)
      if (hits.length > 0) violations.push({ file, hits })
    }

    expect(violations).toEqual([])
  })

  /**
   * The guard against a rotted regex. A detector that matches nothing passes
   * the law above for the wrong reason, and passes it forever.
   */
  it('the detector fires on the mutation it names', () => {
    expect(findEventIdHits('const key = event.id')).toEqual(['.id'])
    expect(EVENT_ID_RE.test('const key = event.id')).toBe(true)
    expect(findEventIdHits('const eventId = entry.n')).toEqual(['eventId'])
    expect(findEventIdHits('dedupe(rows, (r) => r.id)')).toEqual(['.id'])
  })

  it('the detector does not fire on the position key it protects', () => {
    expect(findEventIdHits('const key = { project, actorInstance, n }')).toEqual([])
    expect(findEventIdHits('export const ledgerPositionSchema = z.number().int().positive()')).toEqual([])
    // Nor on the words themselves — the law is about reads, not about prose.
    expect(findEventIdHits('keyed on the event id, not on the position')).toEqual([])
  })
})
