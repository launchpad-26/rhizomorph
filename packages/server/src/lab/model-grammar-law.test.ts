import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE MODEL GRAMMAR MAY NOT DRIFT (#405, from #234).
 *
 * `MODEL_GRAMMAR` is declared twice — `lab/fork.ts` and `api/lab.ts` — and
 * that duplication is deliberate: `lab/namespace-law.test.ts` forbids
 * `api/lab.ts` importing anything under `server/src/lab/`, so there is no
 * module both sides may reach. Duplication is the accepted mitigation, the
 * same one ADR-0012 records for the capability header's identical split.
 *
 * The mitigation only works if BOTH copies are pinned. #234's PR claimed they
 * were; they were not. `api/lab.test.ts` pinned its copy, `fork.test.ts`
 * pinned nothing, and widening only the `fork.ts` copy to admit `/` — the
 * exact change #234's own open item contemplates for Bedrock ARNs — left all
 * 59 tests green.
 *
 * Per-file literal tests are necessary and not sufficient: two files can
 * each stay green while diverging in some character neither test thought to
 * try. Only a law comparing the copies to each other catches that, so this
 * is that law.
 *
 * Grep-style over real source text, no AST — deliberately as legible as the
 * readonly and namespace laws it sits beside. Three assertions, and the third
 * is the one that stops the law itself from rotting: the set of declaring
 * files is asserted EXACTLY, so a third copy appearing anywhere under
 * `server/src` fails here until someone adds it on purpose. A law that
 * matched zero files would otherwise pass forever (ruling 5; this repo has
 * had two laws walk vacuously already).
 */

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A `const MODEL_GRAMMAR = …` declaration and whatever it is assigned,
 * captured to end of line. `export` is optional so a local shadow copy is
 * caught too, not just an exported one.
 *
 * Deliberately NOT restricted to a regex literal. An earlier version of this
 * law matched only `= /…/flags`, which meant a third copy written in the
 * equally valid `new RegExp('…')` form was invisible to it — the file simply
 * did not appear in the set, so the exact-set assertion below stayed green
 * and the third-copy alarm never fired. Verified by execution before this was
 * widened: a third declaration in `new RegExp` form left all three tests here
 * passing. Capturing the whole right-hand side means every declaration is
 * seen first and judged second, which is the order that cannot fail open.
 *
 * Capturing to end of line also fixes a narrower defect: the old pattern's
 * body could not cross an unescaped `/`, which needs no escape inside a
 * character class — so widening the grammar to `/^[A-Za-z0-9._:/-]+$/` would
 * have captured a truncated `/^[A-Za-z0-9._:/` and reported text the file
 * does not contain, in exactly the scenario the law exists for.
 */
const DECLARATION = /(?:export\s+)?const\s+MODEL_GRAMMAR\s*=\s*(.+)$/gm

/**
 * A regex literal and nothing else — the one form both copies must use.
 *
 * Deliberately loose about the body: its job is to tell a literal apart from
 * `new RegExp('…')` or an imported identifier, not to parse regex grammar. A
 * stricter body is how the first draft of this constant reproduced the very
 * bug above it — `(?:[^/\\\n]|\\.)+` cannot cross the unescaped `/` that is
 * legal inside a character class, so it rejected the real Bedrock-widened
 * literal `/^[A-Za-z0-9._:/-]+$/` it was meant to accept.
 */
const REGEX_LITERAL = /^\/.+\/[gimsuy]*;?$/

/** Every file under `server/src` that declares the grammar, with the literal it declares. */
function declarations(): Array<{ file: string; literal: string }> {
  const found: Array<{ file: string; literal: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      // Source only. Tests are excluded because they legitimately quote the
      // grammar (this file's own extractor check quotes two of them), and a
      // law that counted those would be counting itself.
      if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue
      for (const match of readFileSync(full, 'utf8').matchAll(DECLARATION)) {
        const literal = match[1]?.trim()
        // `path.sep` so the expected set below reads the same on the
        // windows-latest leg (prd-25's named CI gap) as it does on ubuntu —
        // `path.relative` yields `api\lab.ts` there, and a law that goes red
        // over a separator takes typecheck, lint and the boot smoke down with
        // it, since a failed Test step skips every later step on the leg.
        if (literal !== undefined) {
          found.push({ file: path.relative(SERVER_SRC, full).split(path.sep).join('/'), literal })
        }
      }
    }
  }
  walk(SERVER_SRC)
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * The two copies that are allowed to exist, and why each one is where it is.
 * Adding a third is a decision, not an accident — so it fails this law until
 * it is made here explicitly.
 */
const EXPECTED_DECLARING_FILES = ['api/lab.ts', 'lab/fork.ts']

describe('MODEL_GRAMMAR may not drift between its two copies (#405)', () => {
  it('is declared in exactly the two files the namespace law forces it to be', () => {
    const files = declarations().map((d) => d.file)

    // Asserted as a set AND as a count. The count is not redundant: it is what
    // fails loudly if this law is ever pointed at a tree where it matches
    // nothing, rather than quietly agreeing that [] equals [].
    expect(files).toEqual(EXPECTED_DECLARING_FILES)
    expect(files).toHaveLength(2)
  })

  it('declares byte-identical regex literals in both', () => {
    const found = declarations()
    const literals = new Set(found.map((d) => d.literal))

    expect(
      [...literals],
      `the two copies have drifted: ${found.map((d) => `${d.file} declares ${d.literal}`).join(', ')}`,
    ).toHaveLength(1)
  })

  /**
   * Both copies must stay a plain regex literal. This is what keeps the
   * comparison above honest: `new RegExp('^[A-Za-z0-9._:-]+$')` is the same
   * grammar semantically but a different string, so a mixed-form pair would
   * read as drift, and — before the matcher was widened — a third copy in
   * that form was not seen at all. Requiring one canonical form makes the
   * set assertion and the identity assertion mean what they say.
   */
  it('spells both copies as a regex literal, the one form this law can compare', () => {
    for (const { file, literal } of declarations()) {
      expect(literal, `${file} declares MODEL_GRAMMAR as something other than a regex literal: ${literal}`).toMatch(
        REGEX_LITERAL,
      )
    }
  })

  /**
   * The law's own mutation test. Without this, a `DECLARATION` regex that
   * silently stopped matching would turn both assertions above green forever
   * — the failure mode this file exists to prevent, reappearing one level up.
   */
  it('the extractor actually extracts — it does not pass by matching nothing', () => {
    const sample =
      "export const MODEL_GRAMMAR = /^[A-Za-z0-9._:-]+$/\nconst OTHER = /x/\nconst MODEL_GRAMMAR = /^[a-z]+$/g\n"
    const literals = [...sample.matchAll(DECLARATION)].map((m) => m[1]?.trim())

    expect(literals).toEqual(['/^[A-Za-z0-9._:-]+$/', '/^[a-z]+$/g'])
    // And it really is reading the tree, not a fixture: the live extraction
    // finds a literal that admits a dot and a colon (the bedrock case) and
    // refuses a slash.
    const live = declarations()[0]?.literal
    expect(live).toBeDefined()
    expect(new RegExp(live?.slice(1, live.lastIndexOf('/')) ?? '').test('us.anthropic.claude-3-5-v1:0')).toBe(true)
    expect(new RegExp(live?.slice(1, live.lastIndexOf('/')) ?? '').test('anthropic/claude')).toBe(false)
  })

  /**
   * The specific escape this law failed to catch until it was widened, kept
   * as a permanent regression test rather than a note. `new RegExp('…')` is a
   * legal, equivalent way to declare the grammar — so the matcher must SEE
   * it (and the regex-literal test above is then what refuses it), rather
   * than silently not counting it as a declaration at all.
   */
  it('sees a declaration written as new RegExp, rather than not counting it', () => {
    const sample = "export const MODEL_GRAMMAR = new RegExp('^[A-Za-z0-9._:/-]+$')\n"
    const captured = [...sample.matchAll(DECLARATION)].map((m) => m[1]?.trim())

    expect(captured).toEqual(["new RegExp('^[A-Za-z0-9._:/-]+$')"])
    expect(captured[0]).not.toMatch(REGEX_LITERAL)
  })

  /**
   * The other old blind spot: a slash needs no escape inside a character
   * class, and the previous matcher's body could not cross one, so it
   * captured a truncated literal and reported text the file did not contain.
   */
  it('captures a literal containing an unescaped slash whole, not truncated', () => {
    const sample = 'export const MODEL_GRAMMAR = /^[A-Za-z0-9._:/-]+$/\n'
    const captured = [...sample.matchAll(DECLARATION)].map((m) => m[1]?.trim())

    expect(captured).toEqual(['/^[A-Za-z0-9._:/-]+$/'])
    expect(captured[0]).toMatch(REGEX_LITERAL)
  })
})
