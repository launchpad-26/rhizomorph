import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ComparisonArtifactError, parseComparisonArtifact } from './artifact.js'

/**
 * THE TRIPWIRE ADR-0042 NAMED AS MISSING (#376). Its own Consequences say
 * the only guard against the two copies drifting is the version-refusal
 * string, tested on each side separately — nothing compared what the two
 * parsers actually DO with the same bytes, which is exactly how the
 * run-vocabulary drift (`verdict`, `note`, `detail`, the retired `failed`
 * status) reached `main` green.
 *
 * This is that comparison. One fixture set —
 * `packages/contract/src/fixtures/comparison-artifact/cases.json` — read
 * here and by its counterpart, `packages/server/src/comparisons/parser-
 * agreement-law.test.ts`. Neither file imports the other package's source
 * (the constraint ADR-0042 rests on); each reads the same bytes off disk by
 * relative path, the way `floor-agreement-law.test.ts` (this directory's
 * parent) already reaches across a package boundary without a cross-package
 * import.
 *
 * A refusal case is checked by the exact message AND the exact error class,
 * `ComparisonArtifactError` — not merely that *some* `Error` was thrown.
 * Round-1 verify (#376) found this the hard way: `store.ts`/`api/lab.ts`
 * both use `instanceof ComparisonArtifactError` to turn a refusal into
 * `kind: 'refused'` / a 400, so a mutation that changes the thrown class
 * alone (message untouched) passed this file at 30/30 while
 * `readComparison` started *throwing* instead of returning a refusal, and
 * `listComparisons` lost its entire listing rather than one `available:
 * false` row — the exact "saved with a 200, unreadable forever" failure
 * this issue exists to close, re-entering through the class instead of the
 * message.
 *
 * Every accept case also asserts `version`/`savedAt` passthrough against
 * the raw JSON's own values, not only `.input` — round-1 verify's
 * contributing-mechanism note: a law that reads only `.input` cannot see a
 * bug that clips or rewrites the artifact's other two fields.
 *
 * THREE AXES, ENUMERATED — round-2 verify (#376) found the class-pin above
 * was only as complete as the fixture's REACH, not by design, and asked for
 * the axes to be named rather than patched cell by cell again. Round 3 found
 * that the file then enumerated TWO axes under that heading, and that the
 * second one's claim was wider than what it checked; both are settled below.
 *
 * AXIS A — message + class, PER FIXTURE CASE. For every case the shared
 * fixture actually carries, do both parsers accept/refuse identically — same
 * outcome, same message, same `ComparisonArtifactError` class? Hand-authored:
 * each fixture row names its own expected message; `expectRefusal` below
 * checks the class against every one of them uniformly.
 *
 * AXIS B — THROW-SITE COVERAGE, DERIVED from source, not hand-listed. For
 * every `ComparisonArtifactError` construction site that exists in THIS
 * package's `artifact.ts`, is it exercised by at least one fixture case?
 * Axis A is only as strong as axis B: three sites — `run is missing id`,
 * `run is not a JSON object`, `arm is not a JSON object` — were invisible to
 * the class-pin because no fixture row ever reached them; a class-swap
 * mutation there passed 46/46. `extractThrowSites` (below) reads
 * `artifact.ts`'s own text and finds every `new ComparisonArtifactError(`
 * call, so a throw site added to the parser without a matching fixture case
 * reddens the day it is added, rather than silently widening the blind spot
 * the way a hand-maintained list of "known throw sites" would — the list of
 * sites is derived at test-collection time, not asserted from memory.
 *
 * AXIS B IS UNAMBIGUOUS OR IT IS NOTHING (round-3 verify, #376). A site was
 * "exercised" if SOME refuse fixture's message matched its shape — and
 * matching is not throwing. Two sites can share a shape, so a new site whose
 * message collides with an existing one was credited by the existing one's
 * fixture and never ran. Measured on `d39383ac`, three unreachable sites
 * added to `parseRun`, each passing this file at 42/42:
 *
 *   'run is missing id' + String(record.length)   // scanner keeps the literal
 *   `run ${record.length} is missing id`          // interpolation as wildcard
 *   `${String(record.length)}`                    // matches EVERY message
 *
 * So the credit must be injective: every refuse fixture matches exactly one
 * site. All three reddened once it was, and the tree was already injective
 * before the change — 14 sites, 20 refuse messages, 0 ambiguous, on both
 * sides — so this pins what was true rather than forcing a fixture rewrite.
 *
 * AXIS C — the scan's SCOPE, pinned rather than assumed. Axis B reads
 * `artifact.ts` and nothing else, so a throw relocated into a helper beside
 * it is invisible: the site stops being "coverage required" without ever
 * being "coverage failed" (EXECUTED in round 3's verify — the law stayed
 * green at 41/41 with a reachable throw moved into a new sibling module).
 * Axis C asserts the module's construction sites all live in `artifact.ts`,
 * so relocating one reddens instead of hiding.
 *
 * WHAT IS STILL NOT CAUGHT, stated rather than hidden:
 *
 * - A mutation that changes a site's CLASS but not its message removes that
 *   occurrence from the source scan (`extractThrowSites` matches the literal
 *   text `new ComparisonArtifactError(`), so the site stops looking like
 *   "coverage required" rather than "coverage failed". That mutation is
 *   still caught, but by axis A's per-case check on whichever fixture row
 *   reaches the site — which is exactly why axis B's job is to guarantee
 *   every site HAS such a row, not to detect the class swap itself.
 * - The marker appearing inside a COMMENT or a string in `artifact.ts` is
 *   scanned as a real site. That is a false positive, not a blind spot: it
 *   surfaces as an uncovered site and goes red, loudly.
 * - An interpolation containing its own `{` or `}` truncates the fragment,
 *   as the scanner's own comment says.
 *
 * Together: every construction site in this module is in `artifact.ts`
 * (C), every site there is matched by a refuse fixture (B), and every refuse
 * fixture names exactly one site (B's injectivity) — so "matched" means
 * "thrown by", which is what axis A needs to have something to bite on.
 */

