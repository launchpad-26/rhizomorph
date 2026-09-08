import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE NO-SQL-OUTSIDE-STORAGE LAW (prd-51 ruling 5).
 *
 * Ruling 5 keeps one discipline from the SQLite-first design it deviates from:
 * **storage behind an interface, no SQL in route handlers** — so swapping the
 * engine stays a re-deployment rather than a rewrite. That discipline is a
 * property of the *source text*, not of any function's behaviour: a helper that
 * quietly assembles a query one module over would pass every behavioural test
 * in this package while making the interface decorative. So this is a grep law,
 * in the style of `packages/core/src/wire/no-event-id-key-law.test.ts`.
 *
 * Scoped by what a file **is** — every non-test `.ts` under
 * `packages/team/src/` — and not by what it is called. A guard scoped by a
 * naming convention misses the files that predate it.
 *
 * ## Four clauses, and why fewer would not do
 *
 * A tagged-template driver makes a SQL fragment a first-class *value*. So SQL
 * can in principle leave the storage module as an object even when no string
 * literal moves, and a literal sweep alone would not see it. Clause 4 sees the
 * literals; clauses 1–3 see the **capability** — the driver import, the tagged
 * template, and the one un-parameterised escape hatch. Both halves are needed
 * and neither alone is the law. The port itself closes the remaining gap by
 * construction: `contract.ts` returns only plain data and never an `SqlLike`,
 * and clause 1 means nothing outside `driver.ts` can even name the driver.
 *
 * ## The mutation this law exists to catch
 *
 * Planted and observed red before this file was committed: move `appendEvents`'
 * insert template out of `postgres.ts` into `migrations/runner.ts`. Clauses 2
 * and 4 both fire, naming the file.
 */

const SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The two modules that may touch SQL and the driver. Everything else may not. */
const SQL_MODULE = path.join('storage', 'postgres.ts')
const DRIVER_MODULE = path.join('storage', 'driver.ts')

/** Every non-test `.ts` under `src/`, as repo-package-relative paths. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(path.join(SRC_DIR, f), 'utf8') }))
}

/**
 * `//` and block comments removed.
 *
 * Comment-stripping is what stops clause 4 convicting `contract.ts` for
 * explaining, in prose, the discipline it implements — the failure mode where a
 * law is satisfied by deleting the documentation. A `//` preceded by `:` is left
 * alone so a URL scheme (`postgres://…`) is not mistaken for a comment; the cost
 * is that a trailing comment on a line that also contains a URL survives into
 * the swept text, which can only ever produce a false positive, never hide one.
 */
export function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.search(/(^|[^:\\])\/\//)
      if (at === -1) return line
      return line.slice(0, line.indexOf('//', at))
    })
    .join('\n')
}

