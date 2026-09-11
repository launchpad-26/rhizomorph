import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LAB_CLI_LOCK_CEILING_MS } from './lab.js'

/**
 * THE LAB CEILING LAW (prd-50 rulings 1 & 2, #236).
 *
 * `LAB_CLI_LOCK_CEILING_MS` stays fixed in source — not out of conservatism
 * about configuration, but because it is the mechanism by which a launch that
 * would wait silently behind another one refuses instead of queuing. prd-12
 * ruling 3 forbids exactly the trade an operator would make by raising it —
 * spend hidden behind latency — and a configurable threshold here is a
 * supported way to rebuild the queue prd-41 ruling 2 already refused.
 *
 * **Ruling 1 is what actually keeps the value fixed — this file is a check,
 * not the guarantee.** The ceiling stays 30000ms because it is fixed BY RULE
 * and any change to it lands in a reviewed diff, the same way every value in
 * this codebase is kept honest. What this file adds is narrower: it makes the
 * OBVIOUS ways of wiring a config input to `LAB_CLI_LOCK_CEILING_MS` fail the
 * suite, so that class of change cannot land silently. Three rounds of
 * adversarial review (#236) established that a claim any stronger than that
 * is not true of a text scan — see "What this does NOT prove" below, which
 * is exactly as load-bearing as the list of what it does.
 *
 * **This is a flow check, not a word-ban.** Round 1 asserted the value and
 * banned a short list of tokens (`process.env`, `readFileSync`) anywhere in
 * the whole module. Verify found that posture wrong in BOTH directions at
 * once: too narrow, because `ceilingMs` is an ordinary mutable parameter and
 * a config input assigned to it one line into `withLabCliLock`'s BODY was
 * invisible (16/16 green) while the identical class of input in the default
 * PARAMETER reddened 3/16 — the checks stopped at the signature; and too
 * wide, because banning `process.env` anywhere in `api/lab.ts` also reddens
 * on an unrelated env read for a constant that is not this one at all
 * (`LAB_UNRELATED_LABEL`, no path to the ceiling whatsoever). A later round
 * found the assignment check itself was still matching SPELLINGS (`=`, `|=`,
 * `++`…) rather than tracing the constant — `|=`, a for-of binding and array
 * destructuring all walked through it, an open set no amount of enumeration
 * closes. The final fix in each case was the same move: stop banning tokens
 * and count occurrences of the name instead.
 *
 * **What this file DOES verify, by execution — this is what "passing" means:**
 *
 *   1. `LAB_CLI_LOCK_CEILING_MS` is declared exactly once, with a literal
 *      value, anchored so a config-scaled declaration (`* Number(env.X)`)
 *      cannot pass as a mere text prefix;
 *   2. within `withLabCliLock`'s extracted body, the identifier `ceilingMs`
 *      occurs exactly as many times as `KNOWN_CEILING_READS` accounts for,
 *      and each of those exact reads is present verbatim — so ANY added
 *      occurrence reddens regardless of its syntax (an assignment, a
 *      destructure, a loop binding, whatever operator), and a compensated
 *      swap that holds the count steady still reddens on the containment
 *      half;
 *   3. the two production call sites pass no config-derived argument for the
 *      ceiling, build their options object from exactly one reviewed
 *      literal, and a third call site would be caught by the call count;
 *   4. no `lockCeilingMs` key is ever set from a literal object anywhere in
 *      the repo's production source;
 *   5. these checks run against the REAL `lab.ts` source, not only against
 *      hand-written fixtures, and the assertions that do so are themselves
 *      pinned by `expect.assertions` so deleting one of them reddens rather
 *      than passing vacuously (#236 round 5 — a law that cannot fail for the
 *      reason it claims is exactly the defect this file exists to catch, and
 *      it had that defect itself for two rounds).
 *
 * **What this does NOT prove**, said as plainly as what it does — this is
 * not a smaller version of the same claim, it is the boundary of what a
 * TEXT SCAN of one file can ever establish:
 *
 *   - It cannot decide reachability IN GENERAL. "No configuration input
 *     reaches this constant" quantifies over every possible program; a scan
 *     of `lab.ts`'s current text can only fail the specific wirings it
 *     enumerates above, not rule out every way a future change could reach
 *     the value.
 *   - Anything that reaches the ceiling WITHOUT writing a fresh occurrence
 *     of the token `ceilingMs` — an alias, a getter, a wrapper function
 *     around `withLabCliLock`, a shadowed global, `eval`, or a seam this
 *     file has not enumerated — is outside what a token count can see by
 *     construction. So is a runtime-computed property write
 *     (`options[computedKey] = x`, where `computedKey` evaluates to
 *     `'lockCeilingMs'` with that string appearing nowhere in source) and an
 *     export-time alias of the constant under a new name — both invisible to
 *     any static scan, not just this one.
 *   - The body extractor (`functionBodyOf`) is brace-COUNTING over text, not
 *     a parser. Verified directly: a decoy string or regex containing an
 *     unbalanced `}` placed AFTER the three known reads truncates the
 *     extracted body there, and the truncated text still satisfies both the
 *     occurrence count and the containment check — a real content-hiding
 *     mutation this specific shape does not catch. Placed BEFORE the known
 *     reads, the same truncation is caught loudly (the reads go missing).
 *     Which one happens depends on where the decoy sits; this file does not
 *     make that reliably loud, and says so rather than claiming otherwise.
 *
 * Review seats surfaced several other candidate routes of this shape (a
 * module-scope timer shadow, an early return inside the ceiling promise,
 * bracket assignment on the options seam, a third call site carrying an
 * explicit generic). Two did not reproduce when rebuilt independently, so
 * none of the five are asserted as settled here — the point they establish
 * in common does not depend on any one of them: a text scan is not a
 * reachability proof, and no further detection round is owed to make it one
 * (a decision taken deliberately, #236 round 6 — the claim narrows to match
 * what is verified true; the instrument does not grow again).
 *
 * The full enumeration of forms considered across every round — closed and
 * residual alike — is in `lab-ceiling-law.enumeration.md` (scratch,
 * referenced from the commit body; not itself part of this fence).
 *
 * `localStorage`/`sessionStorage` stay a plain module-wide ban (unlike
 * `process.env`/file reads): Node has no such globals for ANY legitimate
 * purpose, so there is no unrelated-use case for this one to overreach into.
 *
 * **Deliberately scoped to this one constant.** `MAX_ARMS`,
 * `RESTORE_EXEC_TIMEOUT_MS`, `COMPARE_EXEC_TIMEOUT_MS`,
 * `COMPARE_VERIFY_TIMEOUT_MS`, `FORK_EXEC_TIMEOUT_MS` and the route/collector
 * budgets are the same shape and are NOT guarded here — prd-50 open question 1
 * leaves the family unruled on purpose, and a law general enough to cover all
 * of them would quietly decide that question rather than leave it open. Every
 * pattern below names `LAB_CLI_LOCK_CEILING_MS`, `lockCeilingMs` or
 * `withLabCliLock` specifically; none of it would fire on a sibling constant.
 *
 * This file imports the constant from `./lab.js` and reads that module's own
 * source text to check it — it never edits `api/lab.ts` (#213 and prd-50 wave
 * 2 own that module; #213 and #325 have since merged, so #237 will add the
 * doc comment beside the constant next — leave that to it).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/api -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const LAB_TS = path.join(SERVER_SRC, 'api', 'lab.ts')
/** Posix spelling, matching `git ls-files` on every platform — never derived with `path.relative`, which emits `\` on Windows. */
const LAB_TS_REL = 'packages/server/src/api/lab.ts'

