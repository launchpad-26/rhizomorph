// packages/core has no `@types/node` in its own tsconfig (state.ts:992 — this
// package stays browser-safe) and every OTHER sibling law here that reads the
// real tree lives in packages/server for exactly that reason. This law can't:
// gaps.ts, and the defect it fixes, both live in core. A file-scoped triple-
// slash reference pulls in Node's ambient types for this one file, without
// widening the package's tsconfig or its "no node:* imports" convention.
/// <reference types="node" />
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Issue #63 — a gap's remedy must name something the operator can reach.
 *
 * `buildGaps` (`gaps.ts`, colocated) speaks in law 12's gap voice: every gap
 * carries a `command` — "run: `<command>`" — that is the exact next action an
 * operator takes. Two of them named `dispatch.sh`, a script that has never
 * existed anywhere in this tree; a reader who searched the repo for it, the
 * way the remedy itself told them to, came away worse off than if the gap had
 * said nothing at all. prd-43 ruling 1's citation law (`doc-citation-law.
 * test.ts`) cannot see this: its own input table scopes it to `packages/**\/
 * *.ts` COMMENTS and explicitly excludes string literals in code — a remedy
 * is exactly that excluded case. This is the law ruling 1 declared it could
 * not write, arriving with a live instance.
 *
 * Scoped to `gaps.ts` alone, not a repo-wide sweep: the defect and the fix
 * both live in one small, stable file, and a law this narrow can read the
 * real `add(...)` calls directly rather than re-deriving `buildGaps`'s output
 * through a full `SessionState`/`Lane`/`LaneManifest` fixture.
 *
 * ## The input table — every way a remedy can carry a path, enumerated
 * before the matcher below was written (`AGENTS.md`: a form not listed is a
 * form not handled — this repo has spent fourteen review rounds across three
 * other matchers learning that the hard way).
 *
 * | Form                                                            | Verdict |
 * |------------------------------------------------------------------|---------|
 * | bare script, no directory (`dispatch.sh`)                        | HANDLED — the live defect this law exists to catch |
 * | with a directory (`docs/user-guide/troubleshooting.md`)          | HANDLED — the fix's own honest remedy cites one |
 * | as a command with trailing arguments (`scripts/dev/x.sh --wave`) | HANDLED — a path is one whitespace-delimited token; the arguments after it split off on their own and are never part of the match |
 * | backticked or parenthesised (`` `dispatch.sh` ``, `(see foo.md)`) | HANDLED — a leading `` ` ``/`(`/`"`/`'` and a trailing `` ` ``/`)`/`"`/`'`/`.`/`,`/`:`/`;` are stripped before the shape check |
 * | trailing punctuation (`dispatch.sh.`, `dispatch.sh,`)            | HANDLED — same strip as above |
 * | a bare command name, no slash, no recognised extension (`rhizomorph`, `doctor`, `eval`) | SKIPPED, deliberately — a claim about an installed binary is not a claim about a repo-relative file, and this law has no way to check a `$PATH` entry; only a token with a directory separator or a recognised script/doc extension is treated as a path claim at all |
 * | an angle-bracket placeholder (`<lane>`, `<dir>:conductor`)       | SKIPPED, deliberately — a template argument, not a literal path the reader is meant to open |
 * | a `.json` data-file name mentioned for context (`.swarm/lanes.json`) | SKIPPED, deliberately — the fix's own honest remedy names the manifest it is explaining, not a location it tells the reader to open; `.json` is excluded from the checked extension set for exactly that reason (verified against the live remedy text below, not just asserted) |
 * | a `file:line` or `file#anchor` suffix                            | N/A — no live instance in this file's remedies; unhandled, unlike `doc-citation-law.test.ts`'s `stripCitationSuffix`, which this law does not need until one appears |
 * | inside a fenced code block / string literal ambiguity            | N/A — `gaps.ts` has no such content; not a concern for a file this small |
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** `gaps.ts` sitting beside this file — resolved from `import.meta.url`, not typed as a string, so a rename can't leave this law reading a stale path. */
const GAPS_FILE_ABS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gaps.ts')
const GAPS_FILE_REL = path.relative(REPO_ROOT, GAPS_FILE_ABS)

/**
 * Every `name(arg0, arg1, ...)` call for `fnName` in `source`, as raw
 * (untrimmed-of-quotes) argument texts, found by counting parens and quotes
 * rather than a regex over the whole call — `gaps.ts`'s own arguments include
 * backtick template literals containing `()` (`` `${x.toUpperCase()}` ``),
 * which a naive "match up to the next `)`" regex would truncate on.
 */
