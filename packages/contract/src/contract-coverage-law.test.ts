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
 * The read axis's own source (#61, prd-29 w3): `ROUTE_CLASSES` in the
 * SERVER's own route table, not the web law — see the doc comment above the
 * read axis's `describe` block below for why.
 */
const SERVER_API_INDEX = path.resolve(HERE, '..', '..', 'server', 'src', 'api', 'index.ts')

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

/**
 * THE READ AXIS'S OWN ENUMERATION (#61, prd-29 w3). Route -> the real web
 * module a reader of that route goes through -> the contract test that covers
 * it -> the shape its refusal takes, since a read's refusal does not always
 * throw the way a mutating call's does (see `refusalShape` below).
 *
 * **What this law proves, and what it does not (the boundary with the
 * already-shipped `mutating-calls-law.test.ts`'s `READ_MODULES`).** This law
 * proves "every server-declared `gated-read` route has an end-to-end proof of
 * refusal, driven through a real client against the real server" — by route,
 * outside-in. `READ_MODULES` (web, out of this issue's fence, already shipped
 * under prd-29 ruling 6) proves "which files may build a read's header block,
 * and is its shape exactly right" — by file, inside-out: it is the read
 * side's counterpart to the mutating five's inline-header discipline, not a
 * route inventory. Neither duplicates the other, and this package never
 * re-implements any part of `assertHeaderBlocksExact` — that mechanism stays
 * in `mutating-calls-law.test.ts` alone.
 */
const EXPECTED_READS: ReadonlyArray<{
  route: string
  /** The real web module this row's contract test must import from, e.g. "replay/api.ts". */
  module: string
  contractTest: string
  refusalShape: 'throws' | 'swallows'
}> = [
  { route: '/api/sessions', module: 'replay/api.ts', contractTest: 'sessions.contract.test.ts', refusalShape: 'throws' },
  {
    route: '/api/sessions/:id/events',
    module: 'replay/api.ts',
    contractTest: 'session-events.contract.test.ts',
    refusalShape: 'throws',
  },
  { route: '/api/lanes', module: 'fleet/manifest.ts', contractTest: 'lanes.contract.test.ts', refusalShape: 'swallows' },
  {
    route: '/api/transcript/:lane',
    module: 'drawer/useTranscript.ts',
    contractTest: 'transcript.contract.test.ts',
    refusalShape: 'swallows',
  },
  {
    route: '/api/lab/checkpoints',
    module: 'lab/api.ts',
    contractTest: 'lab-checkpoints.contract.test.ts',
    refusalShape: 'throws',
  },
  {
    route: '/api/lab/experiments',
    module: 'lab/api.ts',
    contractTest: 'lab-experiments.contract.test.ts',
    refusalShape: 'throws',
  },
  {
    route: '/api/lab/estimate',
    module: 'lab/launch/estimate.ts',
    contractTest: 'lab-estimate.contract.test.ts',
    refusalShape: 'throws',
  },
  {
    route: '/api/lane-index',
    module: 'recordings/laneIndex.ts',
    contractTest: 'lane-index.contract.test.ts',
    refusalShape: 'throws',
  },
  {
    route: '/api/lane-index/:handle',
    module: 'lane-page/laneIndex.ts',
    contractTest: 'lane-index-entry.contract.test.ts',
    refusalShape: 'swallows',
  },
  {
    route: '/api/session-preview/:sessionId',
    module: 'connect/meta.ts',
    contractTest: 'session-preview.contract.test.ts',
    refusalShape: 'swallows',
  },
  {
    route: '/api/concierge/repos',
    module: 'connect/meta.ts',
    contractTest: 'concierge-repos.contract.test.ts',
    refusalShape: 'swallows',
  },
  { route: '/api/meta', module: 'connect/meta.ts', contractTest: 'meta.contract.test.ts', refusalShape: 'swallows' },
  { route: '/api/doctor', module: 'connect/meta.ts', contractTest: 'doctor.contract.test.ts', refusalShape: 'swallows' },
]

/**
 * `/api/stream` is `ROUTE_CLASSES`' 14th `gated-read` row and DELIBERATELY has
 * no row in {@link EXPECTED_READS} above (see the dedicated test below for why,
 * named rather than silently dropped): it is cookie-authenticated (ruling 4 /
 * #60) because `EventSource` cannot send a header at all, so there is no
 * `capabilityRead` caller and no fetch-shaped client this harness could drive
 * through a response-based refusal assertion. It is proven by its own
 * dedicated non-contract test (`stream.test.ts`), not by this law.
 */
const DELIBERATELY_EXCLUDED_GATED_READS: ReadonlySet<string> = new Set(['/api/stream'])

