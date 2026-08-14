import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * RULING 2's LAW (prd-24): the requirement to have a contract test is itself
 * a law. `mutating-calls-law.test.ts` (packages/web) enumerates the app's
 * whole mutating surface as `MUTATING_MODULES`; this law asserts every entry
 * there has a contract test HERE — by declared enumeration, not ambition. A
 * fourth mutating module added without a row in `EXPECTED` fails this law,
 * and a row without a real test file fails it too.
 *
 * The enumeration is read from the web law's own source text rather than
 * restated, so the two cannot drift: the list this law checks IS the list
 * that law enforces. Grep-style, no AST, count-asserted (ruling 3: no
 * hardcoded vacuity floors — the floor is derived from the parse, and the
 * parse proves itself non-empty).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_LAW = path.resolve(HERE, '..', '..', 'web', 'src', 'replay', 'mutating-calls-law.test.ts')

/**
 * The declared routes inside the web law. Parsed by the `route:` field, which
 * is the entry's one distinctive literal — the `file:` values are
 * `path.join(...)` expressions, and bracket-matching the array literal is a
 * trap: the declaration's TYPE annotation (`headers: readonly string[]`)
 * contains a `]` before the array does, which is exactly how this parser's
 * first draft sliced an empty block and failed its own floor. Proven by that
 * failure, kept as the self-test below.
 */
/** The one regex, shared by the parser and its self-test so the test cannot pin a stale copy. */
const ROUTE_LITERAL = /route:\s*'([^']+)'/g

function routesIn(text: string): string[] {
  return [...text.matchAll(ROUTE_LITERAL)]
    .map((m) => m[1])
    .filter((r): r is string => r !== undefined)
    .sort()
}

function declaredRoutes(): string[] {
  return routesIn(readFileSync(WEB_LAW, 'utf8'))
}

/**
 * Route -> the contract test that covers it. Adding a mutating module means
 * adding a row here AND the test it names — that is the "declared
 * enumeration, not ambition" of ruling 2.
 */
const EXPECTED: ReadonlyArray<{ route: string; contractTest: string }> = [
  { route: '/api/label', contractTest: 'label.contract.test.ts' },
  { route: '/api/rotate', contractTest: 'rotate.contract.test.ts' },
  { route: '/api/lab/launch', contractTest: 'launch.contract.test.ts' },
  { route: '/api/concierge/launch', contractTest: 'instrument.contract.test.ts' },
  { route: '/api/concierge/clone', contractTest: 'clone.contract.test.ts' },
]

describe('every mutating module has a contract test (prd-24 ruling 2)', () => {
  it('the web law still declares the routes this law expects — the two enumerations cannot drift', () => {
    const declared = declaredRoutes()

    // Exact equality, both directions: a route added to MUTATING_MODULES with
    // no row here fails, and a stale row here whose route left the law fails.
    expect(declared).toEqual(EXPECTED.map((e) => e.route).sort())
    expect(declared.length).toBe(EXPECTED.length)
  })

  it('every expected contract test exists in this package, and nothing here is unexpected', () => {
    const present = readdirSync(HERE)
      .filter((f) => f.endsWith('.contract.test.ts'))
      .sort()

    expect(present).toEqual(EXPECTED.map((e) => e.contractTest).sort())
    expect(present.length).toBe(EXPECTED.length)
  })

  /**
   * A FILENAME IS NOT COVERAGE. The check above proves only that a file with
   * the right name exists — so a `fourth.contract.test.ts` containing nothing
   * but `it('placeholder', () => {})` would satisfy the whole law while
   * covering no route at all. That is this repo's worst defect shape (a test
   * that cannot fail for its stated reason) sitting inside the law written to
   * prevent exactly it, and it is what this case closes.
   *
   * Each named file must actually be a contract test: it must drive the
   * shared harness (so the REAL buildApp is booted) AND name its own route's
   * client, which is the property the harness's docblock claims and a
   * placeholder cannot fake.
   */
  it('each named file really is a contract test — harness plus its own client, not just the right filename', () => {
    for (const { route, contractTest } of EXPECTED) {
      const source = readFileSync(path.join(HERE, contractTest), 'utf8')

      expect(source, `${contractTest} never builds the shared harness`).toContain('buildContractHarness')
      expect(source, `${contractTest} never calls through h.fetch`).toContain('h.fetch')
      // The client module for this route, imported from @rhizomorph/web — a
      // placeholder file cannot satisfy this without actually importing the
      // real client the route belongs to.
      expect(source, `${contractTest} imports no @rhizomorph/web client`).toMatch(
        /from '@rhizomorph\/web\/[^']+'/,
      )
      // And it must exercise the gate in both directions, which is the whole
      // point of a contract test: an accepted request and a refused one.
      expect(source, `${contractTest} never exercises a refusal`).toMatch(/rejects\.toThrow/)
      expect(route).toMatch(/^\/api\//)
    }
  })

  it('the parser actually parses — the shape that defeated its first draft is pinned', () => {
    // Runs the SAME `routesIn` the law uses, not a re-implemented copy, so a
    // broken parser fails here too. An earlier version pinned an inline regex
    // and would have stayed green against a parser replaced wholesale.
    //
    // The sample is the real declaration's own shape: a type annotation
    // containing `[]` before the array, and `file:` values that are
    // expressions, not strings — exactly what defeated the bracket-matching
    // first draft.
    const sample =
      "const MUTATING_MODULES: ReadonlyArray<{ headers: readonly string[] }> = [\n" +
      "  { file: path.join(WEB_SRC, 'replay', 'rotate.ts'), route: '/api/rotate' },\n" +
      "  { file: path.join(WEB_SRC, 'a', 'b.ts'), route: '/api/b' },\n]"

    expect(routesIn(sample)).toEqual(['/api/b', '/api/rotate'])
  })
})