function extractCallArgs(source: string, fnName: string): string[][] {
  const calls: string[][] = []
  // `(?:\\s*\\?\\.\\s*)?` — an OPTIONAL CALL is still a call. `add?.(...)` is
  // valid TypeScript that biome and tsc both accept, and the bare `add\\(`
  // marker skipped it silently: a re-review seat added an executable
  // `add?.(..., 'dispatch.sh')` and all 17 reachability tests stayed green,
  // so a reintroduced dead remedy could evade the very law written to catch
  // it (#63, verify round). Whitespace is allowed only around the `?.`.
  const marker = new RegExp(`\\b${fnName}(?:\\s*\\?\\.\\s*)?\\(`, 'g')
  let found: RegExpExecArray | null
  while ((found = marker.exec(source)) !== null) {
    let i = found.index + found[0].length
    let depth = 1
    let quote: string | null = null
    let argStart = i
    const args: string[] = []
    while (i < source.length && depth > 0) {
      const ch = source[i]!
      if (quote !== null) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === quote) quote = null
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
      } else if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      } else if (ch === ',' && depth === 1) {
        args.push(source.slice(argStart, i))
        argStart = i + 1
      }
      i += 1
    }
    args.push(source.slice(argStart, i))
    calls.push(args.map((a) => a.trim()))
    marker.lastIndex = i
  }
  return calls
}

/** Every top-level `const NAME = '...'` string constant in `source` — `=` and the literal may sit on separate lines. */
function extractStringConstants(source: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) map.set(m[1]!, m[2]!)
  return map
}

/** An `add(...)` argument is either a plain single-quoted literal or a reference to a string constant declared in the same file — `gaps.ts` uses both. */
function resolveArg(raw: string, constants: ReadonlyMap<string, string>): string {
  const literal = /^'([^]*)'$/.exec(raw)
  if (literal !== null) return literal[1]!
  const value = constants.get(raw)
  if (value === undefined) {
    throw new Error(`remedy argument is neither a string literal nor a known constant: ${raw}`)
  }
  return value
}

/** The 4th argument — the remedy/command — of every `add(id, what, why, command)` call in `gaps.ts`, in source order. */
function remedyStrings(source: string): string[] {
  const constants = extractStringConstants(source)
  return extractCallArgs(source, 'add').map((args) => resolveArg(args[3]!, constants))
}

/** A path-shaped token needs one of these extensions. A directory separator alone is NOT enough — `scripts/dev/never-written` is not extracted at all, so an extensionless dead remedy passes; widening to "separator OR extension", which this comment used to claim outright, is `#231`. See the input table's "bare command name" and ".json data file" rows for why `.json` is not here. */
const PATH_TOKEN_RE = /^[A-Za-z0-9_.\-/]+\.(?:sh|ts|tsx|js|mjs|md)$/

/** Every path-like token a remedy string names, per the input table above. */
function extractPathLikeTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^[`("']+/, '').replace(/[`)"'.,:;]+$/, ''))
    .filter((token) => !token.includes('<') && !token.includes('>'))
    .filter((token) => PATH_TOKEN_RE.test(token))
}

function tokenResolves(token: string): boolean {
  return existsSync(path.join(REPO_ROOT, token))
}

