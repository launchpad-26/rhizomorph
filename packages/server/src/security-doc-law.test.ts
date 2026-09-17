import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #561's law — `SECURITY.md`'s team-server boundary names the identifiers the
 * team server actually serves, and a rename reddens.
 *
 * ## Why this law exists at all
 *
 * `doc-citation-law.test.ts` already sweeps every tracked markdown file for
 * backticked repo-rooted PATHS and for `#NNN` citations above the live tracker
 * maximum. It has no notion of a SYMBOL. So a constant can be renamed, or its
 * value changed, and every document that quotes that value keeps saying the old
 * thing with the whole suite green — a lying document behind a green bar, which
 * is the exact failure shape this repository keeps paying for in other forms
 * (`AGENTS.md`'s line-number citations; `.swarm/coupling.txt`'s quoted
 * enumeration; `docs/adr/0035-the-watcher-is-never-a-container.md`'s wave
 * digit).
 *
 * `SECURITY.md` is where that would cost the most. It is the document a person
 * reads to learn what leaves their machine, and since prd-51 it describes a real
 * outbound path rather than promising there is none. Three machine-checkable
 * identifiers carry the weight of that description — the route a batch is POSTed
 * to, the header the ingest key rides in, and the prefix every ingest key
 * begins with — and all three are declared in `packages/team/`, on the other
 * side of a package boundary no test crossed before this one.
 *
 * ## What it does NOT pin, said plainly rather than implied
 *
 * The sentences around those identifiers — "membership is the boundary", "the
 * two identity planes never fuse", "a revoked key is refused within one batch" —
 * are pinned as BEHAVIOUR by tests that already exist next to that behaviour
 * (`packages/team/src/auth/membership.ts`'s suite, the ingest key gate in
 * `packages/team/src/api/`, `packages/team/src/keys/`). Nothing pins that
 * `SECURITY.md` still SAYS them, and this law does not pretend to: prose is
 * prose. What it pins is the three values, which are exactly the part a
 * refactor can silently invalidate.
 *
 * ## Shape
 *
 * Grep-law style, matching the laws it sits beside (`runbook-delivery-law`,
 * `docs-index-law`, `adr-log-law`): real files, no mocks, and it reads
 * `packages/team/`'s source as TEXT rather than importing it. That is
 * deliberate and is the reason this file is here rather than under
 * `packages/team/src/api/`. `packages/server` does not depend on
 * `@rhizomorph/team` and this law does not make it — a law that holds a
 * document should not be able to change a package graph — and two lanes were
 * live against `packages/team/src/api/` when this was written, so a file there
 * would have been a scheduled rebase conflict for no gain.
 *
 * It lives under `packages/server/` rather than at the repo root for the reason
 * `runbook-delivery-law.test.ts` records: the root vitest config globs
 * `packages/*`, so a root-level test would never run and would be its own
 * vacuous law.
 *
 * Half the tests below exist to prove the detector bites. A law of the shape
 * "this string appears in that document" passes vacuously the moment its own
 * extractor stops extracting — it would find nothing, compare nothing, and
 * report green.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const SECURITY_DOC = 'SECURITY.md'

/**
 * CRLF is normalised on every read, and that is not defensive noise.
 *
 * A literal comparison against a markdown file's bytes passes on macOS and
 * Linux and reddens only on the `windows-suite` leg, where a checkout can
 * deliver `\r\n`. The failure arrives days later, on the one leg nobody runs
 * locally, attributed to whatever landed most recently. Normalising here costs
 * one `replaceAll` and removes the whole class.
 */
function readNormalised(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8').replaceAll('\r\n', '\n')
}

/**
 * The single-quoted string value of `export const <name> = '…'` in a piece of
 * TypeScript source, or `undefined` if that declaration is not there.
 *
 * Deliberately anchored on `export const <name> =` rather than on the name
 * alone: `INGEST_KEY_PREFIX` appears half a dozen times in its own module as a
 * USE, and a detector that matched a use would keep passing after the
 * declaration was deleted, which is the vacuity this law is trying not to have.
 *
 * One definition, used by both the assertions and the rigged-input tests below.
 * Two copies of a regex is how a rigged test comes to prove a regex the
 * assertion does not use (`runbook-delivery-law.test.ts` records the same
 * reasoning).
 */
function declaredStringConst(source: string, name: string): string | undefined {
  const pattern = new RegExp(`^export const ${name} = '([^']*)'`, 'm')
  return pattern.exec(source)?.[1]
}

/**
 * The declared value, or a throw naming the file and the symbol.
 *
 * A rename must fail LOUDLY here rather than quietly returning `undefined` and
 * letting an `expect(doc).toContain(undefined)` produce some unrelated message.
 * The remedy a reader needs is "the constant moved, and `SECURITY.md` quotes
 * its old value" — so the error says that.
 */