/**
 * THE PARSER DECISION (#61, prd-29 w3), decided here rather than left open:
 * the read axis reuses the coverage law's existing parser STRATEGY — a
 * scoped regex over a closed-world array literal, self-tested against a
 * synthetic sample — but points it at a NEW source, `ROUTE_CLASSES` in
 * `server/src/api/index.ts`, not the web mutation law `routesIn` above
 * reads. `READ_MODULES` on the web side (`mutating-calls-law.test.ts`) has
 * only ONE row — the shared header module — so it cannot serve as a
 * per-ROUTE enumeration at all. `ROUTE_CLASSES` is the actual
 * security-relevant source of truth: it is what the gate-presence law
 * (ADR-0024) already keeps honest against the real running app, so keying on
 * it means a new `gated-read` route with zero web callers still fails this
 * law loudly instead of being invisible to a module-discovery walker. No new
 * AST or filesystem walker — the same regex technique, a new source, and a
 * simpler shape than `routesIn` needs: `ROUTE_CLASSES` rows carry no `file:`
 * expression for the parser to dodge, only literals.
 */
const GATED_READ_LITERAL = /\{ method: '[A-Z]+', url: '([^']+)', routeClass: 'gated-read' \}/g

function gatedReadRoutesIn(text: string): string[] {
  return [...text.matchAll(GATED_READ_LITERAL)]
    .map((m) => m[1])
    .filter((r): r is string => r !== undefined)
    .sort()
}

/** Every `gated-read` row `ROUTE_CLASSES` declares, minus the one this law deliberately does not cover — see {@link DELIBERATELY_EXCLUDED_GATED_READS}. */
function declaredGatedReadRoutes(): string[] {
  const all = gatedReadRoutesIn(readFileSync(SERVER_API_INDEX, 'utf8'))
  return all.filter((route) => !DELIBERATELY_EXCLUDED_GATED_READS.has(route)).sort()
}

