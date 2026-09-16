import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeTeamStorage } from './fake.js'
import { createEventsSql } from './ports/events/sql.js'
import { createIngestKeysSql } from './ports/ingest-keys/sql.js'
import { createLifecycleSql } from './ports/lifecycle/sql.js'
import { createMigrationsSql } from './ports/migrations/sql.js'
import { createQuestionsSql } from './ports/questions/sql.js'
import { createSettingsSql } from './ports/settings/sql.js'
import { createPostgresStorage } from './postgres.js'
import { createRecordingSql } from './recording-sql.js'

/**
 * THE COMPOSITION LAW (#509, prd-51 wave 8).
 *
 * This wave ships no user-visible behaviour. Its entire product is a *layout*:
 * a storage capability is a **port** — one directory under `ports/` holding its
 * interface, its fake and its SQL — and adding one touches no other port's
 * files. Four wave-9 lanes are built on that claim being true, so the claim is
 * a test rather than a paragraph.
 *
 * Five cases, and what each is for:
 *
 * 1. The layout itself: `ports/` holds directories, each holding exactly three
 *    files. Without this, a port arrives as a loose module and the next one has
 *    no shape to copy.
 * 2. **Registration is enforced rather than remembered.** Every port directory
 *    is wired into all three composition roots. A wave-9 lane that adds a
 *    directory and forgets one of the three lines is caught here, at the layer
 *    where it is one line, rather than by a confusing type error.
 * 3. The adapter and the fake expose the **same** method set. Nothing checked
 *    this before: `implements TeamStorage` and `createPostgresStorage`'s return
 *    type each only ever asserted *"at least `TeamStorage`"*, so one double
 *    could silently grow a method the other lacked.
 * 4. The eleven methods this wave inherited are still all there — `toContain`,
 *    never an exact equality, so a wave-9 port does not redden a law it has
 *    nothing to do with.
 * 5. No two ports declare the same method name. A collision would be silently
 *    shadowed by the spread in `createPostgresStorage`, and nothing else looks.
 *
 * `createRecordingSql()` satisfies `SqlLike` without a database, and no
 * statement is ever sent because no method is called — only the shape of the
 * returned object is read.
 *
 * Case 5 imports the five `sql.ts` modules directly, which
 * `no-sql-outside-storage-law.test.ts`'s clause 5 restricts to `postgres.ts`.
 * There is no contradiction and no exception was added for it: that law sweeps
 * **non-test** `.ts` only, and this is a `.test.ts`.
 *
 * Every substring check below is a single line and contains no newline, so it is
 * CRLF-safe on the Windows leg.
 */

const STORAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PORTS_DIR = path.join(STORAGE_DIR, 'ports')

/** The eleven methods `TeamStorage` carried into this wave. */
const INHERITED_METHODS = [
  'appendEvents',
  'applyMigration',
  'close',
  'ensureMigrationsTable',
  'ensureMonthlyPartition',
  'findIngestKey',
  'insertIngestKey',
  'listAppliedMigrations',
  'readEvents',
  'readSetting',
  'revokeIngestKeys',
]