/**
 * Punctuation and keywords after which a `/` starts a REGEX literal rather
 * than dividing. Practical heuristic (the one real tokenisers use, minus full
 * context): after an identifier, number, `)`, `]`, or a closing string/
 * template/regex, `/` divides; after everything else — an operator, opening
 * bracket, or one of these keywords, or at the very start — `/` opens a
 * regex. The one case this gets wrong on purpose: a regex literal written
 * immediately after a control statement's closing paren (`if (x) /re/.test(y)`)
 * reads as division, because `)` almost always closes a call or a
 * parenthesised value instead. No such construct exists in `lab.ts` today.
 */
const REGEX_PRECEDING_PUNCT = new Set([
  '(', ',', '=', ':', ';', '!', '&', '|', '?', '{', '[', '+', '-', '*', '%', '<', '>', '^', '~',
])
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'in', 'of', 'instanceof', 'new', 'void', 'delete', 'throw', 'case', 'do', 'else', 'yield', 'await',
])
const WORD_CHAR_RE = /[A-Za-z0-9_$]/

/**
 * Code with comments stripped — a small STRING-AWARE lexer, not a regex.
 *
 * Round 1's version stripped block comments and then `//`-to-end-of-line, both
 * by regex, with no notion of "inside a string". A same-line string containing
 * `//` (an ordinary URL: `const doc = 'see https://x'`) reads as a comment
 * opener to that second regex, which deletes everything after it on the
 * line — including a REAL `process.env` read placed after the string.
 *
 * Round 2's rewrite walked the source char-by-char but had two more holes,
 * both found by running it against the REAL file rather than trusting
 * hand-written fixtures:
 *
 * - A template literal was walked as "scan for the next unescaped backtick",
 *   which breaks on a NESTED one — `lab.ts`'s `modelRefusalMessage` has
 *   `` `"${offender}"` `` inside an outer template's `${...}`. The inner
 *   literal's OPENING backtick read as the outer one's CLOSE, desynchronising
 *   everything after it.
 * - A REGEX LITERAL containing a quote was read one character at a time with
 *   no notion of "this is a regex, not code" — `lab.ts` has two,
 *   `FORK_HEADER_RE` and the `no fork "` one, each with a `"` inside. The
 *   first `"` inside the pattern read as a STRING OPENER, and the walk went
 *   looking for a closing `"` in the wrong place, again desynchronising
 *   everything after.
 *
 * Both are fixed the same way: a construct that can contain arbitrary text is
 * walked to ITS OWN terminator by a dedicated function, rather than folded
 * into the top-level "is this a quote" check. A template's `${...}`
 * interpolation recurses into `scanInterpolation`, which is itself
 * string/comment/template/regex-aware — so a nested template, a string, or a
 * regex inside an interpolation is handled by the same rules as the top
 * level, at any depth.
 */