interface FixtureCase {
  name: string
  outcome: 'accept' | 'refuse'
  message?: string
  expected?: unknown
  raw: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_PATH = path.resolve(HERE, '..', '..', '..', '..', 'contract', 'src', 'fixtures', 'comparison-artifact', 'cases.json')
const CASES: FixtureCase[] = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'))

/** The one text both the site scan and axis C look for, named once so they cannot drift apart. */
const THROW_SITE_MARKER = 'new ComparisonArtifactError('

/**
 * Every `new ComparisonArtifactError(<arg>)` call site in `artifact.ts`'s own
 * text, returned as the raw source of `<arg>` — a plain string with its
 * quotes stripped, or a template literal with each `${...}` span kept
 * VERBATIM (not evaluated) so the site stays generic across whatever `id` or
 * `status` a real call receives. `<arg>` is always exactly one string or
 * template literal in this file today; a future site that passes something
 * else (a second argument, a computed expression as the whole argument)
 * throws here rather than silently mis-parsing, which is the point — this
 * function must fail loudly the day it stops matching reality, not report a
 * confidently wrong site list.
 */
function extractThrowSites(source: string): string[] {
  const marker = THROW_SITE_MARKER
  const sites: string[] = []
  let idx = 0
  while (true) {
    const start = source.indexOf(marker, idx)
    if (start === -1) break
    let i = start + marker.length
    while (/\s/.test(source[i] ?? '')) i++
    const opener = source[i]
    let raw: string
    if (opener === "'" || opener === '"') {
      i++
      let text = ''
      while (source[i] !== opener) {
        if (source[i] === undefined) throw new Error(`extractThrowSites: unterminated string starting at offset ${start}`)
        if (source[i] === '\\') {
          text += source[i]! + (source[i + 1] ?? '')
          i += 2
          continue
        }
        text += source[i]
        i++
      }
      raw = text
      i += 1
    } else if (opener === '`') {
      i++
      let text = ''
      while (source[i] !== '`') {
        if (source[i] === undefined) throw new Error(`extractThrowSites: unterminated template literal starting at offset ${start}`)
        if (source[i] === '\\') {
          text += source[i]! + (source[i + 1] ?? '')
          i += 2
          continue
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          let j = i + 2
          // No interpolation in this file nests a brace of its own (`${id}`,
          // `${String(status)}`) — this scan finds the first `}` and stops
          // there. A future site whose interpolation contains `{`/`}` would
          // truncate here; the sanity check below (site count > 0, and every
          // extracted site round-trips through `siteFragments` without
          // throwing) is what would surface that as a loud failure rather
          // than a silently wrong fragment.
          while (source[j] !== '}') {
            if (source[j] === undefined) throw new Error(`extractThrowSites: unterminated interpolation starting at offset ${i}`)
            j++
          }
          text += source.slice(i, j + 1)
          i = j + 1
          continue
        }
        text += source[i]
        i++
      }
      raw = text
      i += 1
    } else {
      throw new Error(`extractThrowSites: unexpected argument opener ${JSON.stringify(opener)} at offset ${i} — this file's throw sites are no longer all single string/template-literal arguments`)
    }
    // The argument must be that ONE literal and nothing else. `'lit' + expr`
    // and a second argument both leave the scan here with `raw` holding a
    // silent truncation of the real message — round-3 verify's first
    // mutation was exactly that, and the docblock above already promised
    // this function fails loudly rather than mis-parsing. It now does.
    let after = i
    while (/\s/.test(source[after] ?? '')) after++
    // A TRAILING comma is the prettier-wrapped spelling of the same one
    // argument — `(\n  `…`,\n)` — and three of this file's own sites are
    // written that way. It is only a second argument if something other
    // than `)` follows it, which the check below still catches.
    if (source[after] === ',') {
      after++
      while (/\s/.test(source[after] ?? '')) after++
    }
    if (source[after] !== ')') {
      throw new Error(
        `extractThrowSites: the argument at offset ${start} is followed by ${JSON.stringify(source[after])}, not ')' — this site's message is built from more than one literal, so the text extracted here would be a silent truncation of it`,
      )
    }
    sites.push(raw)
    idx = i
  }
  return sites
}

/** Splits a throw site's raw text on its `${...}` spans, so a rendered message can be matched without evaluating the expressions. */
function siteFragments(raw: string): string[] {
  const fragments: string[] = []
  let i = 0
  let current = ''
  while (i < raw.length) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      fragments.push(current)
      current = ''
      let j = i + 2
      while (raw[j] !== '}') j++
      i = j + 1
      continue
    }
    current += raw[i]
    i++
  }
  fragments.push(current)
  return fragments
}