function portDirectories(): string[] {
  return readdirSync(PORTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function rootText(file: string): string {
  return readFileSync(path.join(STORAGE_DIR, file), 'utf8')
}

/**
 * The class's own delegations — prototype properties whose descriptor holds a
 * callable `value`. That excludes `constructor` and every getter, which is what
 * makes this comparable to the adapter's own key set.
 */
function fakeMethodNames(): string[] {
  const proto = FakeTeamStorage.prototype as unknown as object
  return Object.entries(Object.getOwnPropertyDescriptors(proto))
    .filter(([name, descriptor]) => name !== 'constructor' && typeof descriptor.value === 'function')
    .map(([name]) => name)
    .sort()
}

function adapterMethodNames(): string[] {
  return Object.keys(createPostgresStorage(createRecordingSql().sql)).sort()
}

describe('the composition law (#509, prd-51 wave 8)', () => {
  it('every entry under ports/ is a directory holding exactly port.ts, fake.ts and sql.ts', () => {
    const entries = readdirSync(PORTS_DIR, { withFileTypes: true })
    expect(entries.every((entry) => entry.isDirectory()), 'ports/ holds directories only').toBe(true)
    expect(entries.length).toBeGreaterThanOrEqual(5)
    for (const directory of portDirectories()) {
      const files = readdirSync(path.join(PORTS_DIR, directory)).sort()
      expect(files, `ports/${directory}`).toEqual(['fake.ts', 'port.ts', 'sql.ts'])
    }
  })

  it('every port directory is wired into all three composition roots', () => {
    const contract = rootText('contract.ts')
    const fake = rootText('fake.ts')
    const postgres = rootText('postgres.ts')
    for (const directory of portDirectories()) {
      expect(contract, `contract.ts registers ${directory}`).toContain(`./ports/${directory}/port.js`)
      expect(fake, `fake.ts registers ${directory}`).toContain(`./ports/${directory}/fake.js`)
      expect(postgres, `postgres.ts registers ${directory}`).toContain(`./ports/${directory}/sql.js`)
    }
  })

  it('the adapter and the fake expose exactly the same method set', () => {
    expect(adapterMethodNames()).toEqual(fakeMethodNames())
  })

  it('that shared set still contains the eleven methods this wave inherited', () => {
    const methods = adapterMethodNames()
    for (const name of INHERITED_METHODS) {
      expect(methods, `TeamStorage still carries ${name}`).toContain(name)
    }
    expect(methods.length).toBeGreaterThanOrEqual(INHERITED_METHODS.length)
  })

  it('no two ports declare the same method name', () => {
    const sql = createRecordingSql().sql
    // Alphabetical by port directory. This is the one place a new port adds a
    // line, and it is deliberate: the alternative is a dynamic import, which
    // would make the collision check depend on the very wiring it checks.
    const perPort = [
      createEventsSql(sql),
      createIngestKeysSql(sql),
      createLifecycleSql(sql),
      createMigrationsSql(sql),
      createQuestionsSql(sql),
      createSettingsSql(sql),
    ].map((port) => Object.keys(port))

    // The list above is written by hand, so its completeness is the one thing
    // this case cannot take for granted. Without this, a wave-9 lane that adds a
    // sixth port and not a sixth line gets a GREEN case 5 that checks nothing of
    // theirs — demonstrated in review of #511 with a port declaring `close`
    // beside LifecyclePort's: all five cases passed, and only an unrelated
    // behaviour assertion in postgres.test.ts noticed. Case 2 already refuses to
    // let registration be remembered rather than enforced; this case was
    // exempting itself from its own rule.
    expect(
      perPort.length,
      'a port directory exists that this case does not list — add it to `perPort` above, or its method names go unchecked for collisions',
    ).toBe(portDirectories().length)

    const total = perPort.reduce((sum, keys) => sum + keys.length, 0)
    const union = new Set(perPort.flat())
    expect(union.size, `a method name is declared by two ports: ${perPort.flat().sort().join(', ')}`).toBe(total)

    // …and the spread lost none of them. Deliberately a SUBSET check and not an
    // equality: an equality would pin the composed object to the five ports
    // listed above, so a wave-9 lane adding a sixth would redden this case — and
    // the claim this wave exists to make, that adding a port edits no other
    // port's files and no test, would be false by one line. Measured with the
    // throwaway probe port in: the equality reddened here and nowhere else.
    // It still bites where it must — drop a spread from `createPostgresStorage`
    // and the name its port declares goes missing from `composed`.
    const composed = adapterMethodNames()
    for (const name of [...union].sort()) {
      expect(composed, `the spread kept ${name}`).toContain(name)
    }
  })
})