describe('every mutating module has a contract test (prd-24 ruling 2)', () => {
  it('the web law still declares the routes this law expects — the two enumerations cannot drift', () => {
    const declared = declaredRoutes()

    // Exact equality, both directions: a route added to MUTATING_MODULES with
    // no row here fails, and a stale row here whose route left the law fails.
    expect(declared).toEqual(EXPECTED.map((e) => e.route).sort())
    expect(declared.length).toBe(EXPECTED.length)
  })

  /**
   * Widened for the read axis (#61, prd-29 w3): every `.contract.test.ts` file
   * in this directory is now accounted for by the UNION of both axes' own
   * enumerations, not the write side alone — a file present that neither
   * `EXPECTED` nor `EXPECTED_READS` names is exactly as unexpected as it was
   * before this widened, and a route named in either axis with no file here
   * still fails. This is the one check both axes share; each axis's OWN
   * route <-> file equality is asserted separately (this block for writes, the
   * read axis's own `describe` below for reads).
   */
  it('every expected contract test exists in this package, and nothing here is unexpected — across both axes', () => {
    const present = readdirSync(HERE)
      .filter((f) => f.endsWith('.contract.test.ts'))
      .sort()
    const expectedAcrossBothAxes = [...EXPECTED.map((e) => e.contractTest), ...EXPECTED_READS.map((e) => e.contractTest)].sort()

    expect(present).toEqual(expectedAcrossBothAxes)
    expect(present.length).toBe(expectedAcrossBothAxes.length)
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

/**
 * THIS LAW'S BLIND SPOT: `vite dev` is not proven here. This law's harness
 * boots the real `buildApp` and serves a real, stamped shell via `app.inject`
 * — every assertion below is true of the packaged app. `vite dev` serves
 * `index.html` itself, with neither the capability meta tag nor the cookie
 * stamped in (ADR-0012's recorded dev-mode gap), so there is no token for an
 * inject-backed oracle to witness being delivered or withheld there at all. A
 * green suite here is coverage of the shipped app, not of dev mode — recorded,
 * not ruled, exactly as prd-23/prd-29's open questions leave it.
 */
describe('every gated-read route has a contract test (prd-29 w3, #61) — the read axis joins the write side\'s law', () => {
  it('/api/stream is the one gated-read this law does not cover, named rather than silently dropped', () => {
    const allGatedReads = gatedReadRoutesIn(readFileSync(SERVER_API_INDEX, 'utf8'))

    // Every gated-read row ROUTE_CLASSES declares today — the un-filtered
    // parse, before this law's own deliberate exclusion is applied. A
    // fifteenth row added tomorrow (covered or not) moves this floor, which
    // is the point: the number is derived from the parse, never hardcoded as
    // a vacuity floor ruling 3 forbids.
    expect(allGatedReads.length).toBeGreaterThan(0)
    expect(allGatedReads).toHaveLength(14)

    const excludedByThisLaw = allGatedReads.filter((route) => !declaredGatedReadRoutes().includes(route))
    expect(excludedByThisLaw).toEqual(['/api/stream'])
  })

  it('the server route table still declares exactly the 13 gated-read routes this law expects — the two enumerations cannot drift', () => {
    const declared = declaredGatedReadRoutes()

    // Exact equality, both directions: a `gated-read` route added to
    // ROUTE_CLASSES with no row here fails, and a stale row here whose route
    // left ROUTE_CLASSES (or was demoted to a different routeClass) fails too.
    expect(declared).toEqual(EXPECTED_READS.map((e) => e.route).sort())
    expect(declared.length).toBe(EXPECTED_READS.length)
  })

  /**
   * The write-side "filename is not coverage" case applies here too, branched
   * by {@link EXPECTED_READS}' own `refusalShape` — a mutating call's refusal
   * always throws (the client never returns a half-answer for a write it
   * didn't make), but a read's refusal can equally be an honest "absent"
   * value the client swallows rather than a thrown error. A test file named
   * `swallows` has to prove that shape actually happened — a filename alone,
   * or a mis-shaped assertion, is exactly as vacuous here as the write side's
   * placeholder-file gap.
   */
  it('each named read file really is a contract test, its refusal proven in the shape its row declares', () => {
    for (const { route, module, contractTest, refusalShape } of EXPECTED_READS) {
      const source = readFileSync(path.join(HERE, contractTest), 'utf8')

      expect(source, `${contractTest} never builds the shared harness`).toContain('buildContractHarness')
      expect(source, `${contractTest} never calls through h.fetch`).toContain('h.fetch')

      // The SPECIFIC module this row names, not merely "some @rhizomorph/web
      // client" — the read axis's enumeration is per-module, so the check can
      // hold the test to the exact one it claims to cover.
      const specifier = `@rhizomorph/web/${module.replace(/\.ts$/, '')}`
      expect(source, `${contractTest} never imports from ${specifier}`).toContain(`from '${specifier}'`)

      if (refusalShape === 'throws') {
        expect(source, `${contractTest} never exercises a refusal via rejects.toThrow`).toMatch(/rejects\.toThrow/)
      } else {
        // The swallow shape: `rejects.toThrow` never fires (the client resolves
        // to an absent/error VALUE, not a throw), so coverage instead requires
        // (1) both the tamper and the strip helpers actually invoked, and (2) a
        // DIRECT `h.app.inject` 401 check on the same route — the one thing
        // that proves the server really refused, since the client's own return
        // value alone cannot distinguish "the gate refused" from "the server
        // had nothing to say".
        expect(source, `${contractTest} never tampers the token`).toMatch(/tamperCapabilityToken\(\)/)
        expect(source, `${contractTest} never strips the token`).toMatch(/stripCapabilityToken\(\)/)
        expect(source, `${contractTest} never checks the server's own response directly`).toContain('h.app.inject(')
        expect(source, `${contractTest} never asserts a direct 401`).toContain('401')
      }
      expect(route).toMatch(/^\/api\//)
    }
  })

  it('the read-axis parser actually parses — the gated-read literal is picked out of a table that also carries its three siblings', () => {
    // Runs the SAME `gatedReadRoutesIn` the law uses, not a re-implemented
    // copy — the same discipline `routesIn`'s own self-test above holds.
    //
    // The sample is `ROUTE_CLASSES`' own shape: all four route classes
    // interleaved, so a regex that over-matches (picks up a `gated-mutation`,
    // `ungated-mutation` or plain `read` row sitting beside a `gated-read` one
    // in the same array literal) fails here rather than silently passing on a
    // real file that happens to keep every `gated-read` row contiguous.
    const sample =
      "export const ROUTE_CLASSES: readonly RouteClassification[] = [\n" +
      "  { method: 'POST', url: '/api/label', routeClass: 'gated-mutation' },\n" +
      "  { method: 'POST', url: '/v1/metrics', routeClass: 'ungated-mutation' },\n" +
      "  { method: 'GET', url: '/api/sessions', routeClass: 'gated-read' },\n" +
      "  { method: 'GET', url: '/*', routeClass: 'read' },\n" +
      "  { method: 'GET', url: '/api/lanes', routeClass: 'gated-read' },\n" +
      "]"

    expect(gatedReadRoutesIn(sample)).toEqual(['/api/lanes', '/api/sessions'])
  })
})