/** Clause 1 — the driver package, imported or required. */
export const DRIVER_IMPORT_RE = /(?:from|require\()\s*['"]postgres['"]/

/**
 * Clause 2 — a tagged-template query on the driver or a transaction handle.
 *
 * The lookbehind is not decoration. Written as `\b(?:sql|tx)\``, this convicted
 * `runner.ts` for the entirely innocent `` `${file.id}.sql` `` in a refusal
 * message: `.` is a non-word character, so `\b` held, and the detector saw a
 * file extension at the end of a template literal as a tag. A tag is an
 * identifier, so the character before it cannot be `.`, a word character or `$`.
 */
export const TAGGED_TEMPLATE_RE = /(?<![.\w$])(?:sql|tx)`/

/** Clause 3 — the un-parameterised escape hatch. */
export const UNSAFE_CALL_RE = /\.unsafe\s*\(/

/** Clause 4 — a SQL statement literal, as the issue words it. */
export const SQL_LITERAL_RE =
  /\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|ROLE|POLICY)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|GRANT\s|REVOKE\s|ON\s+CONFLICT)/i

interface Violation {
  readonly file: string
  readonly clause: string
  readonly hit: string
}

function violations(): Violation[] {
  const found: Violation[] = []
  for (const { file, text } of sources()) {
    const stripped = stripTsComments(text)

    if (file !== DRIVER_MODULE) {
      const hit = DRIVER_IMPORT_RE.exec(stripped)
      if (hit) found.push({ file, clause: 'driver import', hit: hit[0] })
    }
    if (file !== SQL_MODULE) {
      const tagged = TAGGED_TEMPLATE_RE.exec(stripped)
      if (tagged) found.push({ file, clause: 'tagged template', hit: tagged[0] })
      const unsafe = UNSAFE_CALL_RE.exec(stripped)
      if (unsafe) found.push({ file, clause: 'unsafe call', hit: unsafe[0] })
      const literal = SQL_LITERAL_RE.exec(stripped)
      if (literal) found.push({ file, clause: 'SQL literal', hit: literal[0] })
    }
  }
  return found
}

describe('the no-SQL-outside-storage law (#355, prd-51 ruling 5)', () => {
  it('the sweep really reads this package, and really excludes its tests', () => {
    const files = sources().map((s) => s.file)
    for (const known of [
      'bootstrap.ts',
      'index.ts',
      path.join('config', 'config.ts'),
      path.join('migrations', 'runner.ts'),
      path.join('storage', 'contract.ts'),
      path.join('storage', 'fake.ts'),
      path.join('storage', 'recording-sql.ts'),
      SQL_MODULE,
      DRIVER_MODULE,
    ]) {
      expect(files).toContain(known)
    }
    expect(files.length).toBeGreaterThanOrEqual(8)
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false)
    // …and it really read the bytes, not just the names.
    expect(sources().every((s) => s.text.length > 0)).toBe(true)
  })

  it('no source outside the storage module contains SQL or names the driver', () => {
    expect(violations()).toEqual([])
  })

  it('the exempt modules are exactly two, and they really do carry what the others may not', () => {
    const byFile = new Map(sources().map((s) => [s.file, stripTsComments(s.text)]))
    // If these ever stop being true the exemptions have become dead weight and
    // the law would be passing over nothing.
    expect(DRIVER_IMPORT_RE.test(byFile.get(DRIVER_MODULE) ?? '')).toBe(true)
    expect(TAGGED_TEMPLATE_RE.test(byFile.get(SQL_MODULE) ?? '')).toBe(true)
    expect(UNSAFE_CALL_RE.test(byFile.get(SQL_MODULE) ?? '')).toBe(true)
    expect(SQL_LITERAL_RE.test(byFile.get(SQL_MODULE) ?? '')).toBe(true)
  })

  it('there is exactly ONE un-parameterised call site in the whole package (ADR-0043)', () => {
    const occurrences = sources()
      .map(({ file, text }) => ({ file, count: [...stripTsComments(text).matchAll(/\.unsafe\s*\(/g)].length }))
      .filter(({ count }) => count > 0)
    expect(occurrences).toEqual([{ file: SQL_MODULE, count: 1 }])
  })

  it('the detectors bite', () => {
    expect(SQL_LITERAL_RE.test("const q = 'SELECT * FROM events'")).toBe(true)
    expect(SQL_LITERAL_RE.test('await client.query(`INSERT INTO events VALUES (1)`)')).toBe(true)
    expect(SQL_LITERAL_RE.test("sql.unsafe('DROP TABLE events')")).toBe(true)
    expect(SQL_LITERAL_RE.test('CREATE POLICY p ON events')).toBe(true)
    expect(SQL_LITERAL_RE.test('ON CONFLICT (project_id) DO NOTHING')).toBe(true)
    expect(TAGGED_TEMPLATE_RE.test('await sql`SELECT 1`')).toBe(true)
    expect(TAGGED_TEMPLATE_RE.test('await tx`INSERT INTO events DEFAULT VALUES`')).toBe(true)
    expect(UNSAFE_CALL_RE.test("sql.unsafe('DROP TABLE events')")).toBe(true)
    expect(DRIVER_IMPORT_RE.test("import postgres from 'postgres'")).toBe(true)
    expect(DRIVER_IMPORT_RE.test("const postgres = require('postgres')")).toBe(true)
  })

  it('and do not over-bite on the prose and the identifiers this package legitimately carries', () => {
    expect(SQL_LITERAL_RE.test(stripTsComments('// BEGIN -> INSERT INTO events -> COMMIT is ruling 4'))).toBe(false)
    expect(SQL_LITERAL_RE.test("readSetting('synchronous_commit')")).toBe(false)
    expect(SQL_LITERAL_RE.test("const id = '0001_events'")).toBe(false)
    expect(SQL_LITERAL_RE.test('const selected = rows.length')).toBe(false)
    expect(TAGGED_TEMPLATE_RE.test('const sql: SqlLike = openSql(url)')).toBe(false)
    expect(TAGGED_TEMPLATE_RE.test('unsafe(text: string) {')).toBe(false)
    // The real false positive this detector had, kept as a fixture: a filename
    // that ends a template literal is not a tag.
    expect(TAGGED_TEMPLATE_RE.test('return { error: `two share ordinal: ${a}.sql and ${b}.sql` }')).toBe(false)
    expect(TAGGED_TEMPLATE_RE.test('const mysql`')).toBe(false)
    expect(UNSAFE_CALL_RE.test('unsafe(text: string) {')).toBe(false)
    expect(DRIVER_IMPORT_RE.test("import { createPostgresStorage } from './postgres.js'")).toBe(false)
  })

  it('the comment stripper keeps a URL scheme and drops a real comment', () => {
    expect(stripTsComments("const u = 'postgres://localhost:5432/rz'")).toBe("const u = 'postgres://localhost:5432/rz'")
    expect(stripTsComments('const x = 1 // SELECT * FROM events')).toBe('const x = 1 ')
    expect(stripTsComments('/* SELECT * FROM events */ const x = 1')).toBe('  const x = 1')
    expect(stripTsComments('// SELECT 1')).toBe('')
  })

  it('the law would catch the mutation it names — the insert template moved into the runner', () => {
    // The mutation, applied to a copy of the runner's real text rather than to
    // the file, so the assertion is about the DETECTOR and leaves no tree edit
    // behind. Both clauses fire, which is the point of having both.
    const runner = sources().find((s) => s.file === path.join('migrations', 'runner.ts'))
    expect(runner).toBeDefined()
    const mutated = stripTsComments(
      `${runner?.text ?? ''}\nasync function leak(tx: SqlLike) { await tx\`INSERT INTO events DEFAULT VALUES\` }\n`,
    )
    expect(TAGGED_TEMPLATE_RE.test(mutated)).toBe(true)
    expect(SQL_LITERAL_RE.test(mutated)).toBe(true)
    // …and the unmutated file is clean, so the assertion above is not vacuous.
    expect(TAGGED_TEMPLATE_RE.test(stripTsComments(runner?.text ?? ''))).toBe(false)
    expect(SQL_LITERAL_RE.test(stripTsComments(runner?.text ?? ''))).toBe(false)
  })
})