function requireDeclaredStringConst(sourceRelPath: string, name: string): string {
  const value = declaredStringConst(readNormalised(sourceRelPath), name)
  if (value === undefined) {
    throw new Error(
      `${sourceRelPath} no longer declares \`export const ${name} = '…'\`. ` +
        `${SECURITY_DOC} quotes that constant's value to describe what leaves the machine — ` +
        'if it was renamed or moved, update this law and re-check the document against the new value.',
    )
  }
  return value
}

/** Every identifier `SECURITY.md` quotes to describe the outbound boundary, with the declaration that owns it. */
const PINNED = [
  {
    what: 'the route a batch is POSTed to',
    name: 'INGEST_PATH',
    source: 'packages/team/src/api/http.ts',
  },
  {
    what: 'the header the ingest key rides in',
    name: 'INGEST_KEY_HEADER',
    source: 'packages/team/src/ingest/handle.ts',
  },
  {
    what: 'the prefix every ingest key begins with',
    name: 'INGEST_KEY_PREFIX',
    source: 'packages/team/src/keys/shape.ts',
  },
] as const

describe("security-doc law: SECURITY.md's team-server boundary quotes the team server's own constants (#561)", () => {
  for (const { what, name, source } of PINNED) {
    it(`names ${what} — the value of \`${name}\`, derived from ${source} and never typed here`, () => {
      const declared = requireDeclaredStringConst(source, name)

      /**
       * A TRAILING BOUNDARY, not a bare substring — found at verification of #561.
       *
       * `toContain` passes on a value CORRUPTED BY APPENDING: a document saying `rzk_WRONG`
       * contains `rzk_`, so the assertion that exists to catch a drifted constant would not.
       *
       * Requiring the whole backtick span does not work either, and the reason is worth keeping:
       * the document writes `` `POST /v1/rhizomorph/ingest` ``, so the path is a PART of a span
       * rather than the whole of one. What actually distinguishes a quote from a corruption is
       * what follows it — a real quote is followed by a backtick or punctuation, an appended
       * corruption by another identifier character.
       */
      const escaped = declared.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
      const boundary = new RegExp(`(?<![A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-])`)
      expect(
        readNormalised(SECURITY_DOC),
        `${SECURITY_DOC} does not contain "${declared}" as a whole token, the value ${source} ` +
          `declares for ${name}. Either the constant changed and the document is now wrong, the ` +
          'sentence that quoted it was removed, or the document carries a LONGER token that merely ' +
          'starts with it — which is the corruption a bare substring check would have missed.',
      ).toMatch(boundary)
    })
  }

  it('the document still describes an outbound path at all — the sentence the three values hang on', () => {
    // Without this, deleting the whole section would leave three assertions
    // passing on incidental matches elsewhere in a 350-line document.
    expect(readNormalised(SECURITY_DOC)).toContain('## The shipper and the team server')
  })
})

describe('security-doc law: the detector bites (#561)', () => {
  it('extracts the value from a real declaration', () => {
    expect(declaredStringConst("export const INGEST_PATH = '/v1/rhizomorph/ingest'\n", 'INGEST_PATH')).toBe(
      '/v1/rhizomorph/ingest',
    )
  })

  it('does not mistake a USE of the symbol for its declaration — the vacuity a name-only match would buy', () => {
    // Shaped after `packages/team/src/keys/shape.ts`'s real body: the symbol is
    // used, and a single-quoted string sits further down the module. A detector
    // that matched the NAME rather than the DECLARATION would read that
    // unrelated literal as the constant's value and report green forever, which
    // is why the fixture carries one. EXECUTED: loosening the regex to a
    // name-only match reddens this case.
    const source = [
      'if (!value.startsWith(INGEST_KEY_PREFIX)) return false',
      'const label = `${INGEST_KEY_PREFIX}…`',
      "throw new Error('that is not an ingest key')",
    ].join('\n')
    expect(declaredStringConst(source, 'INGEST_KEY_PREFIX')).toBeUndefined()
  })

  it('does not match an indented or re-exported declaration it was not written to read — it returns undefined, and the caller throws rather than guessing', () => {
    expect(declaredStringConst("  export const INGEST_PATH = '/nested'\n", 'INGEST_PATH')).toBeUndefined()
    expect(() => requireDeclaredStringConst('packages/team/src/api/http.ts', 'NOT_A_REAL_CONSTANT')).toThrow(
      /no longer declares/,
    )
  })

  it('reports a document that has lost the value, rather than passing over it', () => {
    // The mechanism, on rigged input, so this stays true when the real values change.
    const declared = declaredStringConst("export const INGEST_KEY_HEADER = 'x-rz-ingest-key'\n", 'INGEST_KEY_HEADER')
    expect(declared).toBe('x-rz-ingest-key')
    expect('a document that never mentions the header').not.toContain(declared as string)
  })

  it('normalises CRLF, so a Windows checkout compares the same bytes every other leg does', () => {
    expect(declaredStringConst("export const INGEST_PATH = '/v1/x'\r\n".replaceAll('\r\n', '\n'), 'INGEST_PATH')).toBe(
      '/v1/x',
    )
  })
})
