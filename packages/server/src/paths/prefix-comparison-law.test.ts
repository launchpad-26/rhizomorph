import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE SECOND CONTAINMENT CHECK IS A DEFECT, EVEN WHEN IT IS SAFE TODAY
 * (prd-42 ruling 2, #401).
 *
 * Ruling 2, verbatim: "a path-containment comparison written outside
 * `paths/containment.ts` is a defect regardless of whether it is currently
 * exploitable. `#401`'s lesson is that the second copy is where the next hole
 * lives, and low exploitability today is not the same as correctness." This
 * file makes that structural rather than relying on review to notice a new
 * copy.
 *
 * **The tension this detector has to hold.** There are ~30 `startsWith` call
 * sites in `packages/server/src` production source; the large majority are
 * string PARSING, not containment — git porcelain, CLI argument handling,
 * slug shape checks, dotfile skips, diff markers, workmux table headers,
 * array `.indexOf`, HTTP route prefixes, git-ref parsing. What decides
 * containment is a candidate compared against a *root variable* — but
 * "compared against a variable, not a literal" is a SYNTACTIC test, and
 * `line.startsWith(marker)`, `argv.indexOf(flag) === 0` and
 * `` ref.startsWith(`${remote}/`) `` are all syntactically identical to the
 * real idiom while being ordinary parsing. The actual signal is SEMANTIC —
 * is the thing on the left a filesystem path, and the thing on the right a
 * root — and a line-oriented text scan cannot know that directly. What it
 * can check is a proxy: does this line sit near an actual `node:path` call
 * (`path.resolve`, `path.relative`, `path.sep`, ...)? Real containment code
 * almost always does; the parsing call sites surveyed above almost never do.
 * That proxy is what `hasPathContextNearby` checks, and every shape below
 * that isn't already anchored on `path.relative` itself requires it. This
 * cannot be made perfect without full type information (an array's
 * `.indexOf` and a string's are indistinguishable by text alone) — the
 * choice made here, on explicit advice from two rounds of independent
 * verification, is to prefer FEWER false positives over broader syntactic
 * coverage: a law with noisy convictions gets silenced, which catches
 * nothing.
 *
 *   1. `X.startsWith(root)` / `X.startsWith((root))` / `X.startsWith(root +
 *      path.sep)` — a non-literal (identifier) argument, with `path.*`
 *      context nearby. This is the idiom wave 2 removed from
 *      `server/static.ts` (`requested.startsWith(root)`, computed one line
 *      after `path.resolve(root, ...)`) and is what distinguishes it from a
 *      literal-argument parsing call: a parsing check tests against a known
 *      string, a containment check tests against a *root variable*, near
 *      actual path arithmetic.
 *   2. `X.startsWith(\`${root}...\`)` — the same idiom spelled with a
 *      template literal instead of `+`. A template is only this shape when
 *      it is built ENTIRELY from interpolation and path separators — no
 *      other literal text — AND has `path.*` context nearby (the same
 *      requirement as shape 1; a bare `` `${bucket}` `` or `` `${remote}/` ``
 *      with no path arithmetic nearby is left alone even though its literal
 *      remainder is empty or a single slash). `` `${s.flag}=` `` (a real
 *      CLI-parsing call, `cli/args.ts:85`) and `` `${encoded}-` `` (a real
 *      slug check, `concierge/repos.ts:234`) both fail on the literal-text
 *      test alone: "=" and "-" are not `path.sep`. `` `${root}${path.sep}` ``
 *      has nothing left after stripping interpolation — that emptiness,
 *      plus the `path.sep` context it carries on the very same line, is the
 *      tell. The first version of this law required an identifier
 *      immediately after the open paren and missed the template spelling
 *      entirely: planted as a real file, it passed 13/13 green. A later
 *      version added the template check but with no context requirement,
 *      which then convicted `` ref.startsWith(`${remote}/`) `` and
 *      `` pathname.startsWith(`${basePath}/`) `` — ordinary git-ref and
 *      HTTP-route parsing. See "the detector bites" / "does NOT fire" below
 *      for both mutations.
 *   3. `X.indexOf(root) === 0` / `!== 0` / `== 0` / `!= 0`, and
 *      `X.slice(0, root.length)` / `X.substring(0, root.length)` compared
 *      with `=== root` / `!== root` — the same "is X prefixed by this root
 *      variable" test spelled other ways, all requiring `path.*` context
 *      nearby and (for slice/substring) a backreference requiring the
 *      identical identifier on both sides so an unrelated
 *      `a.slice(0, b.length) !== c` cannot fire. `argv.indexOf(flag) === 0`
 *      is an ARRAY `.indexOf` — indistinguishable from a string's by text
 *      alone — but it also carries no `path.*` context, so the context
 *      requirement is what keeps it out; a hypothetical array `.indexOf`
 *      check that happened to sit beside unrelated path arithmetic is a
 *      known, accepted residual (see "Known, deliberate gaps" below).
 *   4. `path.relative(root, X)` / `path.posix.relative(root, X)` followed,
 *      within `RELATIVE_WINDOW` lines, by a `startsWith('..')`,
 *      `isAbsolute(...)` or `.split(path.sep)[0] !== '..'` test on the
 *      result — the idiom the three allowlisted collector sites below use.
 *      `path.relative`/`path.posix.relative` is inherently `path.*` context
 *      for itself; no separate check is layered on.
 *
 * **Known, deliberate gaps**, left alone rather than chased with an
 * increasingly fragile regex:
 *   - A *named* import of `relative`/`sep` used bare (`import { relative }
 *     from 'node:path'; relative(root, x)`, with no `path.` qualifier to
 *     anchor `hasPathContextNearby` on). Grepped at the time this law was
 *     hardened: no production or test file in this tree does this.
 *   - A `startsWith`/`.relative(`/`.indexOf(`/`.slice(` call whose arguments
 *     a formatter has wrapped onto their own lines — a line-oriented scan
 *     sees the call and its argument as separate lines with nothing to
 *     connect them syntactically the way the `path.relative(...)` window
 *     does for shape 4.
 *   - `path.relative(root, X)` whose follow-up check sits further than
 *     `RELATIVE_WINDOW` lines away, or whose `path.*` context for shapes
 *     1–3 sits further than `PATH_CONTEXT_LINES_BEFORE`/`_AFTER` lines away.
 *     Both windows are sized to the real idioms found in this tree (see the
 *     constants below for the specific real sites each bound was set to
 *     cover) plus a small margin, not to an arbitrary "generous" number —
 *     a wider window finds more of this gap at the cost of finding more
 *     coincidental false positives, and this law errs toward the latter
 *     cost being worse.
 *   - An array `.indexOf`/`.slice` check that, by coincidence, sits within
 *     the context window of unrelated `path.*` arithmetic in the same
 *     function. Not observed anywhere in this tree; accepted as the price
 *     of a proxy signal rather than real type information.
 *   - A `.startsWith`/`.indexOf`/`.slice` call spelled through a helper or
 *     re-exported alias (`const sw = String.prototype.startsWith; ...`) —
 *     no call site in this tree does this.
 *   - A genuine containment check whose immediate surroundings do NO other
 *     `path.*` module work at all — no `path.resolve`, no `path.sep`,
 *     nothing — within the context window. `hasPathContextNearby` is what
 *     keeps `argv.indexOf(flag) === 0` and `line.startsWith(marker)` out
 *     (neither has ANY nearby `path.*` call); the same gate, applied
 *     uniformly, also misses `requested.slice(0, root.length) === root` and
 *     even the law's own founding idiom, bare `requested.startsWith(root)`,
 *     when planted with zero surrounding `path.*` work. This is NOT an
 *     operator asymmetry (`===` vs `!==`) or a shape-specific gap — proven
 *     by mutation, `===` and `!==` are equally caught with context present
 *     and equally missed without it, and the identical bare-context miss
 *     reproduces on `startsWith-root` itself, the shape this whole law was
 *     built to catch. It is the uniform cost of the context proxy: nothing
 *     short of real type/dataflow information can tell a rootless
 *     `indexOf`/`slice`/`startsWith` check apart from array or unrelated-
 *     string code once neither has any path-module evidence nearby, and
 *     every real site in this tree (the three allowlisted collectors, the
 *     historical static.ts idiom, static.ts's `path.resolve` one line
 *     above) does carry that evidence. Loosening the gate for `indexOf`/
 *     `slice` alone, to close this, was tried and rejected: it re-convicts
 *     `argv.indexOf(flag) === 0` immediately, which is the regression
 *     `hasPathContextNearby` exists to prevent.
 * A line-oriented text scan — the same style `no-personal-paths-
 * law.test.ts` and `retarget-law.test.ts` already use in this package — is
 * the right tool for the shapes above; chasing every one of these gaps into
 * full AST-with-types territory is not, and pretending otherwise would trade
 * a short, honest list for a much larger surface of new false positives.
 *
 * Comments are stripped before scanning (`codeOf`) for a reason discovered
 * writing this file, not a hypothetical one: `server/static.ts`'s own fixed
 * code carries a comment that quotes the removed idiom verbatim
 * (`` `startsWith(root)` ``) to explain why it was wrong. Scanning raw text
 * would flag the very comment praising the fix. The blanking preserves every
 * newline (spaces in, newlines untouched) rather than deleting comment text
 * outright, because line numbers below are load-bearing and deleting a
 * multi-line block comment would shift every following line up.
 *
 * **The allowlist is the ratchet, keyed on file + matched source line, not
 * file + line NUMBER.** Three real containment implementations exist outside
 * `containment.ts` today, none of them in this issue's fence:
 * `collectors/sessionlog/process-probe.ts`, `collectors/sessionlog/
 * collector.ts` and `collectors/pi/collector.ts`. The law does not pretend
 * they aren't there — it names all three, with a reason each, and asserts
 * the set of sites the detector actually finds equals the allowlist EXACTLY
 * (`toEqual`, both directions), the same ratchet shape `scripts/gate.sh`
 * uses on timing tests:
 *
 *   - A fourth site (new defect) makes the detected set a superset of the
 *     allowlist → mismatch → fails immediately. That is the whole point.
 *   - A site quietly migrated into `containment.ts` without deleting its
 *     allowlist entry makes the allowlist a superset of the detected set →
 *     mismatch → fails too, forcing that edit to be deliberate rather than
 *     leaving a stale entry nobody re-checks.
 *
 * The key is the matched line's own text, not its line number, on purpose:
 * an earlier version keyed on `file:line`, so an unrelated edit — adding one
 * comment line above `collectors/pi/collector.ts:547` — moved the idiom to
 * line 548 and failed two tests, one of them reporting "migrated? remove the
 * allowlist entry", which is exactly the wrong diagnosis for what happened.
 * The matched text does not move when unrelated lines do.
 *
 * `process-probe.ts` carries a reason the other two do not: round-2
 * verification examined it on its merits and found it not a defect — it
 * deliberately compares a kernel-canonical `/proc/<pid>/cwd` against a
 * canonicalised root, documents that asymmetry, and fails closed on a
 * canonicalize error. Without that note recorded here, a later reader could
 * "fix" a considered asymmetry. The two collector sites carry no such
 * reasoning; they are migration candidates for a follow-up issue, not this
 * one.
 *
 * **Scope: this ratchet covers `packages/server/src` PRODUCTION source
 * only.** Test files are swept too, and pinned to an EXACT count (not a
 * ceiling — see below for why), but not allowlisted site-by-site the way
 * production is. This is a deliberate, asserted choice, not the #649
 * anti-pattern of a silent filename-based exclusion: that finding was a
 * guard that read `startsWith('claude-code-')` and never saw three older
 * captures sitting in the very directory it was guarding, passing
 * "truthfully and uselessly" because nothing about the check declared its
 * own blind spot. This law's test-file blind spot IS declared, and it is
 * bounded exactly, both directions — a new site, OR a fix that migrates one
 * site without lowering the pinned number, both fail. An earlier version of
 * this pin was one-directional (`toBeLessThanOrEqual`, i.e. a ceiling): a
 * fix that migrated one site and a new call site that added one elsewhere
 * cancelled out, leaving the count unchanged and the law green while the set
 * of debt sites had silently turned over. Pinning the exact count closes the
 * case that motivated it: a migration alone, with nothing added to offset
 * it, now lowers the count and fails until the pin is edited to match it.
 *
 * Proven by mutation, and worth being honest about what an exact count does
 * NOT close: it is still a COUNT, not a per-site allowlist. Migrating
 * `lab/namespace-law.test.ts`'s `resolvesIntoServerLab` idiom AND adding one
 * new site elsewhere in the same change leaves the total at 14 either way —
 * confirmed here as a mutation, the two edits cancel out under `toBe(14)`
 * exactly as they did under the old ceiling. Only a full per-site allowlist,
 * at production's granularity, closes that, and this law does not carry one
 * for test files: this issue's fence is a single file, and 14 sites across 7
 * files is not a one-file-sized allowlist to write and keep current.
 * Accepted as a residual — this shape needs two coordinated edits in
 * unrelated files inside one change, which a commit-by-commit review (this
 * repo's own stated review discipline) is positioned to catch even though
 * this law is not. Of the (currently 14) known test-file sites, three are reusable
 * helper functions (not one-off `expect(...)` assertions) that re-implement
 * "is this file inside that directory" for OTHER laws in this package, and
 * are the better migration candidates:
 *   - `isInConcierge`, `concierge/namespace-law.test.ts` (~line 445)
 *   - `resolvesIntoServerLab`, `lab/namespace-law.test.ts` (~line 126)
 *   - the boundary check in `findOutsideReferences`,
 *     `server/collector-wrap-boundary.test.ts` (~line 179)
 * Migrating those three is a follow-up, not this issue's fence (its only
 * file is this one).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/paths -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const CONTAINMENT_FILE = path.join(SERVER_SRC, 'paths', 'containment.ts')
const STATIC_FILE = path.join(SERVER_SRC, 'server', 'static.ts')
/** This law's own file — its rigged snippets below are string literals containing the very idioms being hunted, so the sweep must not check itself. */
const OWN_FILE = path.resolve(HERE, 'prefix-comparison-law.test.ts')

interface AllowlistEntry {
  /** Repo-relative path. */
  file: string
  /** The exact (trimmed) source line the detector matches on — the ratchet key. See the file doc comment for why this is text, not a line number. */
  snippet: string
  reason: string
}

/**
 * EXACTLY three. See the file doc comment above for why each one is here and
 * why the count itself, not just the membership, is asserted below.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    // collectors/sessionlog/process-probe.ts:184
    file: path.join('packages', 'server', 'src', 'collectors', 'sessionlog', 'process-probe.ts'),
    snippet: 'const relative = path.relative(canonicalRoot, candidate)',
    reason:
      'not a defect on its merits (round-2 verification): deliberately compares a kernel-canonical ' +
      '/proc/<pid>/cwd against a canonicalised root, documents that asymmetry, and fails closed on a ' +
      'canonicalize error. Do not "fix" this into symmetry with containment.ts.',
  },
  {
    // collectors/sessionlog/collector.ts:584
    file: path.join('packages', 'server', 'src', 'collectors', 'sessionlog', 'collector.ts'),
    snippet: 'const relative = path.relative(worktreePath, filePath)',
    reason:
      'same path.relative(...)/startsWith(\'..\') idiom as process-probe.ts, but with no considered-asymmetry ' +
      'reasoning behind it — a migration candidate for a follow-up issue, not this one.',
  },
  {
    // collectors/pi/collector.ts:547
    file: path.join('packages', 'server', 'src', 'collectors', 'pi', 'collector.ts'),
    snippet: 'const relative = path.relative(worktreePath, filePath)',
    reason: 'same idiom and same follow-up-migration status as collectors/sessionlog/collector.ts above.',
  },
]

/**
 * Known EXACT count of containment-shaped sites inside `.test.ts` files
 * under `packages/server/src`, as of the last time this law was hardened.
 * Pinned both directions, not a ceiling — see the file doc comment's
 * "Scope" section for why a one-directional bound let a migration and a new
 * site cancel out silently. Changing this number, either way, requires
 * looking at what changed and saying so in the commit that changes it.
 */
const TEST_FILE_KNOWN_DEBT_COUNT = 14

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) visit(full)
      else if (SOURCE_EXTENSIONS.has(path.extname(full))) out.push(full)
    }
  }
  visit(dir)
  return out
}

