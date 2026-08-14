import { describe, expect, it } from 'vitest'

/**
 * #292 (PR #404) drops `pane.activity.preview` before a log line ever becomes
 * a shareable record, and it works only because zod strips undeclared keys
 * from a closed `z.object` — a legacy log line carrying `preview` is silently
 * discarded rather than round-tripped. Opening any ONE payload schema
 * (`.passthrough()`, `.loose()`, `.catchall()`, `z.record()`, `z.any()`,
 * `z.unknown()`) reopens that exact hole for that event type, and nothing
 * else in this suite goes red — the reserialization law only happens to
 * exercise `pane.activity` today.
 *
 * Grep-law style, per `fixture-hygiene-law.test.ts`: real source text, a
 * regex, no zod introspection — legible by eye. Every non-test source file
 * under this directory is bound in by name, as `?raw` text, rather than
 * walked with `readdirSync`: `@rhizomorph/core` has no Node type definitions
 * in scope at all (see `../eras/fold.ts`'s header and `../eras/raw.d.ts`,
 * which is what makes the `?raw` specifier below typecheck here), so this law
 * follows the same static-binding shape `eras/corpus.ts` already established
 * for the same constraint. The cost is real and stated once here rather than
 * hidden: a twelfth source file added to this directory needs a line added
 * below, the same way `eras/corpus.ts` needs a new era registered by hand.
 */

/**
 * `import.meta.glob` is Vite's build-time directory read — the bundler
 * enumerates the directory and inlines each file's text, so this walks the
 * directory FOR REAL without core growing any Node types (the constraint
 * `../eras/raw.d.ts` documents).
 *
 * The first version of this law bound eleven files in BY NAME. That satisfied
 * the letter of "no non-test source file opens a schema" and missed the point:
 * a twelfth file added to this directory was simply invisible, and the
 * anti-vacuity check below — `length > 0` on a hand-written object literal —
 * could only have failed if someone deleted all eleven lines. Verified before
 * this change: adding `events/summons.ts` containing
 * `z.object({…}).passthrough()` left every test here green.
 *
 * Declared locally rather than by adding `vite/client` to this package's
 * tsconfig, which is not this issue's fence.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Readonly<Record<string, string>>
  }
}

/** Every `.ts` in this directory, including this file — filtered below. */
const ALL_SOURCES = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true })

/**
 * Tests excluded, and this file above all: its own doc comment names every
 * hunted spelling WITH its opening paren, so a law that swept itself would
 * report itself as the violation. Two laws in this repo shipped that bug in
 * one week, both passing for the wrong reason until tests were excluded.
 */
const SOURCE_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALL_SOURCES)
    .filter(([file]) => !file.endsWith('.test.ts'))
    .map(([file, source]) => [file.replace(/^\.\//, ''), source]),
)

/** Each spelling that opens a `z.object`, or replaces it with something open. */
const OPEN_SCHEMA_RE =
  /\.passthrough\(|\.loose\(|\.catchall\(|z\.looseObject\(|z\.record\(|z\.any\(|z\.unknown\(/

function findOpenSchemaHits(source: string): string[] {
  const hits: string[] = []
  for (const line of source.split('\n')) {
    const match = OPEN_SCHEMA_RE.exec(line)
    if (match) hits.push(match[0])
  }
  return hits
}

describe('the no-open-payload law (#292 follow-up item 4)', () => {
  it('the sweep really reads the directory, and really excludes itself', () => {
    // Keyed to the WALK, not to a hardcoded roster. A count alone would still
    // rot; these three together fail on the ways a glob actually breaks —
    // matching nothing, matching only some, or matching this file too.
    expect(Object.keys(SOURCE_FILES).length).toBeGreaterThanOrEqual(10)
    for (const known of ['tmux.ts', 'trace.ts', 'common.ts']) {
      expect(Object.keys(SOURCE_FILES)).toContain(known)
    }

    // The glob DOES return sibling test files (`tmux.test.ts` and friends),
    // so the `.test.ts` filter is doing real work rather than being belt to a
    // glob that never matched tests anyway. Verified by probe: globbing this
    // directory from another file returns seven `.test.ts` entries.
    //
    // This file is not among them, and not because of the filter: Vite
    // excludes the IMPORTING module from its own glob. Both facts are pinned
    // because either one changing would quietly turn the law self-matching —
    // its doc comment names every hunted spelling, parens and all.
    expect(Object.keys(ALL_SOURCES).some((f) => f.endsWith('tmux.test.ts'))).toBe(true)
    expect(Object.keys(ALL_SOURCES).some((f) => f.endsWith('no-open-payload-law.test.ts'))).toBe(false)
    expect(Object.keys(SOURCE_FILES).some((f) => f.endsWith('.test.ts'))).toBe(false)
  })

  /**
   * The spelling that slipped past the first version of this law, kept as a
   * permanent case. zod 4 marks `.passthrough()` deprecated and its own notice
   * points authors at `z.looseObject()` — so the editor steers you into the
   * gap. Functionally identical: undeclared keys are preserved.
   */
  it('catches z.looseObject, the replacement zod deprecation notices recommend', () => {
    expect(findOpenSchemaHits('export const s = z.looseObject({ a: z.string() })')).toEqual(['z.looseObject('])
  })

  it('no non-test source file under events/ opens a payload schema', () => {
    const violations: Array<{ file: string; hits: string[] }> = []

    for (const [file, source] of Object.entries(SOURCE_FILES)) {
      const hits = findOpenSchemaHits(source)
      if (hits.length > 0) violations.push({ file, hits })
    }

    expect(violations).toEqual([])
  })

  it('the detector fires on a deliberately-opened schema — proving it bites', () => {
    const rigged = `export const paneActivityPayloadSchema = z.object({\n  paneId: nonEmptyString,\n}).passthrough()\n`
    expect(findOpenSchemaHits(rigged)).toEqual(['.passthrough('])
  })

  it('the detector does not fire on an ordinary closed schema — not vacuously true', () => {
    const clean = `export const paneActivityPayloadSchema = z.object({\n  paneId: nonEmptyString,\n})\n`
    expect(findOpenSchemaHits(clean)).toEqual([])
  })

  it('every forbidden spelling the detector names actually fires on its own', () => {
    expect(findOpenSchemaHits('z.object({}).passthrough()')).toEqual(['.passthrough('])
    expect(findOpenSchemaHits('z.object({}).loose()')).toEqual(['.loose('])
    expect(findOpenSchemaHits('z.object({}).catchall(z.string())')).toEqual(['.catchall('])
    expect(findOpenSchemaHits('z.record(z.string())')).toEqual(['z.record('])
    expect(findOpenSchemaHits('z.any()')).toEqual(['z.any('])
    expect(findOpenSchemaHits('z.unknown()')).toEqual(['z.unknown('])
  })

  it('does not fire on the bare names mentioned in prose without the call itself', () => {
    // This law's own doc comment (and this test) names every spelling it
    // hunts; requiring the opening paren means describing the law in words
    // does not accidentally trip it.
    expect(findOpenSchemaHits('z.record and z.any and z.unknown and passthrough are all forbidden here.')).toEqual(
      [],
    )
  })
})