describe('remedy reachability law: a gap remedy names something a reader can reach (issue #63)', () => {
  it('gaps.ts is where this law reads from — a stale GAPS_FILE_REL would make every check below vacuous', () => {
    expect(existsSync(GAPS_FILE_ABS)).toBe(true)
    expect(GAPS_FILE_REL).toBe('packages/core/src/fleet/gaps.ts')
  })

  it('extraction reads all seven live add(...) calls, not a truncated subset', () => {
    const source = readFileSync(GAPS_FILE_ABS, 'utf8')
    expect(remedyStrings(source)).toEqual([
      'eval "$(rhizomorph env <lane>)"',
      'your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)',
      'your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)',
      'eval "$(rhizomorph env <lane> --role worker)"',
      'rhizomorph --extra-sessions <dir>:conductor',
      'rhizomorph doctor',
      'rhizomorph doctor',
    ])
  })

  it('an OPTIONAL call to add is still read — `add?.(...)` cannot smuggle a dead remedy past this law', () => {
    // Round 6 of the verify pass planted an executable
    // `add?.('probe', ..., 'dispatch.sh')` in gaps.ts and every test here
    // stayed green. Pinned on a fixture rather than the real file so the
    // assertion cannot be satisfied by whatever gaps.ts happens to contain.
    const fixture = [
      "const add = (id: string, what: string, why: string, command: string): void => {}",
      "add('plain', 'A', 'b', 'docs/architecture.md')",
      "add?.('optional', 'C', 'd', 'dispatch.sh')",
      "add ?. ('spaced', 'E', 'f', 'scripts/gate.sh')",
    ].join('\n')
    expect(remedyStrings(fixture)).toEqual([
      'docs/architecture.md',
      'dispatch.sh',
      'scripts/gate.sh',
    ])
    // ...and the unreachable one among them is still the one that fails.
    expect(extractPathLikeTokens('dispatch.sh').filter((token) => !tokenResolves(token))).toEqual(['dispatch.sh'])
  })

  it.each([
    ['bare, no directory', 'dispatch.sh (writes the fence manifest)', ['dispatch.sh']],
    ['with a directory', 'see docs/user-guide/troubleshooting.md for detail', ['docs/user-guide/troubleshooting.md']],
    ['as a command with trailing arguments', 'scripts/dev/issues.sh list', ['scripts/dev/issues.sh']],
    ['backticked', 'run `dispatch.sh` first', ['dispatch.sh']],
    ['inside parens', '(see docs/architecture.md)', ['docs/architecture.md']],
    ['trailing period', 'run dispatch.sh.', ['dispatch.sh']],
    ['trailing comma', 'run dispatch.sh, then retry', ['dispatch.sh']],
    ['a bare command name, no slash or extension', 'rhizomorph doctor', []],
    ['an eval one-liner naming no path', 'eval "$(rhizomorph env <lane>)"', []],
    ['an angle-bracket placeholder', 'rhizomorph --extra-sessions <dir>:conductor', []],
    ['a .json data file named for context', 'writes .swarm/lanes.json, not part of this repo', []],
  ])('extractPathLikeTokens: %s', (_label, command, expected) => {
    expect(extractPathLikeTokens(command)).toEqual(expected)
  })

  it('the detector reddens on a fabricated missing script and stays green on a real file — a spelling the issue itself never used', () => {
    // The issue's own reported bug was `dispatch.sh`; this uses a different
    // fabricated name so the detector is proven general, not a hardcoded
    // string comparison against the one reported instance.
    const fabricatedRemedy = 'scripts/dev/this-script-was-never-written.sh (regenerates the manifest)'
    const [missing] = extractPathLikeTokens(fabricatedRemedy)
    expect(missing).toBe('scripts/dev/this-script-was-never-written.sh')
    expect(tokenResolves(missing!)).toBe(false)

    const realRemedy = 'run scripts/dev/issues.sh list'
    const [real] = extractPathLikeTokens(realRemedy)
    expect(tokenResolves(real!)).toBe(true)
  })

  it('the honest remedy this fix writes resolves to a real file', () => {
    const [doc] = extractPathLikeTokens(
      'your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)',
    )
    expect(doc).toBe('docs/user-guide/troubleshooting.md')
    expect(tokenResolves(doc!)).toBe(true)
  })

  /**
   * MUTATION PROOF, not run through `certify-mutation.sh`: that script
   * mutates by finding a NEEDLE common to a line's old and new text, then
   * splicing the old text back in from git. This fix has no such needle —
   * `'dispatch.sh (writes the fence manifest)'` and `DISPATCH_TOOLING_REMEDY`
   * share no substring, being a full value replacement rather than an edited
   * threshold or flag, so there is nothing for the script's line-level swap
   * to key on.
   *
   * What proves the same thing instead: `extraction reads all seven live
   * add(...) calls` above confirms the parser correctly pulls a remedy out of
   * `gaps.ts`'s real syntax (string literals, a constant reference, backtick
   * templates, trailing commas) — not a synthetic fixture. The test directly
   * below feeds that SAME parser's output — the real reported bug string,
   * not retyped from memory but copied from the issue text — through the
   * SAME `extractPathLikeTokens`/`tokenResolves` pair `every remedy in
   * gaps.ts...` calls at the bottom of this file. Together: if `gaps.ts`'s
   * source still held this exact text, the parser would extract it (proven
   * against real syntax) and the detector would flag it (proven directly) —
   * the full path from source to red, without ever mutating the working
   * tree.
   */
  it('MUTATION PROOF: the real dead remedy this issue reported would redden the law below', () => {
    const reportedBug = 'dispatch.sh (writes the fence manifest)'
    const tokens = extractPathLikeTokens(reportedBug)
    expect(tokens).toEqual(['dispatch.sh'])
    expect(tokens.every(tokenResolves)).toBe(false)
  })

  it('every remedy in gaps.ts names a path that resolves from a fresh clone — the law itself', () => {
    const source = readFileSync(GAPS_FILE_ABS, 'utf8')
    const violations: { remedy: string; token: string }[] = []
    for (const remedy of remedyStrings(source)) {
      for (const token of extractPathLikeTokens(remedy)) {
        if (!tokenResolves(token)) violations.push({ remedy, token })
      }
    }
    expect(violations).toEqual([])
  })
})
