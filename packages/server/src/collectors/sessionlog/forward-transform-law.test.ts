import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #45's law — there is exactly ONE forward transform from a filesystem path
 * to a `~/.claude/projects/<slug>` directory name: `worktreePathToProjectSlug`
 * in `worktree-slug.ts`. Nothing else in the tree may hand-roll a second copy
 * of it.
 *
 * `packages/server/src/cli/index.test.ts:250` was exactly that: a fourth,
 * narrower copy (`extraDir.replace(/[/_]/g, '-')`) sitting in the same file
 * that already imports and correctly uses the real helper three times over.
 * It passed only because `os.tmpdir()` contains none of the characters the
 * hand-rolled class was missing — a property of the platform, not of the
 * test.
 *
 * **This law does NOT name the character class**, on purpose. The class has
 * already moved once (prd-42 added the space) and #47 will move it again —
 * `worktree-slug.ts`'s own doc comment records that the real transform read
 * out of Claude Code's shipped binary is `/[^a-zA-Z0-9]/g` plus a length cap
 * and hash suffix, and the six-character class here is a documented subset,
 * not the destination. A law that pinned the class would go red the moment a
 * correct fix landed, and would pass at any wrong-but-matching pair — which
 * is exactly how the original space bug survived a table test for months
 * (AGENTS.md's own account of this PRD). So the property asserted is
 * cardinality — exactly one implementation exists — never its contents.
 * Verified twice, independently: swapping `worktree-slug.ts`'s class to the
 * real one (`/[^a-zA-Z0-9]/g`) leaves this law green.
 *
 * **Three checks, in order of how much a rewrite can dodge them:**
 *
 * 1. `findClaudeProjectsRootJoins` — the PRIMARY check. Every
 *    `path.join(claudeProjectsRoot, <expr>)` (and `path.resolve(...)`, same
 *    idiom) in the tree must have `<expr>` call `worktreePathToProjectSlug`
 *    BY NAME. This is the same move `paths/containment.test.ts`'s
 *    `definitionPattern`/`filesDefining` makes for `isInside`/`canonicalize`
 *    (a name-keyed cardinality law, credited there to #401 step 5), turned
 *    around: that law asks "who DEFINES this name", this one asks "who
 *    INVOKES it at the one call-site shape that needs it". Neither cares
 *    what the transform's regex looks like, so #47 changing the character
 *    class cannot make either one flicker red.
 * 2. `filesDefining('worktreePathToProjectSlug', ...)` — exactly one file
 *    under `packages/server/src` defines the name at all (the direct,
 *    un-turned-around version of the same technique).
 * 3. `findHandRolledForwardTransforms` — a SECONDARY net, scanning the whole
 *    file for the transform's actual OPERATION (folding a separator
 *    character to `-`) regardless of what surrounds it: `.replace(`,
 *    `.replaceAll(` against a bracket literal or `new RegExp(...)`, or
 *    `.split(...).join('-')`. Unlike check 1, this one is NOT anchored to a
 *    `claudeProjectsRoot` join at all — which is what makes it catch a copy
 *    hoisted out to its own line (`const slug = extraDir.split('/').join
 *    ('-')`) or wrapped in a locally-defined helper function, neither of
 *    which check 1 can see once the transform no longer sits inside the join
 *    call's own argument text. A round-2 independent-verification pass found
 *    exactly this hole in an earlier draft (check 3 only recognised
 *    `.replace` against a bracket literal, so `.split`/`.replaceAll`/`new
 *    RegExp` sailed through it even INSIDE a join) and this file's
 *    "the detector bites" tests below pin both the hoisted and
 *    helper-wrapped forms as regression cases.
 *
 * **Known, deliberate gaps** (grepped at the time this law was hardened — no
 * production or test file in this tree hits any of these; if one starts to,
 * that is exactly the review judgment call this law cannot make on its own):
 *
 *   - A transform spelled without ANY of `.replace`/`.replaceAll`/`.split`/
 *     `new RegExp` (a manual character-code loop, say). Check 3 cannot see
 *     it by construction; check 1 only sees it if it sits inside a
 *     `claudeProjectsRoot`/`path.resolve` join.
 *   - A hand-rolled transform using a NEGATED class (`/[^a-zA-Z0-9]/g`, #47's
 *     own real shape) OUTSIDE a join. Check 3 deliberately excludes negated
 *     classes everywhere, not just inside a join — see check 3's own doc
 *     comment for why (`snapshot-store.ts`/`log/paths.ts` would otherwise be
 *     convicted for sanitising a NAME, not a path) — so a hoisted copy of
 *     exactly #47's shape is only caught if it sits inside a join (check 1).
 *   - A transform behind a NAMED regex constant (`SLUG_CHARS`) used OUTSIDE
 *     a join. Check 3 does not resolve what a constant's own definition
 *     contains; check 2 is keyed on the FUNCTION name, not a regex constant
 *     name, so it does not see this either. Only check 1 sees it, and only
 *     inside a join.
 *   - A join built around a DIFFERENTLY NAMED root variable (not
 *     `claudeProjectsRoot`). Check 1's own limit, same as
 *     `containment.test.ts`'s account of the same tradeoff for its root
 *     variable.
 *   - A bare named-import `join(...)` (no `path.` qualifier to anchor on),
 *     or a hand-assembled template path with no `join`/`resolve` call at
 *     all. Check 1 cannot see either; check 3 still catches the transform
 *     ITSELF wherever it sits, so only the name-absence half of the law
 *     (not the transform-presence half) has this blind spot.
 *   - A bare escaped-slash regex with no brackets (`/\//g` — maps ONLY `/`,
 *     an even narrower fourth copy than the six-character class). Not
 *     merely unhandled: PROVEN, while hardening this law, to corrupt
 *     `codeOf`'s comment-stripped text if handled naively, because the
 *     escape's `/` sits immediately next to the closing delimiter's `/` —
 *     the same two-character shape `codeOf` reads as a `//` comment start,
 *     which then blanks everything after it, including the call's own
 *     closing parens. Left unrecognised on purpose rather than "fixed" into
 *     that corruption; a bracket-class spelling of the same idea
 *     (`/[/]/g`) is unaffected and still caught.
 *
 * **What "the tree" means differs between this law and its sibling.** This
 * file reads `git ls-files` — tracked files only, so a new untracked scratch
 * file is invisible to it until `git add`. `paths/prefix-comparison-law.
 * test.ts` walks the filesystem directly and would see that same file
 * immediately. Neither is wrong; a reader should not assume the two mean the
 * same thing by "swept".
 *
 * Grep-law style, same shape as `no-personal-paths-law.test.ts`: real
 * tracked-file text via `git ls-files`, no mocks, and every detector is
 * proven to bite against a snippet CONSTRUCTED in this file — never against
 * a live file, which stops being evidence the moment it is fixed (`#15`) —
 * before it is trusted against the tree. Comments are stripped before
 * scanning (`codeOf`, lifted from `paths/prefix-comparison-law.test.ts:223`,
 * which found the identical problem for its own idiom first): a doc comment
 * quoting either check's trigger text as history — the kind this very file
 * carries in the prose above — would otherwise convict the documentation of
 * the fix it exists to permit.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/**
 * Scoped to `packages/server/src`, not the whole repo: every real call site
 * (`collector.ts`, `index.test.ts`) and the canonical implementation itself
 * live there, and the defect this issue fixes did too. `git ls-files` runs
 * once per process and is cached rather than once per `it()` — this file's
 * first draft called it four separate times across 845 files in a
 * 1,178-file repo, all to answer the same question.
 */
const SCAN_ROOT = 'packages/server/src'

let cachedTrackedFiles: string[] | undefined

function trackedFiles(): string[] {
  if (cachedTrackedFiles === undefined) {
    cachedTrackedFiles = execFileSync('git', ['ls-files', '--', SCAN_ROOT], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0)
  }
  return cachedTrackedFiles
}

/** This law's own file — its rigged examples below deliberately contain trigger text, so the sweep must not check itself. */
const OWN_PATH = 'packages/server/src/collectors/sessionlog/forward-transform-law.test.ts'

/**
 * The one file allowed to define the forward transform. Excluded by identity
 * (a full repo-relative path), never by a naming convention — AGENTS.md's
 * #649 lesson is that a guard scoped by "what a file is called"
 * (`startsWith('claude-code-')`) misses siblings that predate the
 * convention. There is exactly one legitimate definition site, so the
 * allowlist is a single path, checked for real existence below rather than
 * assumed.
 */
const CANONICAL_IMPLEMENTATION_PATH = 'packages/server/src/collectors/sessionlog/worktree-slug.ts'

/**
 * Only actual source files can HAND-ROLL an implementation — a PRD or design
 * note quoting the defect's exact line as historical evidence (this PRD does,
 * `docs/prds/prd-42-one-path-one-spelling.md:26`, citing the very code this
 * issue removes) is prose about the code, not a second copy of it. Scoping by
 * extension, rather than by an explicit per-file exclusion, is the AGENTS.md
 * #649 discipline applied to the allow side: a hand-authored exclusion list
 * only ever grows to cover files that already tripped the detector, and goes
 * on missing the next markdown file that quotes the same snippet.
 */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function scannableTrackedFiles(): string[] {
  return trackedFiles().filter(
    (file) =>
      file !== OWN_PATH &&
      file !== CANONICAL_IMPLEMENTATION_PATH &&
      CODE_EXTENSIONS.some((ext) => file.endsWith(ext)),
  )
}

/**
 * For check 2, which must be able to find `CANONICAL_IMPLEMENTATION_PATH`
 * (unlike `scannableTrackedFiles`, which excludes it) — this file's own
 * rigged definition-pattern examples above are string literals containing
 * `function worktreePathToProjectSlug(p) {` and
 * `const worktreePathToProjectSlug = (p) => {`, which would otherwise trip
 * check 2's sweep on itself.
 */
function trackedFilesExcludingSelf(): string[] {
  return trackedFiles().filter((file) => file !== OWN_PATH)
}

/**
 * Code with comments blanked out — not deleted, so line/column positions
 * inside a matched snippet do not shift. Copied from `paths/prefix-
 * comparison-law.test.ts:223` (`codeOf`), which hit this exact problem for a
 * different idiom first: its own fixed file (`server/static.ts`) carries a
 * comment quoting the removed code verbatim to explain why it was wrong, and
 * scanning raw text flagged the comment praising the fix. Every detector
 * below is applied to `codeOf(contents)`, never raw `contents`, for the same
 * reason — proven below against a constructed comment, never a live file.
 */
function codeOf(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

// ---------------------------------------------------------------------------
// Check 1 (PRIMARY): every claudeProjectsRoot join calls the name, whatever
// shape its argument would otherwise take.
// ---------------------------------------------------------------------------

/**
 * From `openParenIndex` (the position of a `(`), returns the text through
 * its matching `)`, honouring nesting — so a call like
 * `path.join(claudeProjectsRoot, worktreePathToProjectSlug(dir.worktreePath))`
 * is captured whole rather than truncated at the FIRST `)`, and so a
 * prettier-wrapped call spanning several lines is captured just the same
 * (nothing here anchors to a single line).
 */
function extractBalancedCall(contents: string, openParenIndex: number): string {
  let depth = 1
  let i = openParenIndex + 1
  while (i < contents.length && depth > 0) {
    if (contents[i] === '(') depth += 1
    else if (contents[i] === ')') depth -= 1
    i += 1
  }
  return contents.slice(openParenIndex, i)
}

/**
 * `path.join(` or `path.resolve(` — both build a path out of `claudeProjectsRoot`
 * the same way for this law's purposes. Does NOT anchor on a bare named-import
 * `join(...)` (no `path.` qualifier) or a hand-assembled template path with no
 * join/resolve call at all — see the file doc comment's "known gaps".
 */
const PATH_JOIN_PATTERN = /\bpath\.(join|resolve)\(/g

interface ClaudeProjectsRootJoin {
  call: string
  usesNamedTransform: boolean
}

/**
 * A `claudeProjectsRoot` join is only IN SCOPE for this check if its
 * argument is either a correct call to the sanctioned name, or attempts a
 * path-to-slug transform some OTHER way — recognised by one of the method
 * calls every spelling of that transform reaches for (`.replace(`,
 * `.replaceAll(`, `.split(`) or a hand-built regex (`new RegExp(`). Plenty
 * of legitimate joins pass a plain string literal fixture slug
 * (`'a-project'`, `PROJECT_SLUG`) or a variable that was already computed
 * correctly on an earlier line (`const parentSlug =
 * worktreePathToProjectSlug(repoDir)`, reused later as
 * `path.join(claudeProjectsRoot, parentSlug)`) — neither is an attempt at a
 * transform at this call site at all, and an earlier draft of this check
 * convicted both, which would have made this law red on the tree it exists
 * to protect.
 */
const TRANSFORM_ATTEMPT_PATTERN = /\.replace\(|\.replaceAll\(|\.split\(|\bnew\s+RegExp\(|\bworktreePathToProjectSlug\s*\(/

/**
 * Every `path.join(...)`/`path.resolve(...)` call in `contents` whose
 * arguments mention `claudeProjectsRoot` AND attempt a path-to-slug
 * transform (see above), tagged with whether that call invokes
 * `worktreePathToProjectSlug(` by name anywhere inside it. A join that
 * mentions the root, tries to transform its own argument, and never calls
 * the sanctioned name is a hand-rolled slug by construction — whatever
 * method it reached for to do the transforming.
 */
function findClaudeProjectsRootJoins(contents: string): ClaudeProjectsRootJoin[] {
  const code = codeOf(contents)
  const results: ClaudeProjectsRootJoin[] = []
  for (const match of code.matchAll(PATH_JOIN_PATTERN)) {
    const calleeName = `path.${match[1]}`
    const openParenIndex = match.index + match[0].length - 1
    const args = extractBalancedCall(code, openParenIndex)
    if (!/\bclaudeProjectsRoot\b/.test(args)) continue
    if (!TRANSFORM_ATTEMPT_PATTERN.test(args)) continue
    results.push({
      call: `${calleeName}${args}`,
      usesNamedTransform: /\bworktreePathToProjectSlug\s*\(/.test(args),
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Check 2: exactly one file defines the name — `paths/containment.test.ts`'s
// `definitionPattern`/`filesDefining` technique, applied to this name.
// ---------------------------------------------------------------------------

/**
 * Matches a function declaration or a const-arrow/function-expression
 * assignment naming `name`. The trailing `\w*` is load-bearing for the same
 * reason `containment.test.ts:254` documents for its own use of it: a bare
 * `name\s*\(` would miss a competing definition spelled
 * `worktreePathToProjectSlugForWindows` or similar, and a name-keyed law
 * that only catches the exact spelling it was filed about is barely a law.
 */
function definitionPattern(name: string): RegExp {
  return new RegExp(`\\bfunction\\s+${name}\\w*\\s*\\(|\\bconst\\s+${name}\\w*\\s*[:=]`)
}

function filesDefining(name: string, files: readonly string[]): string[] {
  const pattern = definitionPattern(name)
  return files.filter((file) => pattern.test(codeOf(readFileSync(`${REPO_ROOT}/${file}`, 'utf8'))))
}

// ---------------------------------------------------------------------------
// Check 3 (SECONDARY net): the transform's actual OPERATION, wherever it
// sits — not anchored to a claudeProjectsRoot join at all.
// ---------------------------------------------------------------------------

/**
 * `.replace(/[...]/g, '-')` or `.replaceAll(/[...]/g, '-')`, any regex flags
 * — the shape of the original defect at `:250`.
 *
 * Deliberately requires a BRACKET expression, not a bare escaped slash
 * (`/\//g`, no brackets at all). A regex literal that matches a literal `/`
 * without brackets always puts two `/` characters back-to-back (the escape's
 * own `/` immediately followed by the literal's closing delimiter) — and
 * `codeOf`'s line-comment stripper, borrowed as-is from the sibling law, sees
 * that same two-character sequence as a `//` comment start and blanks
 * everything after it, up to and including the call's own closing parens.
 * Widening this pattern to also accept `\/` therefore does not add coverage;
 * it adds a codeOf/regex-detector interaction bug (proven, not assumed:
 * constructing exactly that case here corrupted the balanced-paren extraction
 * check 1 relies on). Left as a documented gap below rather than "solved" by
 * a detector whose passing tests would trace to that corruption instead of
 * to genuine detection.
 */
const FORWARD_REPLACE_PATTERN = /\.(?:replace|replaceAll)\(\/(\[[^\]]*\])\/[a-z]*,\s*(['"])-\2\)/g

/**
 * `.replace(new RegExp('[...]', 'flags'), '-')` — the same idiom with the
 * regex built from a string at runtime instead of a literal.
 */
const NEW_REGEXP_REPLACE_PATTERN = /\.replace\(\s*new\s+RegExp\(\s*(['"])(\[[^\]]*\])\1(?:\s*,\s*(['"])[a-z]*\3)?\s*\)\s*,\s*(['"])-\4\)/g

/**
 * `.split('/').join('-')` or `.split(path.sep).join('-')` — the exact
 * spelling round-2 independent verification used to show an earlier draft of
 * this check was join-scoped only. Grepped at the time this was written: no
 * real file in `packages/server/src` chains a `.split(...)` into
 * `.join('-')` — the real occurrences of `.split('/')` (`concierge/repos.ts`
 * has none; `app/src/host/no-fork.ts` and `core/src/state.ts` do, both for
 * unrelated parsing) never rejoin with a dash.
 */
const SPLIT_JOIN_DASH_PATTERN = /\.split\(\s*(?:(['"])\/\1|path\.sep)\s*\)\.join\(\s*(['"])-\2\s*\)/g

/**
 * `.replaceAll('/', '-')` — a single call is enough evidence on its own,
 * since folding `/` specifically is the one thing no path-flattening scheme
 * can skip (see check 3's discriminator below). Deliberately narrower than
 * "any `.replaceAll(<single-char>, '-')`": a lone `.replaceAll('_', '-')`
 * elsewhere, never paired with a slash fold, is not distinguishable from an
 * unrelated rename utility by text alone.
 */
const REPLACEALL_SLASH_DASH_PATTERN = /\.replaceAll\(\s*(['"])\/\1\s*,\s*(['"])-\2\s*\)/g

/**
 * That `/`-in-a-positive-class test is the discriminator that keeps the
 * regex-literal patterns above from convicting code that merely looks
 * similar:
 *
 * - `snapshot-store.ts` and `log/paths.ts` sanitise a single NAME
 *   (`collectorName`, a filesystem-safe stem) with a NEGATED class
 *   (`/[^a-z0-9-]+/g`) — negated classes are excluded outright, since they
 *   describe "everything but", not "these separators", and are a different
 *   kind of transform (sanitising one token) from folding a whole PATH's
 *   separators to `-`. This is also why #47's own real shape
 *   (`/[^a-zA-Z0-9]/g`) is a known gap for this check outside a join — see
 *   the file doc comment.
 * - `concierge/repos.ts`'s reverse walk re-encodes a single directory ENTRY
 *   for comparison (`entry.replace(/[._ ]/g, '-')`) — a positive class, but
 *   one that never lists `/`, because it already operates on a path segment
 *   with no separator left in it. It is the sibling *reverse* direction
 *   this same file's doc comment calls out, not a second forward transform.
 *
 * A forward path-to-slug transform must fold `/` — that is the one
 * character no path-flattening scheme can skip — so a positive class (or the
 * bare-escaped-slash form) that includes it is the signature of a second,
 * competing implementation.
 */
function findHandRolledForwardTransforms(contents: string): string[] {
  const code = codeOf(contents)
  const hits: string[] = []

  for (const match of code.matchAll(FORWARD_REPLACE_PATTERN)) {
    const body = match[1]
    if (body === undefined) continue
    if (body.startsWith('[^')) continue
    if (!body.includes('/')) continue
    hits.push(match[0])
  }

  for (const match of code.matchAll(NEW_REGEXP_REPLACE_PATTERN)) {
    const charClass = match[2]
    if (charClass === undefined) continue
    if (charClass.startsWith('[^')) continue
    if (!charClass.includes('/')) continue
    hits.push(match[0])
  }

  for (const match of code.matchAll(SPLIT_JOIN_DASH_PATTERN)) {
    hits.push(match[0])
  }

  for (const match of code.matchAll(REPLACEALL_SLASH_DASH_PATTERN)) {
    hits.push(match[0])
  }

  return hits
}

describe('forward transform law: worktreePathToProjectSlug is the only path-to-slug implementation', () => {
  it('has a tree to walk, and the canonical implementation and a real call site are both in the SCANNED set — an empty sweep proves nothing', () => {
    // Round-2 independent verification found this checking `trackedFiles()`
    // (unfiltered) while both sweeps below actually iterate
    // `scannableTrackedFiles()` — mutating CODE_EXTENSIONS to something that
    // matches nothing emptied the scanned set while this check stayed green,
    // because it was watching a set neither sweep consumes. Checking the
    // scanned set directly, and requiring a real production file (not just
    // the canonical implementation, which scannableTrackedFiles() excludes
    // on purpose) closes that.
    const scanned = scannableTrackedFiles()
    expect(scanned.length).toBeGreaterThan(20)
    expect(scanned).toContain('packages/server/src/collectors/sessionlog/collector.ts')
    expect(trackedFiles()).toContain(CANONICAL_IMPLEMENTATION_PATH)
  })

  it('the canonical implementation is tracked and excluded by its real path, not a guessed one', () => {
    expect(trackedFiles()).toContain(CANONICAL_IMPLEMENTATION_PATH)
    expect(scannableTrackedFiles()).not.toContain(CANONICAL_IMPLEMENTATION_PATH)
  })

  describe('check 1 (primary): every claudeProjectsRoot join calls worktreePathToProjectSlug by name', () => {
    it('does NOT fire on the correct call, single-line', () => {
      const rigged = "const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(extraDir))"
      expect(findClaudeProjectsRootJoins(rigged)).toEqual([
        { call: 'path.join(claudeProjectsRoot, worktreePathToProjectSlug(extraDir))', usesNamedTransform: true },
      ])
    })

    it('does NOT fire on the correct call wrapped across multiple lines — a prettier reformat is not a defect', () => {
      const rigged = [
        'const projectDir =',
        '  dir.sessionDirOverride ??',
        '  path.join(',
        '    claudeProjectsRoot,',
        '    worktreePathToProjectSlug(dir.worktreePath),',
        '  )',
      ].join('\n')
      const joins = findClaudeProjectsRootJoins(rigged)
      expect(joins).toHaveLength(1)
      expect(joins[0]?.usesNamedTransform).toBe(true)
    })

    it('fires on the reintroduced defect, whatever it is spelled — proving check 1 is shape-independent where check 3 (pre-fix) was not', () => {
      const mutations = [
        "extraDir.replace(/[/_]/g, '-')", // the original defect, and check 3's working control
        "extraDir.split('/').join('-')", // round-2's exact reintroduction
        "extraDir.split(path.sep).join('-')",
        "extraDir.replaceAll('/', '-').replaceAll('_', '-')",
        "extraDir.replace(/[^a-zA-Z0-9]/g, '-')", // #47's real shape — must still be a defect at THIS call site
        "extraDir.replace(/[/_]/gu, '-')",
        "extraDir.replaceAll(/[/_]/g, '-')",
        'extraDir.replace(SLUG_CHARS, "-")', // a named regex constant
        "extraDir.replace(new RegExp('[/_]', 'g'), '-')",
        '`${extraDir}`.replace(/[/_]/g, \'-\')', // a template-wrapped variant
      ]
      for (const expr of mutations) {
        const rigged = `const projectDir = path.join(claudeProjectsRoot, ${expr})`
        const joins = findClaudeProjectsRootJoins(rigged)
        expect(joins, `expected exactly one join for: ${rigged}`).toHaveLength(1)
        expect(joins[0]?.usesNamedTransform, `expected a violation for: ${expr}`).toBe(false)
      }
    })

    it('fires on path.resolve(claudeProjectsRoot, ...) too, not only path.join', () => {
      const rigged = "path.resolve(claudeProjectsRoot, extraDir.split('/').join('-'))"
      expect(findClaudeProjectsRootJoins(rigged)).toEqual([{ call: rigged, usesNamedTransform: false }])
    })

    it('fires on the defect wrapped across multiple lines too — formatting is not what makes check 1 blind', () => {
      const rigged = ['const projectDir = path.join(', '  claudeProjectsRoot,', "  extraDir.split('/').join('-'),", ')'].join(
        '\n',
      )
      const joins = findClaudeProjectsRootJoins(rigged)
      expect(joins).toHaveLength(1)
      expect(joins[0]?.usesNamedTransform).toBe(false)
    })

    it('ignores a path.join call that never mentions claudeProjectsRoot at all', () => {
      const rigged = "const dataDir = path.join(root, 'data')"
      expect(findClaudeProjectsRootJoins(rigged)).toEqual([])
    })

    it('ignores a claudeProjectsRoot join passed a literal fixture slug or a variable already computed correctly — the real shapes in namespace-law.test.ts and transcript-capture.test.ts', () => {
      expect(findClaudeProjectsRootJoins("path.join(claudeProjectsRoot, 'a-project')")).toEqual([])
      expect(findClaudeProjectsRootJoins('path.join(claudeProjectsRoot, PROJECT_SLUG)')).toEqual([])
      const rigged = [
        'const parentSlug = worktreePathToProjectSlug(repoDir)',
        'const parentDir = path.join(claudeProjectsRoot, parentSlug)',
      ].join('\n')
      // Neither line is a violation: the first has no path.join/resolve call
      // at all (out of this detector's reach entirely, by design — it only
      // looks at join/resolve arguments); the second's argument is a bare
      // identifier with no transform attempt, so it is out of scope too.
      expect(findClaudeProjectsRootJoins(rigged)).toEqual([])
    })

    it('does NOT fire on a comment that merely quotes the defect shape as history — the trigger for MUST FIX 2', () => {
      // Constructed, not live: worktree-slug.test.ts:139 already carries a
      // comment-quoted regex class today, and a doc comment ABOVE THIS VERY
      // FILE quotes several defect spellings as history too — the exact
      // shape a raw-text scan (pre-codeOf) would have convicted.
      const rigged = [
        '// A previous draft hand-rolled this instead of calling the helper:',
        "//   path.join(claudeProjectsRoot, extraDir.split('/').join('-'))",
        'const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(extraDir))',
      ].join('\n')
      const joins = findClaudeProjectsRootJoins(rigged)
      expect(joins).toEqual([
        { call: 'path.join(claudeProjectsRoot, worktreePathToProjectSlug(extraDir))', usesNamedTransform: true },
      ])
    })

    it('no path.join/resolve(claudeProjectsRoot, ...) call in the tree omits worktreePathToProjectSlug', () => {
      const violations: string[] = []
      for (const file of scannableTrackedFiles()) {
        const contents = readFileSync(`${REPO_ROOT}/${file}`, 'utf8')
        for (const join of findClaudeProjectsRootJoins(contents)) {
          if (!join.usesNamedTransform) violations.push(`${file}: ${join.call}`)
        }
      }
      expect(violations).toEqual([])
    })
  })

  describe('check 2: exactly one file under packages/server/src defines worktreePathToProjectSlug', () => {
    it('the definition pattern fires on a function declaration and a const-arrow form, not on a mere reference', () => {
      expect(definitionPattern('worktreePathToProjectSlug').test('function worktreePathToProjectSlug(p) {')).toBe(true)
      expect(definitionPattern('worktreePathToProjectSlug').test('const worktreePathToProjectSlug = (p) => {')).toBe(true)
      expect(definitionPattern('worktreePathToProjectSlug').test('worktreePathToProjectSlug(extraDir)')).toBe(false)
      expect(definitionPattern('worktreePathToProjectSlug').test("import { worktreePathToProjectSlug } from './x.js'")).toBe(
        false,
      )
    })

    it('the pattern also catches a \\w*-suffixed spelling of the same name, the same way containment.test.ts documents needing to', () => {
      expect(definitionPattern('worktreePathToProjectSlug').test('function worktreePathToProjectSlugForWindows(p) {')).toBe(
        true,
      )
    })

    it('does NOT fire on a comment that merely mentions the name', () => {
      const rigged = ['// function worktreePathToProjectSlug(p) { ... }', "import { worktreePathToProjectSlug } from './x.js'"].join(
        '\n',
      )
      expect(definitionPattern('worktreePathToProjectSlug').test(codeOf(rigged))).toBe(false)
    })

    it('is defined in exactly worktree-slug.ts', () => {
      const defining = filesDefining('worktreePathToProjectSlug', trackedFilesExcludingSelf())
      expect(defining).toEqual([CANONICAL_IMPLEMENTATION_PATH])
    })
  })

  describe('check 3 (secondary net): the transform operation itself, wherever it sits', () => {
    it('fires on the exact defect this issue fixed', () => {
      const rigged = "const projectDir = path.join(root, extraDir.replace(/[/_]/g, '-'))"
      expect(findHandRolledForwardTransforms(rigged)).toEqual([".replace(/[/_]/g, '-')"])
    })

    it('fires on a differently-ordered, differently-sized class — it is not keyed to one literal spelling', () => {
      expect(findHandRolledForwardTransforms('x.replace(/[_/. ]/g, "-")')).toHaveLength(1)
      expect(findHandRolledForwardTransforms("y.replace(/[\\\\:/]/g, '-')")).toHaveLength(1)
    })

    it('fires on .replaceAll against the same bracket-literal shape, any flags — not just .replace with /g', () => {
      expect(findHandRolledForwardTransforms("x.replaceAll(/[/_]/gu, '-')")).toHaveLength(1)
    })

    it('does NOT fire on a bare escaped-slash regex with no brackets (/\\//g) — a documented gap, not a silent one', () => {
      // `/\//g` puts the escape's `/` immediately next to the closing
      // delimiter's `/`, i.e. two `/` characters back-to-back — the same
      // shape `codeOf`'s line-comment stripper reads as a `//` comment
      // start. Widening FORWARD_REPLACE_PATTERN to accept this form does not
      // add coverage; it corrupts the comment-stripped text this detector
      // (and check 1's paren-balancing) both depend on. See this file's doc
      // comment "known gaps" and the comment above FORWARD_REPLACE_PATTERN.
      const rigged = "`${extraDir}`.replace(/\\//g, '-')"
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('fires on .replace(new RegExp(\'[...]\', flags), \'-\')', () => {
      const rigged = "extraDir.replace(new RegExp('[/_]', 'g'), '-')"
      expect(findHandRolledForwardTransforms(rigged)).toHaveLength(1)
    })

    it('fires on the HOISTED form — round-2\'s exact regression: the transform moved one line above the join it feeds', () => {
      const rigged = ["const slug = extraDir.split('/').join('-')", 'return path.join(claudeProjectsRoot, slug)'].join('\n')
      expect(findHandRolledForwardTransforms(rigged)).toEqual([".split('/').join('-')"])
    })

    it('fires on the HELPER-WRAPPED form — round-2\'s other exact regression: the transform hidden behind a locally-defined function', () => {
      const rigged = [
        'const reviewOnlySlug = (v) => v.split(\'/\').join(\'-\')',
        'return path.join(claudeProjectsRoot, reviewOnlySlug(extraDir))',
      ].join('\n')
      expect(findHandRolledForwardTransforms(rigged)).toEqual([".split('/').join('-')"])
    })

    it('fires on a .split(path.sep).join(\'-\') hoisted the same way', () => {
      const rigged = ['const slug = extraDir.split(path.sep).join(\'-\')', 'return path.join(claudeProjectsRoot, slug)'].join(
        '\n',
      )
      expect(findHandRolledForwardTransforms(rigged)).toHaveLength(1)
    })

    it('fires on a lone .replaceAll(\'/\', \'-\') — one call is enough evidence, chained or not', () => {
      expect(findHandRolledForwardTransforms("extraDir.replaceAll('/', '-')")).toHaveLength(1)
      expect(findHandRolledForwardTransforms("extraDir.replaceAll('/', '-').replaceAll('_', '-')")).toHaveLength(1)
    })

    it('does NOT fire on a negated class sanitising a single name — the snapshot-store / log-paths shape', () => {
      const rigged = "collectorName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')"
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('does NOT fire on the reverse walk re-encoding a bare entry name — no `/` in its class', () => {
      const rigged = "const encoded = entry.replace(/[._ ]/g, '-')"
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('does NOT fire on an unrelated positive class that never lists a path separator', () => {
      const rigged = "value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')"
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('does NOT fire on a lone .replaceAll(\'_\', \'-\') that never touches a slash — not distinguishable from an unrelated rename utility', () => {
      expect(findHandRolledForwardTransforms("value.replaceAll('_', '-')")).toEqual([])
    })

    it('does NOT fire on an unrelated .split(...).join(...) that never rejoins with a dash — the real no-fork.ts/state.ts shape', () => {
      expect(findHandRolledForwardTransforms("specifier.split('/').slice(0, 2).join('/')")).toEqual([])
      expect(findHandRolledForwardTransforms("path.split('/').filter((s) => s.length > 0)")).toEqual([])
    })

    it('does NOT fire on an unrelated new RegExp(...) whose replacement is not a literal dash — the real adr-log-law.test.ts shape', () => {
      const rigged = 'text.replace(new RegExp(`^\\\\|\\\\s*\\\\[${n}\\\\].*$`, \'m\'), `see [${n}](${f}) in prose`)'
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('does NOT fire on a comment that merely quotes the defect shape as history — the trigger for MUST FIX 2', () => {
      const rigged = [
        '// This class used to be missing the space:',
        "//   worktreePath.replace(/[/_. ]/g, '-')",
        "const encoded = entry.replace(/[._ ]/g, '-') // reverse-direction, no slash",
      ].join('\n')
      expect(findHandRolledForwardTransforms(rigged)).toEqual([])
    })

    it('no tracked file outside worktree-slug.ts hand-rolls this operation, wherever it sits', () => {
      const violations: string[] = []
      for (const file of scannableTrackedFiles()) {
        const contents = readFileSync(`${REPO_ROOT}/${file}`, 'utf8')
        for (const hit of findHandRolledForwardTransforms(contents)) {
          violations.push(`${file}: ${hit}`)
        }
      }
      expect(violations).toEqual([])
    })
  })
})