/** True iff `message` could have been rendered by the site `fragments` came from — the static text matches, in order, whatever the interpolations were. */
function matchesSite(message: string, fragments: string[]): boolean {
  if (fragments.length === 1) return message === fragments[0]
  const first = fragments[0] ?? ''
  const last = fragments[fragments.length - 1] ?? ''
  if (!message.startsWith(first) || !message.endsWith(last)) return false
  let cursor = first.length
  for (let k = 1; k < fragments.length - 1; k++) {
    const frag = fragments[k] ?? ''
    const at = message.indexOf(frag, cursor)
    if (at === -1) return false
    cursor = at + frag.length
  }
  return true
}

function expectRefusal(raw: string, message: string): void {
  let thrown: unknown
  try {
    parseComparisonArtifact(raw)
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected parseComparisonArtifact to throw ComparisonArtifactError').toBeInstanceOf(ComparisonArtifactError)
  expect((thrown as Error).message).toBe(message)
}

describe('the web parser agrees with the shared comparison-artifact fixtures', () => {
  it('the fixture set is not empty — an empty file would pass every case below vacuously', () => {
    expect(CASES.length).toBeGreaterThan(0)
  })

  it('the fixture set carries at least one accept case and one refuse case', () => {
    expect(CASES.some((c) => c.outcome === 'accept')).toBe(true)
    expect(CASES.some((c) => c.outcome === 'refuse')).toBe(true)
  })

  for (const testCase of CASES) {
    it(testCase.name, () => {
      if (testCase.outcome === 'accept') {
        const artifact = parseComparisonArtifact(testCase.raw)
        const rawParsed = JSON.parse(testCase.raw) as { version: unknown; savedAt: unknown }
        expect(artifact.version, 'version passthrough').toBe(rawParsed.version)
        expect(artifact.savedAt, 'savedAt passthrough').toBe(rawParsed.savedAt)
        expect(artifact.input).toEqual(testCase.expected)
      } else {
        if (testCase.message === undefined) throw new Error(`fixture "${testCase.name}" is a refuse case with no message`)
        expectRefusal(testCase.raw, testCase.message)
      }
    })
  }
})

// --- axis B: throw-site coverage, derived from this package's own artifact.ts ---

const ARTIFACT_SOURCE = readFileSync(path.join(HERE, 'artifact.ts'), 'utf8')
const THROW_SITES = extractThrowSites(ARTIFACT_SOURCE)
const REFUSE_MESSAGES = CASES.filter((c) => c.outcome === 'refuse').map((c) => c.message).filter((m): m is string => m !== undefined)

describe('every ComparisonArtifactError throw site in this package\'s artifact.ts is exercised by the shared fixture', () => {
  it('at least one throw site was found — a parser with none would pass every case below vacuously', () => {
    expect(THROW_SITES.length).toBeGreaterThan(0)
  })

  for (const site of THROW_SITES) {
    it(`"${site}" is exercised by at least one fixture case`, () => {
      const fragments = siteFragments(site)
      const matched = REFUSE_MESSAGES.some((message) => matchesSite(message, fragments))
      expect(matched, `no fixture case's message matches the throw site: ${site}`).toBe(true)
    })
  }

  // Coverage is only coverage if it is unambiguous: see AXIS B IS UNAMBIGUOUS
  // OR IT IS NOTHING above. A message matching two sites credits both while
  // running one; a message matching none is a fixture expecting a sentence
  // this parser can no longer produce.
  it('every refuse fixture case identifies exactly one throw site — a match is otherwise a shape, not a thrower', () => {
    const notExactlyOne = REFUSE_MESSAGES.map((message) => ({
      message,
      sites: THROW_SITES.filter((site) => matchesSite(message, siteFragments(site))),
    })).filter((row) => row.sites.length !== 1)
    expect(notExactlyOne, 'each refuse fixture must match exactly one throw site').toEqual([])
  })
})

// --- axis C: every construction site in this module lives in artifact.ts ---

describe('this module constructs ComparisonArtifactError in artifact.ts and nowhere else', () => {
  it('no other source file in this directory carries the constructor — axis B reads artifact.ts alone', () => {
    const carriers = readdirSync(HERE)
      .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      .filter((entry) => readFileSync(path.join(HERE, entry), 'utf8').includes(THROW_SITE_MARKER))
      .sort()
    expect(carriers, 'a throw relocated out of artifact.ts is invisible to axis B').toEqual(['artifact.ts'])
  })
})