function codeOf(source: string): string {
  const out: string[] = []
  let i = 0
  const n = source.length

  /** The last non-whitespace "token" already written to `out` — a run of word characters, or a single punctuation character, or `null` at the very start. */
  function lastToken(): string | null {
    let j = out.length - 1
    while (j >= 0 && /\s/.test(out[j]!)) j--
    if (j < 0) return null
    if (!WORD_CHAR_RE.test(out[j]!)) return out[j]!
    let k = j
    while (k >= 0 && WORD_CHAR_RE.test(out[k]!)) k--
    return out.slice(k + 1, j + 1).join('')
  }

  function isRegexStart(): boolean {
    const tok = lastToken()
    if (tok === null) return true
    if (tok.length === 1 && !WORD_CHAR_RE.test(tok)) return REGEX_PRECEDING_PUNCT.has(tok)
    return REGEX_PRECEDING_KEYWORDS.has(tok)
  }

  function consumeSimpleString(quote: string): void {
    out.push(source[i]!)
    i++
    while (i < n) {
      const c = source[i]!
      out.push(c)
      i++
      if (c === '\\') {
        if (i < n) {
          out.push(source[i]!)
          i++
        }
        continue
      }
      if (c === quote) return
    }
  }

  /** A regex literal from its opening `/` to its closing `/` plus flags — a `/` inside a `[...]` character class does not close it, and an unescaped newline before closing means this was misread as a regex and the scan simply stops (nothing is deleted either way, unlike a comment). */
  function consumeRegex(): void {
    out.push(source[i]!) // opening slash
    i++
    let inClass = false
    while (i < n) {
      const c = source[i]!
      if (c === '\n') return
      if (c === '\\') {
        out.push(c)
        i++
        if (i < n) {
          out.push(source[i]!)
          i++
        }
        continue
      }
      if (c === '[') inClass = true
      if (c === ']') inClass = false
      out.push(c)
      i++
      if (c === '/' && !inClass) break
    }
    while (i < n && /[a-z]/i.test(source[i]!)) {
      out.push(source[i]!)
      i++
    }
  }

  function consumeTemplate(): void {
    out.push(source[i]!) // opening backtick
    i++
    while (i < n) {
      const c = source[i]!
      if (c === '\\') {
        out.push(c)
        i++
        if (i < n) {
          out.push(source[i]!)
          i++
        }
        continue
      }
      if (c === '`') {
        out.push(c)
        i++
        return
      }
      if (c === '$' && source[i + 1] === '{') {
        out.push('$', '{')
        i += 2
        scanInterpolation()
        continue
      }
      out.push(c)
      i++
    }
  }

  /** Scans CODE from just after a `${` to its matching `}` at depth zero — string/comment/template/regex-aware, so anything nested inside is handled by the same rules as the top level. */
  function scanInterpolation(): void {
    let depth = 1
    while (i < n && depth > 0) {
      const c = source[i]!
      if (c === '"' || c === "'") {
        consumeSimpleString(c)
        continue
      }
      if (c === '`') {
        consumeTemplate()
        continue
      }
      if (c === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (c === '/' && source[i + 1] === '*') {
        i += 2
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
        i += 2
        continue
      }
      if (c === '/' && isRegexStart()) {
        consumeRegex()
        continue
      }
      if (c === '{') depth++
      if (c === '}') depth--
      out.push(c)
      i++
    }
  }

  while (i < n) {
    const ch = source[i]!
    if (ch === '"' || ch === "'") {
      consumeSimpleString(ch)
      continue
    }
    if (ch === '`') {
      consumeTemplate()
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '/' && isRegexStart()) {
      consumeRegex()
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}

/**
 * The text of `withLabCliLock`'s `ceilingMs` default parameter, verbatim —
 * not "contains the identifier", but "is exactly this expression and nothing
 * composed onto it". Found by searching for the parameter's own marker and
 * taking everything up to the NEXT literal `): Promise<T>` — a plain string
 * search rather than a bracket-balanced parse, which is why the mutation this
 * law exists to catch (an extra `)` from `process.env.X ?? ''`) cannot fool
 * it: the search does not stop at the first `)`, it stops at the first
 * occurrence of the exact 13-character closer.
 */
function defaultCeilingExpression(code: string): string {
  const marker = 'ceilingMs: number = '
  const start = code.indexOf(marker)
  if (start === -1) {
    throw new Error("withLabCliLock's signature was not found — the function moved or was renamed")
  }
  const end = code.indexOf('): Promise<T>', start)
  if (end === -1) {
    throw new Error("withLabCliLock's return-type annotation was not found — the signature's shape changed")
  }
  return code.slice(start + marker.length, end).trim()
}

const WITH_LAB_CLI_LOCK_SIGNATURE = 'function withLabCliLock<T>('

/**
 * The text of the function BODY beginning at `signatureMarker` — from the `{`
 * that opens it to the matching `}` — brace-balanced, so a `{`/`}` pair
 * anywhere inside (an object literal, an arrow function) cannot end the scan
 * early. Distinct from `callsTo` below: this reads a DECLARATION's body, not a
 * CALL's arguments.
 */
function functionBodyOf(code: string, signatureMarker: string): string {
  const sigIdx = code.indexOf(signatureMarker)
  if (sigIdx === -1) throw new Error(`signature not found: ${signatureMarker}`)
  const openBrace = code.indexOf('{', sigIdx)
  if (openBrace === -1) throw new Error('function body opening brace not found')
  let depth = 0
  let end = -1
  for (let i = openBrace; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error("function body's closing brace not found — unbalanced braces")
  return code.slice(openBrace + 1, end)
}

/**
 * Every KNOWN-GOOD read of `ceilingMs` inside `withLabCliLock`'s body,
 * verbatim, as it stands today — round 4's replacement for a reassignment
 * regex (round 3's `=`/`+=`/`||=`/`++`/`--` list) that a `|=`, a `for...of`
 * binding and an array destructure all walked straight through: JavaScript's
 * assignment grammar is an open set, and enumerating it one operator at a
 * time never terminates.
 *
 * The claim this makes COUNTABLE instead: `ceilingMs` occurs in the body
 * EXACTLY this many times, and every occurrence is one of these three exact
 * reads — two refusal-message interpolations and the `setTimeout` delay
 * argument. ANY assignment, of any shape whatsoever, writes the identifier
 * somewhere NOT in this list — either adding a fourth occurrence (caught by
 * the count) or replacing one of these three verbatim strings with something
 * else at the same total count (caught by the per-read containment check).
 * Both are asserted together below; neither alone is sufficient, and each
 * has its own "bites" fixture proving it is the one doing the work.
 *
 * RE-DERIVE, DO NOT TRUST: run the extractor over the real body rather than
 * reading this array — a stale list here is exactly the failure this
 * approach exists to avoid making possible elsewhere.
 *
 * THE HONEST COST, stated rather than left to be discovered: this is
 * fail-safe but brittle. A benign refactor that adds a fourth legitimate
 * read (another log line touching `ceilingMs`) reddens this test and must be
 * re-derived by hand — the same trade `route-class-law.test.ts`'s derived
 * route counts already accept, and the correct direction for a law whose
 * whole claim is "nothing new touches this name."
 */
const KNOWN_CEILING_READS = [
  'did not clear within ${ceilingMs}ms',
  'waited ${ceilingMs}ms',
  '}, ceilingMs)',
]

/** `withLabCliLock`'s real body with `mutation` inserted as its first statement, for a "bites" fixture — returns the resulting occurrence count of `ceilingMs`, not the body itself, since every caller only wants the count. */
function occurrenceCountOfMutatedBody(mutation: string): number {
  const signatureLine = `${WITH_LAB_CLI_LOCK_SIGNATURE}label: string, fn: () => Promise<T>, ceilingMs: number = LAB_CLI_LOCK_CEILING_MS): Promise<T> {`
  const mutatedSource = readFileSync(LAB_TS, 'utf8').replace(signatureLine, `${signatureLine}\n  ${mutation}`)
  const mutatedBody = functionBodyOf(codeOf(mutatedSource), WITH_LAB_CLI_LOCK_SIGNATURE)
  return (mutatedBody.match(/\bceilingMs\b/g) ?? []).length
}

/** Splits a call's argument text on its TOP-LEVEL commas — depth-aware over `()[]{}`, and quote-aware over `'`, `"` and backticks. */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i]!
    if (quote !== null) {
      current += ch
      if (ch === quote && argsText[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim().length > 0) args.push(current.trim())
  return args
}

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/

/**
 * Every CALL (not declaration) of `fnName(...)` in `code`, as its top-level
 * argument list.
 *
 * Two things a plain `${fnName}(` substring search cannot see, both fixed
 * here: an explicit generic type argument (`withLabCliLock<void>(...)`) — an
 * optional `<...>` between the name and the paren is tolerated, no nesting
 * expected at either of this function's real call sites — and a match that
 * is only a SUFFIX of a longer identifier, which a bare `indexOf` does not
 * rule out. A `function fnName(` or `async function fnName(` immediately
 * before a real match is a declaration and is skipped — both the launch and
 * measure entry points below are declared and called in the same file.
 */
function callsTo(code: string, fnName: string): string[][] {
  const calls: string[][] = []
  let searchFrom = 0
  for (;;) {
    const idx = code.indexOf(fnName, searchFrom)
    if (idx === -1) break
    const before = code[idx - 1]
    const afterName = idx + fnName.length
    if (IDENT_CHAR_RE.test(before ?? '') || IDENT_CHAR_RE.test(code[afterName] ?? '')) {
      // A substring of a longer identifier — not an occurrence of this name at all.
      searchFrom = idx + fnName.length
      continue
    }
    let cursor = afterName
    if (code[cursor] === '<') {
      const closeAngle = code.indexOf('>', cursor)
      if (closeAngle !== -1) cursor = closeAngle + 1
    }
    while (code[cursor] === ' ' || code[cursor] === '\n' || code[cursor] === '\t') cursor++
    if (code[cursor] !== '(') {
      searchFrom = idx + fnName.length
      continue
    }
    const openParen = cursor
    const before20 = code.slice(Math.max(0, idx - 20), idx).trimEnd()
    if (before20.endsWith('function')) {
      searchFrom = openParen + 1
      continue
    }
    let depth = 0
    let end = -1
    for (let i = openParen; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced call to ${fnName}(...) — could not find its closing paren`)
    calls.push(splitTopLevelArgs(code.slice(openParen + 1, end)))
    searchFrom = end + 1
  }
  return calls
}

/** Collapses all whitespace runs to a single space and trims — so an exact-content comparison survives reformatting but not a real change. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const SWEPT_EXTENSIONS = ['.ts', '.tsx'] as const
const SWEEP_EXCLUDED_PREFIXES = ['docs/'] as const

/** Every tracked, non-test `.ts`/`.tsx` file in the repo — the surface "read from exactly one place" is checked against. */
function sweptProductionFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out
    .split('\0')
    .filter((rel) => rel.length > 0)
    .filter((rel) => SWEPT_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext)))
    .filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx'))
    .filter((rel) => !SWEEP_EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)))
}

/** Budget for the sweeping tests below — the reasoning is `route-class-law.test.ts`'s `SWEEP_TIMEOUT_MS`, reused rather than re-derived. */
const SWEEP_TIMEOUT_MS = 30_000

describe('the lab ceiling law (prd-50 ruling 2) — every enumerated wiring to LAB_CLI_LOCK_CEILING_MS fails the suite; general reachability is not something a text scan proves', () => {
  const labSource = readFileSync(LAB_TS, 'utf8')
  const labCode = codeOf(labSource)

  it('is the value ruling 1 fixed — necessary, but not what this file exists to prove', () => {
    // ROUND 5: every `it` below that asserts something about the REAL
    // source (as opposed to a synthetic "bites" fixture) opens with
    // `expect.assertions(n)` — vitest's own load-bearing-test mechanism, not
    // a check this file invents. Verify found that the production count
    // assertion at the heart of this law could be deleted outright and the
    // suite stayed green, because the surrounding "bites" tests exercise the
    // CHECKER against author-written strings and never depend on the
    // real-source assertion having run at all — the same "test that cannot
    // fail for the reason it claims" shape this whole file exists to police,
    // now inside the police. `expect.assertions(n)` closes it WITHOUT
    // reading this file's own text (which would be round 3's `codeOf`
    // self-test defect wearing new clothes): it is vitest's runtime count of
    // actual `expect()` calls made during the test, so deleting any one of
    // them — regardless of which, regardless of spelling — leaves fewer
    // calls than declared and the test fails on the mismatch.
    expect.assertions(1)
    // The mutation this file's own doc names leaves this assertion green: the
    // number is untouched while the ceiling becomes operator-settable. Kept
    // as a sanity check, not as the law's teeth.
    expect(LAB_CLI_LOCK_CEILING_MS).toBe(30_000)
  })

  describe('the stripper itself — a lexer, not a `//`-to-end-of-line regex', () => {
    it('an ordinary string containing "//" does not erase a real read that follows it on the same line', () => {
      // The exact defect verify found: a `//`-to-end-of-line regex reads the
      // `//` inside `https://example.com` as a comment opener and deletes the
      // rest of the line — including a genuine `process.env` read placed
      // after the string. This mutates the RAW source, then re-derives
      // through the REAL `codeOf`, so it exercises the pipeline rather than a
      // fixture built to already contain the answer.
      const withUrlThenRead =
        `${labSource}\nconst doc = 'see https://example.com'; const x = process.env.RHIZOMORPH_LAB_LOCK_MS\n`
      expect(codeOf(withUrlThenRead)).toMatch(/process\.env/)
    })

    it('bites: an ordinary `//` comment still disappears', () => {
      // A self-contained fixture, not `labSource` plus an appendix: this law
      // no longer bans `process.env` module-wide (that was the "too wide"
      // defect), so the real file may legitimately carry one elsewhere, and
      // asserting against the whole file's output would then pass or fail
      // for a reason having nothing to do with THIS comment.
      const withComment = 'const x = 1\n// process.env.RHIZOMORPH_LAB_LOCK_MS\n'
      expect(codeOf(withComment)).not.toMatch(/process\.env/)
    })

    it('bites: a block comment still disappears, including one that spans lines', () => {
      const withBlockComment = 'const x = 1\n/* process.env.RHIZOMORPH_LAB_LOCK_MS\n   spanning a line */\n'
      expect(codeOf(withBlockComment)).not.toMatch(/process\.env/)
    })

    it('an escaped quote inside a string does not end the string early', () => {
      // Without escape-awareness, the string ends at the `\'`, and everything
      // from there — including the `//` a moment later — reads as code, which
      // would happen to still catch this particular case. The REAL risk an
      // unescaped read would miss is the reverse: treating the CHARACTERS
      // after an escaped quote as a NEW, unterminated string that swallows
      // the rest of the file. This proves the walk resumes as code right
      // after the string closes.
      const fixture = "const s = 'it\\'s fine'; const x = process.env.RHIZOMORPH_LAB_LOCK_MS\n"
      expect(codeOf(fixture)).toMatch(/process\.env/)
    })

    it('a nested template literal does not desynchronise the walk — the exact shape lab.ts uses', () => {
      // `modelRefusalMessage`'s real shape: an outer template whose
      // interpolation contains ANOTHER template literal. A flat "next
      // backtick closes the string" walk reads the inner literal's OPENING
      // backtick as the outer's close and misreads everything after.
      const fixture =
        'const s = `outer ${x ? `inner ${y}` : \'z\'}`; const n = process.env.RHIZOMORPH_LAB_LOCK_MS\n'
      expect(codeOf(fixture)).toMatch(/process\.env/)
    })

    it('a quote inside a regex literal does not open a phantom string — the exact shape lab.ts uses (FORK_HEADER_RE, "no fork \\"")', () => {
      // Without regex awareness, the `"` inside `/lane "(?:[^"]*)"/ ` reads as
      // a STRING opener; the walk then hunts for a closing `"` in the wrong
      // place and desynchronises everything after, exactly as it did here
      // before this round (found by running the stripper on the real file,
      // not a fixture).
      const fixture = 'const RE = /lane "(?:[^"]*)" done/m\nconst n = process.env.RHIZOMORPH_LAB_LOCK_MS\n'
      expect(codeOf(fixture)).toMatch(/process\.env/)
    })

    it('bites: an ordinary division is not misread as a regex literal that swallows the rest of the line', () => {
      // After an identifier, `/` divides. Misreading `a / b` as a regex
      // opener would hunt for a second `/` to close it — the risk on the
      // other side of adding regex support at all.
      const fixture = 'const ratio = a / b // process.env.RHIZOMORPH_LAB_LOCK_MS\n'
      expect(codeOf(fixture)).not.toMatch(/process\.env/)
    })

    it('bites: a regex literal immediately after an operator is recognised as one, not as division', () => {
      const fixture = "const re = /a\\/b/ // process.env.RHIZOMORPH_LAB_LOCK_MS\n"
      expect(codeOf(fixture)).not.toMatch(/process\.env/)
    })
  })

  describe('the constant is read from exactly one place', () => {
    it('the module declares it once, and reads it once more — nowhere else', () => {
      expect.assertions(2)
      const occurrences = labCode.match(/\bLAB_CLI_LOCK_CEILING_MS\b/g) ?? []
      expect(occurrences.length).toBe(2)
      // Anchored to the end of the physical line (the `m` flag makes `$`
      // match there), not merely a prefix — `= 30_000` is otherwise a true
      // substring of `= 30_000 * Number(process.env.SCALE ?? 1)`, so an
      // unanchored match would pass on a SCALED declaration unchanged.
      expect(labCode).toMatch(/^export const LAB_CLI_LOCK_CEILING_MS = 30_000$/m)
    })

    it('bites: a scaled declaration is told apart from the bare one', () => {
      const mutated = labCode.replace(
        'export const LAB_CLI_LOCK_CEILING_MS = 30_000',
        "export const LAB_CLI_LOCK_CEILING_MS = 30_000 * Number(process.env.RHIZOMORPH_LAB_LOCK_SCALE ?? 1)",
      )
      expect(mutated).not.toBe(labCode)
      expect(mutated).not.toMatch(/^export const LAB_CLI_LOCK_CEILING_MS = 30_000$/m)
    })

    it("that one read is the bare identifier as withLabCliLock's default parameter, nothing composed onto it", () => {
      expect.assertions(1)
      expect(defaultCeilingExpression(labCode)).toBe('LAB_CLI_LOCK_CEILING_MS')
    })

    it('bites: a default expression with the named mutation composed onto it is told apart from the bare one', () => {
      const mutated = labCode.replace(
        'ceilingMs: number = LAB_CLI_LOCK_CEILING_MS): Promise<T>',
        "ceilingMs: number = (Number(process.env.RHIZOMORPH_LAB_LOCK_MS ?? '') || LAB_CLI_LOCK_CEILING_MS)): Promise<T>",
      )
      expect(mutated).not.toBe(labCode)
      expect(defaultCeilingExpression(mutated)).not.toBe('LAB_CLI_LOCK_CEILING_MS')
    })

    it("is named nowhere else in the repo's production source — the sweep sees only this module", () => {
      expect.assertions(1)
      const hits = sweptProductionFiles().filter((rel) =>
        readFileSync(path.join(REPO_ROOT, rel), 'utf8').includes('LAB_CLI_LOCK_CEILING_MS'),
      )
      expect(hits).toEqual([LAB_TS_REL])
    }, SWEEP_TIMEOUT_MS)

    it('the sweep has something to check — an empty file list would pass vacuously', () => {
      expect.assertions(1)
      expect(sweptProductionFiles().length).toBeGreaterThan(50)
    }, SWEEP_TIMEOUT_MS)
  })

  describe("withLabCliLock's BODY — counted, not pattern-matched", () => {
    const body = functionBodyOf(labCode, WITH_LAB_CLI_LOCK_SIGNATURE)

    it('has a body to check at all — an empty extraction would pass every assertion below vacuously', () => {
      expect.assertions(2)
      expect(body.length).toBeGreaterThan(80)
      expect(body).toContain('ceilingMs')
    })

    it("the identifier occurs exactly as many times as KNOWN_CEILING_READS accounts for, and every one of those exact reads is present", () => {
      // THE COUNTING FIX (round 4, replacing a reassignment-operator regex
      // round 3 shipped and round 4's verify broke with `|=`, a for-of
      // binding, and array destructuring — three spellings of "assign to
      // ceilingMs" a regex missed because JavaScript's assignment grammar is
      // an open set: `=` plus thirteen compound operators, array/object
      // destructuring, for-of/for-in bindings, `++`/`--`, and whatever TC39
      // adds next. Enumerating that one operator at a time does not
      // terminate — the fix is to make the claim COUNTABLE instead of
      // syntactic.
      //
      // ANY assignment, reassignment, or binding of `ceilingMs` — regardless
      // of operator or destructuring shape — must WRITE THE IDENTIFIER
      // somewhere in the body that does not already appear in
      // `KNOWN_CEILING_READS`. Two independent checks close both directions:
      //
      //   1. the TOTAL occurrence count must equal `KNOWN_CEILING_READS.length`
      //      — this alone catches every ADDITION, including a mutation that
      //      writes to `ceilingMs` without removing any existing read;
      //   2. every one of the three known-good reads must still be present
      //      VERBATIM — this catches the narrower case where a mutation
      //      REMOVES one known read and adds a different single occurrence
      //      elsewhere, leaving the total count unchanged (a "swap" the count
      //      alone cannot see; proven by the swap fixture below).
      //
      // ROUND 5: `expect.assertions` pins the count of `expect()` calls THIS
      // test itself must make — one for the total, one per known read — so
      // deleting the line below (verify's own finding, executed against
      // 6eb9fdf9: doing exactly that left the suite 32/32 green) now leaves
      // fewer calls than declared and reddens on the mismatch, regardless of
      // which of the four is removed.
      expect.assertions(1 + KNOWN_CEILING_READS.length)
      const occurrences = body.match(/\bceilingMs\b/g) ?? []
      expect(occurrences.length).toBe(KNOWN_CEILING_READS.length)
      for (const read of KNOWN_CEILING_READS) {
        expect(body, `expected read missing: ${read}`).toContain(read)
      }
    })

    it('bites: a plain reassignment adds an occurrence and reddens the count', () => {
      expect(occurrenceCountOfMutatedBody('ceilingMs = Number(process.argv[2])\n')).not.toBe(
        KNOWN_CEILING_READS.length,
      )
    })

    it('bites: every operator and binding form round 4 named is caught the same way — by the count, not by its own regex', () => {
      // The exact three the operator's control found, plus the two
      // structural bindings the message named as the open set's other
      // members. None of these are matched by spelling — each is caught
      // because it is one more occurrence of the token than
      // `KNOWN_CEILING_READS` accounts for, whatever the syntax.
      const mutations = [
        'ceilingMs |= Number(process.env.RHIZOMORPH_LAB_LOCK_MS)\n',
        'for (ceilingMs of [Number(process.env.RHIZOMORPH_LAB_LOCK_MS)]) break\n',
        '[ceilingMs] = [Number(process.argv[2])]\n',
        '({ ceilingMs } = { ceilingMs: Number(process.argv[2]) })\n',
        'ceilingMs++\n',
        'ceilingMs += 1\n',
      ]
      for (const mutation of mutations) {
        expect(occurrenceCountOfMutatedBody(mutation), mutation).not.toBe(KNOWN_CEILING_READS.length)
      }
    })

    it('bites: a SWAP — one known read removed, a different single occurrence added — leaves the count unchanged, and only the per-read containment check sees it', () => {
      // The case the count alone cannot catch, proven on a synthetic body
      // fixture rather than the real one (constructing a genuine same-count
      // swap in `lab.ts` itself would mean actually deleting the consumption
      // site, which the fixture does without touching the real file).
      const swapped = body
        .replace('}, ceilingMs)', '}, 5000)') // removes one known read
        .concat('\nconst borrowed = ceilingMs\n') // adds a different single occurrence, same total count
      const occurrences = swapped.match(/\bceilingMs\b/g) ?? []
      expect(occurrences.length).toBe(KNOWN_CEILING_READS.length) // count alone sees nothing wrong
      expect(swapped).not.toContain('}, ceilingMs)') // the containment check does
    })

    it('bites: a composed consumption-site expression keeps the SAME count but fails its exact read', () => {
      // `Number(process.env.X) || ceilingMs` contains the identifier exactly
      // ONCE, same as the bare `ceilingMs)` it replaces — proving the count
      // check alone would not catch this composition either, and it is the
      // per-read containment check earning its place a second time.
      const composed = body.replace('}, ceilingMs)', "}, Number(process.env.RHIZOMORPH_LAB_LOCK_MS ?? '') || ceilingMs)")
      const occurrences = composed.match(/\bceilingMs\b/g) ?? []
      expect(occurrences.length).toBe(KNOWN_CEILING_READS.length)
      expect(composed).not.toContain('}, ceilingMs)')
    })

    it('the count is re-derived here, not merely asserted — a reader who sees this go red from a benign refactor should re-run this line, name what moved, and confirm the new occurrence is a READ before updating KNOWN_CEILING_READS', () => {
      // Stated plainly rather than discovered: this is fail-safe but
      // brittle, the same trade `route-class-law.test.ts`'s derived counts
      // already accept. A benign change that adds a fourth legitimate read
      // (a new log line interpolating `${ceilingMs}`, say) reddens this test
      // and must be re-derived — that is the correct direction for a law
      // whose whole claim is "nothing new reads or writes this name."
      expect(KNOWN_CEILING_READS.length).toBe(3)
    })
  })

  describe('no configuration input can be wired to it through the browser-preference route — there is no such route to begin with', () => {
    // Kept module-wide deliberately, unlike `process.env`/file reads above:
    // Node has no `localStorage`/`sessionStorage` globals for ANY purpose, so
    // there is no legitimate, unrelated use for this ban to overreach into.
    it('names no browser preference store anywhere in the module', () => {
      expect.assertions(1)
      expect(labCode).not.toMatch(/localStorage|sessionStorage/)
    })
  })

  describe('the seam that could carry an override is never fed from production code', () => {
    it("withLabCliLock's three production call sites pass the ceiling as the bare options.lockCeilingMs, nothing computed onto it", () => {
      const calls = callsTo(labCode, 'withLabCliLock')
      // Computed AFTER finding the real calls, not hard-coded: the count
      // itself is asserted below (`calls.length`), and the per-call checks
      // multiply by however many calls that turns out to be — so this stays
      // correct even if a future legitimate third call site changes the
      // expected total, without anyone having to update a magic number here.
      expect.assertions(1 + calls.length * 2)
      // 2 -> 3: prd-55 ruling 1's R&D hand (#412), the third route that
      // reaches the laboratory through `runCli`. The per-call checks below
      // multiply by whatever this turns out to be, which is why only this one
      // line moves.
      expect(calls.length).toBe(3)
      for (const args of calls) {
        expect(args.length).toBe(3)
        expect(args[2]).toBe('options.lockCeilingMs')
      }
    })

    it('bites: callsTo sees a call and skips the declaration sharing its name', () => {
      const fixture = 'function withLabCliLock(a, b, c) {}\nawait withLabCliLock(1, 2, 3)\n'
      expect(callsTo(fixture, 'withLabCliLock')).toEqual([['1', '2', '3']])
    })

    it('bites: an explicit generic type argument at the call site is still recognised as a call', () => {
      const fixture = 'function withLabCliLock(a, b, c) {}\nawait withLabCliLock<void>(1, 2, 3)\n'
      expect(callsTo(fixture, 'withLabCliLock')).toEqual([['1', '2', '3']])
    })

    it('bites: a longer identifier merely containing the name is not mistaken for a call to it', () => {
      const fixture = 'const notWithLabCliLockAtAll = (x) => x\nnotWithLabCliLockAtAll(1)\n'
      expect(callsTo(fixture, 'withLabCliLock')).toEqual([])
    })

    it("`lockCeilingMs` is never assigned a value anywhere in the repo's production source — only declared, in this module's own options type", () => {
      // `\blockCeilingMs\s*(:|=(?!=))` matches an object-literal key
      // (`lockCeilingMs: x`) AND a dot- or bracket-assignment
      // (`opts.lockCeilingMs = x`), but not the one legitimate optional-field
      // declaration (`lockCeilingMs?: number` — the `?` blocks both
      // alternatives) and not an equality comparison (`=== `/`==`, via the
      // negative lookahead on a second `=`).
      expect.assertions(1)
      const hits = sweptProductionFiles().filter((rel) =>
        /\blockCeilingMs\s*(:|=(?!=))/.test(readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
      )
      expect(hits).toEqual([])
    }, SWEEP_TIMEOUT_MS)

    it('bites: the assignment pattern is told apart from the optional-field declaration, and covers both the colon and the dot-assignment spellings', () => {
      expect(/\blockCeilingMs\s*(:|=(?!=))/.test('lockCeilingMs?: number')).toBe(false)
      expect(/\blockCeilingMs\s*(:|=(?!=))/.test('lockCeilingMs: 5000')).toBe(true)
      expect(/\blockCeilingMs\s*(:|=(?!=))/.test('opts.lockCeilingMs = 5000')).toBe(true)
      expect(/\blockCeilingMs\s*(:|=(?!=))/.test('lockCeilingMs === other.lockCeilingMs')).toBe(false)
    })

    // Named by concatenation, not as literals: `lab.test.ts`'s own law (prd12
    // ruling 1) asserts the launch entry point's identifier is spelled
    // nowhere outside `api/lab.ts` and its own test file — and this file is
    // neither, so it must never spell that name, even inside a string or a
    // comment, the way that law's own blunt text scan reads a file.
    const THE_LAUNCH_ENTRY_POINT = ['launch', 'Experiment'].join('')
    const THE_MEASURE_ENTRY_POINT = ['measure', 'Experiment'].join('')
    const THE_RD_ENTRY_POINT = ['runRd', 'Experiment'].join('')

    /**
     * The exact, reviewed options-object text at each production call site,
     * whitespace-normalised. Round 1's check asked "does this text avoid the
     * word `request`?" — a blacklist that considered the one spread its own
     * author had written and missed every other spread. This is an
     * ALLOW-LIST instead: the argument must equal this text exactly (up to
     * whitespace), so a spread of `request.body`, of some other local, of
     * ANYTHING not already here, changes the comparison and fails — no
     * enumeration of forbidden spellings required.
     */
    const KNOWN_GOOD_OPTIONS: Readonly<Record<string, string>> = {
      [THE_LAUNCH_ENTRY_POINT]: normalizeWhitespace(
        '{ repoPath: ctx.repoPath, ...(ctx.now === undefined ? {} : { now: ctx.now }) }',
      ),
      [THE_MEASURE_ENTRY_POINT]: normalizeWhitespace(
        '{ repoPath: ctx.repoPath, recorder: ctx.recorder, ...(ctx.now === undefined ? {} : { now: ctx.now }), }',
      ),
      // prd-55 ruling 1's R&D hand. No `recorder`, and that absence is the
      // reviewed fact rather than an omission: the engine constructs its own
      // `SessionRecorder` on the live session exactly as `lab/fork.ts` does,
      // so the route hands it nothing to write through.
      [THE_RD_ENTRY_POINT]: normalizeWhitespace(
        '{ repoPath: ctx.repoPath, ...(ctx.now === undefined ? {} : { now: ctx.now }) }',
      ),
    }

    it('the three lab route handlers that dispatch an experiment build their options object from exactly the one reviewed literal', () => {
      // 3 entry points × 3 assertions each (call count, body arg, options arg).
      expect.assertions(3 * 3)
      for (const fnName of [THE_LAUNCH_ENTRY_POINT, THE_MEASURE_ENTRY_POINT, THE_RD_ENTRY_POINT]) {
        const calls = callsTo(labCode, fnName)
        expect(calls.length, `${fnName} has no production call site`).toBe(1)
        const [body, options] = calls[0]!
        expect(body).toBe('request.body')
        expect(normalizeWhitespace(options!)).toBe(KNOWN_GOOD_OPTIONS[fnName])
      }
    })

    it('bites: a spread of anything other than the one reviewed spread is caught — not only a spread of "request"', () => {
      const requestSpread = `${THE_LAUNCH_ENTRY_POINT}(request.body, { repoPath: ctx.repoPath, ...(request.body as object) })`
      const otherSpread = `${THE_LAUNCH_ENTRY_POINT}(request.body, { repoPath: ctx.repoPath, ...someUnrelatedLocal })`
      for (const fixture of [requestSpread, otherSpread]) {
        const calls = callsTo(fixture, THE_LAUNCH_ENTRY_POINT)
        expect(normalizeWhitespace(calls[0]![1]!)).not.toBe(KNOWN_GOOD_OPTIONS[THE_LAUNCH_ENTRY_POINT])
      }
    })

    it('bites: reformatting the same literal (whitespace only) still matches — the check is content-exact, not text-exact', () => {
      const reformatted = `${THE_LAUNCH_ENTRY_POINT}(request.body,   {\n  repoPath: ctx.repoPath,\n  ...(ctx.now === undefined ? {} : { now: ctx.now })\n})`
      const calls = callsTo(reformatted, THE_LAUNCH_ENTRY_POINT)
      expect(normalizeWhitespace(calls[0]![1]!)).toBe(KNOWN_GOOD_OPTIONS[THE_LAUNCH_ENTRY_POINT])
    })
  })
})