function isTest(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

/**
 * Code with comments blanked out — not deleted. Line numbers matter for
 * locating a finding (and this file's own doc comments quote idioms
 * verbatim), so a block comment is replaced character-for-character with
 * spaces rather than removed, which would shift every following line up.
 */
function codeOf(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlockComments.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

type Shape = 'startsWith-root' | 'startsWith-root-template' | 'indexOf-root-zero' | 'slice-root-length' | 'relative-startsWith-dotdot'

interface Violation {
  line: number
  shape: Shape
  snippet: string
}

/** `X.startsWith(root)` / `X.startsWith((root))` / `X.startsWith(root + path.sep)` — a non-literal (identifier) argument, optionally parenthesised. */
const STARTS_WITH_IDENT_RE = /\.startsWith\(\s*\(*\s*[A-Za-z_$]/
/** `X.startsWith(\`...\`)` — captured so its content can be judged by `isRootShapedTemplate`. */
const STARTS_WITH_TEMPLATE_RE = /\.startsWith\(\s*`([^`]*)`\s*\)/
/** Any of `===`, `!==`, `==`, `!=` — a containment check can be spelled as either "is prefixed" or "is not prefixed", strict or loose. */
const EQ_OP = '(?:===|!==|==|!=)'
/** `X.indexOf(root) <op> 0` for any equality operator. */
const INDEXOF_ROOT_RE = new RegExp(`\\.indexOf\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*${EQ_OP}\\s*0\\b`)
/** `X.slice(0, root.length) <op> root` / `X.substring(0, root.length) <op> root` — the backreference requires the identical identifier on both sides. */
const SLICE_ROOT_RE = new RegExp(`\\.(?:slice|substring)\\(\\s*0\\s*,\\s*([A-Za-z_$][\\w$]*)\\.length\\s*\\)\\s*${EQ_OP}\\s*\\1\\b`)
/** `path.relative(...)` or `path.posix.relative(...)`. */
const RELATIVE_RE = /\bpath\.(?:posix\.)?relative\(/
const RELATIVE_FOLLOW_RE =
  /\.startsWith\(\s*['"]\.\.['"]\)|\bpath\.isAbsolute\(|\.split\(\s*path\.sep\s*\)\s*\[\s*0\s*\]\s*!==\s*['"]\.\.['"]/
/**
 * How many lines past the `path.relative(...)` line the follow-up check may
 * appear on. The three real production sites use the very next line; sized
 * to 7 to also cover a follow-up written several statements later without
 * being unbounded (see "Known, deliberate gaps" in the file doc comment).
 */
const RELATIVE_WINDOW = 7

/** `path.*` tokens that indicate the surrounding code is doing filesystem-path arithmetic — the proxy for "this is a path, not an arbitrary string/array". */
const PATH_CONTEXT_RE = /\bpath\.(?:sep|resolve|relative|join|isAbsolute|posix|dirname|normalize)\b/
/**
 * How far back/forward from a candidate line `hasPathContextNearby` looks.
 * Sized to the real shapes in this tree: `server/static.ts`'s removed
 * `requested.startsWith(root)` had its `path.resolve(root, ...)` one line
 * above; `server/collector-wrap-boundary.test.ts`'s `findOutsideReferences`
 * has its `path.resolve(file)` three lines above `resolved.startsWith
 * (resolvedHome)`. 4 lines back covers both with one line of margin; 1 line
 * forward covers a root computed just after the check. Deliberately not
 * larger — see "Known, deliberate gaps" above for what a wider window would
 * trade away.
 */
const PATH_CONTEXT_LINES_BEFORE = 4
const PATH_CONTEXT_LINES_AFTER = 1

function hasPathContextNearby(lines: readonly string[], index: number): boolean {
  const start = Math.max(0, index - PATH_CONTEXT_LINES_BEFORE)
  const end = Math.min(lines.length, index + PATH_CONTEXT_LINES_AFTER + 1)
  for (let k = start; k < end; k++) {
    if (PATH_CONTEXT_RE.test(lines[k] ?? '')) return true
  }
  return false
}

/**
 * A template literal is the same containment idiom as `X.startsWith(root)`
 * only when it is built ENTIRELY out of interpolation and path separators —
 * stripping every `${...}` leaves nothing but `/` and `\` characters (or
 * nothing at all). Any other leftover literal text (`=`, `-`, a word) means
 * the template is comparing against a known, specific string — parsing, not
 * a root variable. See the file doc comment for the two real calls
 * (`cli/args.ts`, `concierge/repos.ts`) this distinction exists to leave
 * alone. This check alone is not sufficient — see `hasPathContextNearby`,
 * required alongside it, for why a bare `` `${bucket}` `` is still left
 * alone despite an empty literal remainder.
 */
function isRootShapedTemplate(templateContent: string): boolean {
  if (!/\$\{/.test(templateContent)) return false
  const literalRemainder = templateContent.replace(/\$\{[^}]*\}/g, '')
  return /^[/\\]*$/.test(literalRemainder)
}

/**
 * The containment idioms named in the file doc comment, found in
 * already-comment-stripped `code`. A file can trip more than one shape.
 */
function scanForViolations(code: string): Violation[] {
  const lines = code.split('\n')
  const violations: Violation[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (STARTS_WITH_IDENT_RE.test(line)) {
      if (hasPathContextNearby(lines, i)) violations.push({ line: i + 1, shape: 'startsWith-root', snippet: trimmed })
    } else {
      const templateMatch = line.match(STARTS_WITH_TEMPLATE_RE)
      if (templateMatch?.[1] !== undefined && isRootShapedTemplate(templateMatch[1]) && hasPathContextNearby(lines, i)) {
        violations.push({ line: i + 1, shape: 'startsWith-root-template', snippet: trimmed })
      }
    }

    if (INDEXOF_ROOT_RE.test(line) && hasPathContextNearby(lines, i)) {
      violations.push({ line: i + 1, shape: 'indexOf-root-zero', snippet: trimmed })
    }

    if (SLICE_ROOT_RE.test(line) && hasPathContextNearby(lines, i)) {
      violations.push({ line: i + 1, shape: 'slice-root-length', snippet: trimmed })
    }

    if (RELATIVE_RE.test(line)) {
      const window = lines.slice(i, i + RELATIVE_WINDOW).join('\n')
      if (RELATIVE_FOLLOW_RE.test(window)) {
        violations.push({ line: i + 1, shape: 'relative-startsWith-dotdot', snippet: trimmed })
      }
    }
  }
  return violations
}

interface FileViolations {
  file: string
  violations: Violation[]
}

function scanFiles(files: string[]): FileViolations[] {
  const out: FileViolations[] = []
  for (const file of files) {
    const resolved = path.resolve(file)
    if (resolved === path.resolve(CONTAINMENT_FILE)) continue
    if (resolved === OWN_FILE) continue
    const violations = scanForViolations(codeOf(readFileSync(file, 'utf8')))
    if (violations.length > 0) out.push({ file: path.relative(REPO_ROOT, file), violations })
  }
  return out
}

/** Every PRODUCTION-source violation in `packages/server/src` — the enforced allowlist covers exactly this set. */
function findAllViolations(): FileViolations[] {
  return scanFiles(walkSourceFiles(SERVER_SRC).filter((f) => !isTest(f)))
}

/** Every violation inside `.test.ts`/`.test.tsx` files — pinned to an exact count, not allowlisted per site. See the file doc comment's "Scope" section. */
function findTestFileViolations(): FileViolations[] {
  return scanFiles(walkSourceFiles(SERVER_SRC).filter(isTest))
}

describe('a path-containment comparison outside paths/containment.ts is a defect in PRODUCTION source (prd-42 ruling 2, #401) — test-file sites are pinned to an exact known-debt count, not enforced site-by-site here', () => {
  it('has a tree to walk, and containment.ts and static.ts are both in it — an empty sweep proves nothing', () => {
    const files = walkSourceFiles(SERVER_SRC)
    expect(files.length).toBeGreaterThan(50)
    expect(files.map((f) => path.resolve(f))).toContain(path.resolve(CONTAINMENT_FILE))
    expect(files.map((f) => path.resolve(f))).toContain(path.resolve(STATIC_FILE))
  })

  it('the allowlist is pinned to exactly three sites — a silent addition here is how a fourth defect gets waved through', () => {
    expect(ALLOWLIST.length).toBe(3)
    expect(ALLOWLIST.map((e) => e.file)).toEqual([
      path.join('packages', 'server', 'src', 'collectors', 'sessionlog', 'process-probe.ts'),
      path.join('packages', 'server', 'src', 'collectors', 'sessionlog', 'collector.ts'),
      path.join('packages', 'server', 'src', 'collectors', 'pi', 'collector.ts'),
    ])
  })

  it('the allowlist is non-empty — a detector that silently matches nothing must not pass', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0)
  })

  it('the process-probe entry records that it was adjudicated, not just noticed, so a later reader does not "fix" a considered asymmetry', () => {
    const entry = ALLOWLIST.find((e) => e.file.endsWith(path.join('sessionlog', 'process-probe.ts')))
    expect(entry?.reason).toMatch(/not a defect on its merits/)
    for (const allowlistEntry of ALLOWLIST) expect(allowlistEntry.reason.length).toBeGreaterThan(20)
  })

  it('each allowlisted site really exists on disk and still carries the idiom the entry names', () => {
    for (const entry of ALLOWLIST) {
      const abs = path.join(REPO_ROOT, entry.file)
      expect(statSync(abs).isFile(), `${entry.file} does not exist — the allowlist has drifted`).toBe(true)
      const violations = scanForViolations(codeOf(readFileSync(abs, 'utf8')))
      expect(
        violations.map((v) => v.snippet),
        `${entry.file} no longer trips the detector on "${entry.snippet}" — migrated? remove the allowlist entry`,
      ).toContain(entry.snippet)
    }
  })

  it('server/static.ts is fixed (wave 2) and shows no violation — the law must be green against it, not just silent about it', () => {
    const violations = scanForViolations(codeOf(readFileSync(STATIC_FILE, 'utf8')))
    expect(violations).toEqual([])
  })

  it('the detected violation set across production packages/server/src equals the allowlist exactly — the ratchet', () => {
    const detected = findAllViolations()
      .flatMap((fv) => fv.violations.map((v) => `${fv.file}:${v.snippet}`))
      .sort()
    const allowed = ALLOWLIST.map((e) => `${e.file}:${e.snippet}`).sort()
    expect(detected).toEqual(allowed)
  })

  it('test-file sites equal the pinned known-debt count exactly, both directions — migrating one site without lowering the pin, or adding one without raising it, both fail', () => {
    const testViolations = findTestFileViolations()
    const total = testViolations.reduce((sum, fv) => sum + fv.violations.length, 0)
    expect(
      total,
      `test-file containment sites: ${total}, pinned: ${TEST_FILE_KNOWN_DEBT_COUNT}. ` +
        `Sites: ${testViolations.map((fv) => `${fv.file} (${fv.violations.length})`).join(', ')}`,
    ).toBe(TEST_FILE_KNOWN_DEBT_COUNT)
  })

  describe('the detector bites — proven against a rigged snippet, never a real file', () => {
    it('fires on `X.startsWith(root)`, the exact idiom removed from static.ts', () => {
      const snippet = [
        'const requested = path.resolve(root, rest)',
        'if (!requested.startsWith(root)) {',
        "  return reply.code(403).send({ error: 'forbidden' })",
        '}',
      ].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations).toEqual([{ line: 2, shape: 'startsWith-root', snippet: 'if (!requested.startsWith(root)) {' }])
    })

    it('fires on `X.startsWith(root + path.sep)`, the separator-aware follow-up idiom', () => {
      const snippet = "if (requested !== root && !requested.startsWith(root + path.sep)) { throw new Error('escape') }"
      const violations = scanForViolations(codeOf(snippet))
      expect(violations.some((v) => v.shape === 'startsWith-root')).toBe(true)
    })

    it('fires on a PARENTHESISED argument, `X.startsWith((root))`', () => {
      const snippet = ['const requested = path.resolve(root, rest)', 'if (!requested.startsWith((root))) return false'].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations.some((v) => v.shape === 'startsWith-root')).toBe(true)
    })

    it('fires on the TEMPLATE-LITERAL spelling `X.startsWith(`${root}${path.sep}`)` — the miss the first version of this law had', () => {
      // Planted verbatim, once, as a real file at
      // packages/server/src/paths/__template_literal_plant__.ts while
      // hardening this law: the pre-fix detector (identifier-immediately-
      // after-open-paren only) reported the whole suite green, 13/13,
      // against it. Confirmed here as a mutation instead, per this repo's
      // own review discipline: prove the miss existed, then prove the fix
      // closes it, without leaving a throwaway file behind.
      const snippet = 'if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) return null'
      const violations = scanForViolations(codeOf(snippet))
      expect(violations).toEqual([{ line: 1, shape: 'startsWith-root-template', snippet }])
    })

    it('fires on `X.indexOf(root) === 0`, `!== 0` and loose `== 0`, with path context nearby', () => {
      const withContext = (line: string) => ['const requested = path.resolve(root, rest)', line].join('\n')
      expect(scanForViolations(codeOf(withContext('const contained = requested.indexOf(root) === 0')))).toEqual([
        { line: 2, shape: 'indexOf-root-zero', snippet: 'const contained = requested.indexOf(root) === 0' },
      ])
      expect(
        scanForViolations(codeOf(withContext('if (requested.indexOf(root) !== 0) return false'))).some(
          (v) => v.shape === 'indexOf-root-zero',
        ),
      ).toBe(true)
      expect(
        scanForViolations(codeOf(withContext('if (requested.indexOf(root) == 0) return true'))).some(
          (v) => v.shape === 'indexOf-root-zero',
        ),
      ).toBe(true)
    })

    it('fires on `X.slice(0, root.length) !== root` and the `.substring` / `===` spellings, with path context nearby', () => {
      const withContext = (line: string) => ['const requested = path.resolve(root, rest)', line].join('\n')
      expect(
        scanForViolations(codeOf(withContext("if (requested.slice(0, root.length) !== root) throw new Error('escape')"))).some(
          (v) => v.shape === 'slice-root-length',
        ),
      ).toBe(true)
      expect(
        scanForViolations(codeOf(withContext('const inside = requested.slice(0, root.length) === root'))).some(
          (v) => v.shape === 'slice-root-length',
        ),
      ).toBe(true)
      expect(
        scanForViolations(codeOf(withContext('if (requested.substring(0, root.length) === root) return true'))).some(
          (v) => v.shape === 'slice-root-length',
        ),
      ).toBe(true)
    })

    it("fires on path.relative(root, X) followed by startsWith('..')/isAbsolute — the collector idiom", () => {
      const snippet = [
        'const relative = path.relative(worktreePath, filePath)',
        "if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return filePath",
      ].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations).toEqual([
        { line: 1, shape: 'relative-startsWith-dotdot', snippet: 'const relative = path.relative(worktreePath, filePath)' },
      ])
    })

    it('fires on `path.posix.relative(root, X)`, not just the plain `path.relative` spelling', () => {
      const snippet = [
        'const relative = path.posix.relative(worktreePath, filePath)',
        "if (relative.startsWith('..')) return filePath",
      ].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations.some((v) => v.shape === 'relative-startsWith-dotdot')).toBe(true)
    })

    it('fires on the `.split(path.sep)[0] !== \'..\'` follow-up, the sibling of `startsWith(\'..\')`', () => {
      const snippet = [
        'const relative = path.relative(worktreePath, filePath)',
        "return relative.split(path.sep)[0] !== '..'",
      ].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations.some((v) => v.shape === 'relative-startsWith-dotdot')).toBe(true)
    })

    it('the relative follow-up can be several lines away, up to RELATIVE_WINDOW, not just the very next line', () => {
      const snippet = [
        'const relative = path.relative(worktreePath, filePath)',
        '// an unrelated log line',
        '// another unrelated line',
        '// a third unrelated line',
        "if (relative.startsWith('..')) return filePath",
      ].join('\n')
      const violations = scanForViolations(codeOf(snippet))
      expect(violations.some((v) => v.shape === 'relative-startsWith-dotdot')).toBe(true)
    })
  })

  describe('the detector does NOT fire on the parsing calls it must leave alone — proving it is not just `startsWith`', () => {
    it('a literal-string argument is left alone (git porcelain, CLI flags, slug checks, dotfile skips)', () => {
      const parsingSnippets = [
        "if (line.startsWith('worktree ')) {}",
        "if (!sawDoubleDash && arg.startsWith('-')) { }",
        "if (name.startsWith('.') || skipDirNames.has(name)) continue",
        "if (rawLine.startsWith('+++ ')) { }",
      ]
      for (const snippet of parsingSnippets) {
        expect(scanForViolations(codeOf(snippet)), snippet).toEqual([])
      }
    })

    it('an identifier-argument startsWith with NO path context nearby is left alone — the false conviction round-2 verification found', () => {
      // Each of these is syntactically identical to the real idiom
      // (`.startsWith(<identifier>)`) and would have been convicted by the
      // version of this law that checked argument shape alone. None of them
      // has any `path.*` call nearby, which is exactly the distinction that
      // makes them parsing rather than containment.
      const noPathContext = [
        "if (line.startsWith(marker)) { }",
        "const isReleaseTag = ref.startsWith(`${remote}/`)",
        "const inScope = pathname.startsWith(`${basePath}/`)",
        "const sameBucket = key.startsWith(`${bucket}`)",
      ]
      for (const snippet of noPathContext) {
        expect(scanForViolations(codeOf(snippet)), snippet).toEqual([])
      }
    })

    it('an array `.indexOf(x) === 0` with no path context nearby is left alone — indistinguishable from a string`s by text alone, so context is the only guard', () => {
      const snippet = 'const isFlagFirst = argv.indexOf(flag) === 0'
      expect(scanForViolations(codeOf(snippet))).toEqual([])
    })

    it('a template literal with real leftover text (not just a separator) is left alone even WITH path context — the two real calls this distinction exists for', () => {
      const parsingSnippets = [
        // cli/args.ts:85 — a specific CLI flag name plus `=`, not a path root.
        'const spec = specs.find((s) => arg === s.flag || arg.startsWith(`${s.flag}=`))',
        // concierge/repos.ts:234 — a slug shape check, not a path root.
        'const isMidSegment = remaining.startsWith(`${encoded}-`)',
      ]
      for (const snippet of parsingSnippets) {
        expect(scanForViolations(codeOf(snippet)), snippet).toEqual([])
      }
    })

    it('a bare unrelated path.isAbsolute call, with no path.relative beside it, does not fire the relative shape', () => {
      const snippet = 'if (entry.length > 0 && path.isAbsolute(entry) && !insideWatchedRepo(entry, root)) { }'
      expect(scanForViolations(codeOf(snippet))).toEqual([])
    })

    it('indexOf/slice checks against a literal, or with mismatched identifiers, do not fire even with path context nearby', () => {
      const withContext = (line: string) => ['const requested = path.resolve(root, rest)', line].join('\n')
      const benignSnippets = [
        // literal argument — parsing a known marker, not a root variable
        withContext("const isFlag = arg.indexOf('-') === 0"),
        // mismatched identifiers either side of the comparison — not a self-comparison
        withContext('if (requested.slice(0, root.length) !== other) return null'),
        // a numeric length, not `<identifier>.length`
        withContext('const head = value.slice(0, 8)'),
      ]
      for (const snippet of benignSnippets) {
        expect(scanForViolations(codeOf(snippet)), snippet).toEqual([])
      }
    })

    it('the idiom mentioned only inside a comment does not fire — the exact static.ts shape (a comment quoting the removed code)', () => {
      const snippet = [
        '// A bare `startsWith(root)` passes a sibling directory that merely shares',
        "// `root` as a literal string prefix, so this route uses isPathContained instead:",
        'if (!isPathContained(root, requested)) {',
        "  return reply.code(403).send({ error: 'forbidden' })",
        '}',
      ].join('\n')
      expect(scanForViolations(codeOf(snippet))).toEqual([])
    })

    it('a containment check with NO path.* context anywhere is missed uniformly — not an operator asymmetry, the documented cost of the context proxy', () => {
      // Round 3 found `requested.slice(0, root.length) === root` uncaught
      // and read that as a `===`-vs-`!==` asymmetry. It is not: with zero
      // `path.*` evidence anywhere nearby, `!==` is missed exactly as
      // completely as `===`, and so is `startsWith-root` itself — the
      // shape this whole law exists to catch. What actually explains the
      // earlier "catch" is that the passing `!==` test above supplies
      // `path.resolve(root, rest)` as context on the line before; strip
      // that and it is indistinguishable from these three.
      const noPathContextAnywhere = [
        'requested.startsWith(root)',
        'requested.slice(0, root.length) === root',
        'requested.slice(0, root.length) !== root',
        'requested.indexOf(root) === 0',
      ]
      for (const snippet of noPathContextAnywhere) {
        expect(scanForViolations(codeOf(snippet)), snippet).toEqual([])
      }
    })
  })
})
