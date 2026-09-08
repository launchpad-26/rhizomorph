import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { beaconReceivedPayloadSchema, gateVerdictPayloadSchema } from '@rhizomorph/core'
import { parseBeaconLine } from './collectors/beacon/parse-beacon-line.js'
import { beaconDirFor } from './collectors/beacon/paths.js'

/**
 * #42's law — a guard in the landing tool may not print a verdict it did not
 * earn (prd-45 rulings 1-3).
 *
 * `scripts/gate.sh` IS the landing tool: it merges a lane to local `main` and
 * pushes to `origin/main`. prd-39 found two places where the check's "I could
 * not run" path and its "I ran and found nothing" path produced the same
 * output; this PRD found the same shape in seven more places, plus one
 * postcondition (branch-ref absence) that proved a proxy instead of the fact
 * it claimed. Nothing asserted any of this — `grep -rlnF "gate.sh" packages`
 * found only prose comments and captured fixture data, no assertion — so
 * every fix, before this file, was held by review alone.
 *
 * This law does not re-implement gate.sh's guards: a duplicate would test
 * itself, not the script, and would stay green after a regression reverted
 * the real file. Every executable assertion below extracts the ACTUAL lines
 * from the tracked `scripts/gate.sh` (by locating unique anchor substrings,
 * never by line number) and runs them, unmodified, against real git fixtures
 * in a scratch directory — the same technique the issue's "Proving it"
 * section demands of a human, made structural. `workmux` is genuinely
 * installed on the machine running this suite; the containment-guard
 * extraction is deliberately two single lines, skipping the `clean`/
 * `workmux merge` lines between them, so this law never invokes it.
 *
 * Lives under `packages/server/` for the reason `runbook-delivery-law` and
 * `no-personal-paths-law` already state: the root vitest config globs
 * `packages/*`, so a root-level test would never run and would be its own
 * vacuous law.
 *
 * COST OF THIS DESIGN: because every fixture is anchored to EXACT line text
 * (`uniqueLineIndex`/`sliceLines`/`extractLine`), rewording a guard's fail()
 * message, or any other cosmetic edit to a line this file anchors on,
 * reddens this law at collection — before a single assertion runs — from a
 * directory the editor of `scripts/gate.sh` never entered. That is the same
 * species of two-directional coupling `.swarm/coupling.txt` records for
 * `packages/web/src/theme/tokens.test.ts`. It is deliberate (a duplicated
 * re-implementation would test itself and stay green after a real
 * regression, which is worse), but it is a real cost: touching `gate.sh`
 * means expecting this file to need a matching edit, not just a run.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const GATE_PATH = 'scripts/gate.sh'

/**
 * Reads the working-tree file directly, matching `no-personal-paths-law` and
 * `runbook-delivery-law`'s own convention (their `git ls-files`/`check-ignore`
 * calls are for file EXISTENCE and ignore-state, never for content — content
 * always comes from `readFileSync` against disk, which is what makes an
 * uncommitted edit visible to `npm test` before it is staged).
 */
const SOURCE = readFileSync(join(REPO_ROOT, GATE_PATH), 'utf8')
const LINES = SOURCE.split('\n')

/**
 * A handful of proofs below make a real file unwritable and assert the write
 * fails. `chmod 0444` cannot do that for root — `CAP_DAC_OVERRIDE` ignores
 * the permission bit — so a test that only chmods would go red under root
 * for a reason it never claimed (#74). Where the write target can be freely
 * relocated, the fix is structural (an ENOTDIR obstruction, which no
 * privilege bypasses) and needs no root check at all. Where the target must
 * already exist as a well-formed, readable file — as `lanes.json` must, for
 * `[ -f ... ]` and `JSON.parse` to see it — no setup step available to an
 * unprivileged test process holds against root either (a directory's write
 * bit is the same CAP_DAC_OVERRIDE-bypassable check; `chattr +i` needs
 * `CAP_LINUX_IMMUTABLE` against the filesystem's owning namespace, which a
 * user namespace's mapped root does not have). That case skips itself under
 * root instead, with the reason on the test.
 *
 * #179's sweep re-checked this class file-wide rather than trusting the two
 * `it.skipIf(RUNNING_AS_ROOT)` sites already here (the lane-manifest
 * "unwritable lanes.json" test and its "read-only, no entry for this handle"
 * sibling): every `chmod 0o444` in this file is one of those two, and
 * EXECUTED under `unshare -r` (mapped uid 0), the whole suite reads 134
 * passed / 3 skipped (the two above plus the pre-existing bash-3.2-only
 * empty-array test) / 0 failed — no third chmod-based proof degrades to
 * vacuity under root. The one OLD-form control that chmods without a root
 * skip (the "malformed OR unwritable lanes.json" comparison a few screens
 * down) does not need one: its assertion never inspects the file's final
 * content, only that the OLD script's `catch {}` prints "pruned" either way,
 * which is true whether or not the chmod actually holds — recorded on that
 * test, and reconfirmed by the same `unshare -r` run.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0

/**
 * `/bin/bash`'s major version — NOT the `bash` on PATH.
 *
 * `gate.sh`'s shebang is `#!/bin/bash`, so that interpreter is the one its
 * guards actually run under, and it is the only one whose quirks can hold a
 * landing. The two differ in practice: macOS ships 3.2.57 at `/bin/bash` while
 * Homebrew puts 5.x first on PATH, which is exactly how a proof written for
 * 3.2 comes to run under 5.x and pass without exercising anything.
 */
const SYSTEM_BASH_MAJOR = Number(
  (spawnSync('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }).stdout ?? '')
    .trim(),
)
/** Empty-array expansion under `set -u` stopped being an error in bash 4.4. */
const SYSTEM_BASH_GUARDS_EMPTY_ARRAYS = !Number.isNaN(SYSTEM_BASH_MAJOR) && SYSTEM_BASH_MAJOR >= 4

/** The one line containing `needle`. Throws if zero or more than one match — an ambiguous anchor is worse than a missing one. */
function uniqueLineIndex(needle: string): number {
  const matches: number[] = []
  LINES.forEach((line, i) => {
    if (line.includes(needle)) matches.push(i)
  })
  if (matches.length !== 1) {
    throw new Error(`expected exactly one line of ${GATE_PATH} containing ${JSON.stringify(needle)}, found ${matches.length}`)
  }
  return matches[0]!
}

/**
 * {@link uniqueLineIndex}, but blind to comments — for an anchor whose claim is
 * about EXECUTABLE code (review of #273, round 2).
 *
 * `uniqueLineIndex` is a bare `includes`, deliberately: several anchors in this
 * file point AT comments, and filtering globally would break them. But an
 * assertion that `MERGED=1` sits between two checks is a claim about what RUNS,
 * and the bare form satisfied it against `# MERGED=1 deleted` — commenting a
 * line out is the ordinary way to disable it, and the boundary assertion passed
 * 200/201 with the post-merge truth inverted. Found by a review seat.
 */
function uniqueCodeLineIndex(needle: string): number {
  const matches: number[] = []
  LINES.forEach((line, i) => {
    if (!line.trim().startsWith('#') && line.includes(needle)) matches.push(i)
  })
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one NON-COMMENT line of ${GATE_PATH} containing ${JSON.stringify(needle)}, found ${matches.length}`,
    )
  }
  return matches[0]!
}

/**
 * Is this line a `fail` INVOCATION? Deliberately loose — anything that looks
 * like one — because the category is classified afterwards. The previous shape
 * filtered on a regex that already required a category, so a site lacking one
 * never entered the list and the "no site is untagged" assertion could not fail.
 */
function isFailCallSite(line: string): boolean {
  return (
    !line.trim().startsWith('#') &&
    /\bfail\s+["']/.test(line) &&
    !line.includes('fail()  {') &&
    !line.includes('emit_gate_verdict "${2:-uncategorized}"')
  )
}

/**
 * The category a `fail` site names: its literal slug, or `untagged` when it
 * names none, or `dynamic` when it is computed and no static check can resolve
 * it. One implementation, used by the law and by the decoy that guards the law.
 */
function classifyFailSite(line: string): string {
  // The message, either quoting style, then whatever follows it up to the end
  // of the statement — `;`, `}`, a trailing comment, or EOL.
  const after = line.match(/\bfail\s+(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(.*)$/)?.[1] ?? ''
  const token = after.replace(/[;}].*$/, '').replace(/#.*$/, '').trim()
  if (token === '') return 'untagged'
  if (/[$"'`]/.test(token)) return 'dynamic'
  return token
}

function extractLine(needle: string): string {
  return LINES[uniqueLineIndex(needle)]!
}

/** Lines from the one containing `startNeedle` through the one containing `endNeedle`, plus `extra` further lines (for a block whose real end is a bare `fi`/`}` too generic to anchor on directly). */
function sliceLines(startNeedle: string, endNeedle: string, extra = 0): string {
  const start = uniqueLineIndex(startNeedle)
  const end = uniqueLineIndex(endNeedle)
  if (end < start) throw new Error(`end anchor ${JSON.stringify(endNeedle)} appears before start anchor ${JSON.stringify(startNeedle)} in ${GATE_PATH}`)
  return LINES.slice(start, end + 1 + extra).join('\n')
}

/** `fail()` and the `MERGED` flag, extracted whole — every fixture reuses the REAL implementation rather than a re-typed stand-in, per the issue's "REUSED, never reimplemented". */
const FAIL_BLOCK = sliceLines('fail()  { echo "GATE FAILED: $1"', 'exit 1; }')

/**
 * The shell options every fixture runs under, EXTRACTED from the real
 * script rather than re-typed. Not tidiness: `pipefail` is what makes the
 * :96 commit-count guard mean anything — `git log` fails at rc 128 while
 * `wc -l` succeeds, so without it the assignment's status is wc's 0 and
 * the guard is dead. A re-typed `set -uo pipefail` here keeps every
 * fixture green after gate.sh loses the option, which is the
 * duplicate-tests-itself defect this file's own header (:20-26) forbids.
 *
 * EXECUTED, with the literal re-typed: changing gate.sh:13 to `set -u`
 * left the suite 94/94 GREEN and restored #70's original wrong verdict
 * ("no commits on the branch") over a corrupted repo. Derived, the same
 * mutation fails loudly, naming the missing line.
 *
 * Note what this couples: rewording gate.sh:13 in a way that changes shell
 * semantics now changes what every fixture runs under. That is the
 * intended direction — the fixtures track the real script — but it is a
 * real coupling and belongs in .swarm/coupling.txt (prd46 w5, #72).
 */
const SHELL_OPTS = (() => {
  // CODE lines only. `uniqueLineIndex` does not skip comments, and unlike
  // this file's other anchors (`fail()  { echo "GATE FAILED: $1"`, the
  // `n=$(git ...` producer) this needle is a phrase prose naturally
  // contains — gate.sh:89 already writes "pipefail (set at :13)", one word
  // from a second match. EXECUTED: adding a comment mentioning the literal
  // to gate.sh took the whole file out at COLLECTION ("found 2", 0 tests
  // run), which is the coupling shape prd-45 was written about.
  // `set +...` as well as `set -...`, and this is the whole point rather
  // than tidiness. A prelude replays ONE line, so it models the option
  // state at :13 and nowhere else. A `set +o pipefail` added later in the
  // file is a different line, leaves this selector's answer unchanged, and
  // every fixture would keep running WITH pipefail while the real gate ran
  // without it. EXECUTED: with `set +o pipefail` inserted on its own line
  // immediately above the :96 producer, this law reported 104 passed while
  // the real block produced "no commits on the branch" over a corrupted
  // repo — the exact verdict #70 exists to abolish, with the law green.
  // Matching both signs turns that into a loud failure that names the lines.
  const matches = LINES.filter((l) => !l.trim().startsWith('#') && /^\s*set\s+[-+]/.test(l))
  if (matches.length !== 1) throw new Error(`expected exactly one \`set\` option line in ${GATE_PATH}, found ${matches.length}: ${JSON.stringify(matches)} — a prelude can replay only one, so a second one means the fixtures no longer model the shell the real guards run under`)
  const opts = matches[0]!
  // The :96 guard is dead without pipefail, so an option line that has lost
  // it must fail here and say why, not quietly run every fixture unguarded.
  if (!opts.includes('pipefail')) throw new Error(`${GATE_PATH}'s option line is ${JSON.stringify(opts)} — it no longer sets pipefail, and the :96 commit-count guard is meaningless without it (git log fails while wc -l succeeds)`)
  return opts
})()

function preludeScript(mergedValue: 0 | 1, extraAssignments: string): string {
  return `#!/bin/bash\n${SHELL_OPTS}\nH=t42\nMERGED=${mergedValue}\n${FAIL_BLOCK}\n${extraAssignments}\n`
}

interface FragmentResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs an assembled bash script and returns its outcome without throwing — a fail()'s exit 1 is an expected result here, not a test-harness error. Syntax-checks first, so a broken extraction fails with a clear parse error instead of a confusing runtime one. */
function runFragment(script: string, cwd: string, shell = 'bash'): FragmentResult {
  execFileSync(shell, ['-n'], { input: script, encoding: 'utf8' })
  try {
    const stdout = execFileSync(shell, ['-c', script], { cwd, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
}

const SCRATCH_DIRS: string[] = []
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `gate-law-${prefix}-`))
  SCRATCH_DIRS.push(d)
  return d
}
afterEach(() => {
  while (SCRATCH_DIRS.length) {
    const d = SCRATCH_DIRS.pop()!
    chmodSync(d, 0o755) // undo any read-only fixture directories/files before rm
    try {
      execFileSync('chmod', ['-R', 'u+rwX', d])
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true })
  }
})

describe('gate honesty law: no guard in scripts/gate.sh prints a fault or a verdict without honouring it', () => {
  it('the source is substantive — the checks below would pass vacuously against an empty or truncated file', () => {
    expect(LINES.length).toBeGreaterThan(200)
    expect(SOURCE).toContain('gate.sh <handle> <fence-regex>')
  })

  it('fail() and the MERGED flag are the ONE shared reporting path — every fixture below reuses this exact text', () => {
    expect(FAIL_BLOCK).toContain('GATE FAILED: $1')
    expect(FAIL_BLOCK).toContain('HOLDING $H — not merged')
    expect(FAIL_BLOCK).toContain('MERGED to local main, NOT pushed')
    expect(extractLine('MERGED=0')).toBe('MERGED=0')
  })

  /**
   * Ruling 1 (prd-46 #70) — the sweep is REPLACED by a STRUCTURAL predicate
   * over the script's shape, not a hand-maintained list of spellings. The
   * reference form: an assignment whose value comes from running a command —
   * `$(...)`, `` `...` ``, or a quoted string wrapping either — whose exit
   * status is never read before a verdict prints — either on the SAME line
   * (`) || fail ...`, `) || exit N` with N != 0, or a `|| { ... }` rescue
   * block that itself calls `fail`/a nonzero `exit`), or on the NEXT line (a
   * bare `SOMETHING=$?` capture). `findUncheckedProducers` classifies a line
   * by this SHAPE, not by scanning for known-bad substrings, so a NEW guard
   * written with a spelling nobody has thought of yet still reddens this law
   * — Success 1 of prd-46.
   *
   * Six evasions measured during #68's verification passed the OLD
   * three-idiom sweep silently: `|| :`, `2> /dev/null`, `&>/dev/null`,
   * `||true`, a bare `RES=$(cmd | tail -1)`, and
   * `cmd || { echo "(could not check)"; }`. A SEVENTH was live in the file
   * the old sweep governed: gate.sh's own `n=$(git log ... | wc -l)` (fixed
   * a few lines above, in the `:82 commit-count producer` describe block
   * below). All seven, plus five more spellings beyond them, are proven
   * caught by the RIGGED_LINES fixtures in the 'ruling 2' describe block
   * further down — using the real predicate function, not a restatement of
   * it (the OLD non-vacuity control's own defect, per the issue this
   * closes).
   *
   * #179 — "the class, not the enumeration" a second time: the predicate
   * above convicted exactly one SPELLING of that reference form
   * (`VAR=$(...)`, bare, single line). It was blind to a quoted wrap, an
   * `export`/`local`/`declare`/`typeset`/`readonly` prefix, the legacy
   * backtick form, and the multi-line `$(` ... `)` shape. Per the issue's
   * method, the FULL production table comes before the widened predicate, so
   * a reader can see which spellings were considered — a spelling nobody
   * listed is a spelling nobody reviewed:
   *
   * | # | spelling | example | convicted when unchecked? | verdict |
   * |---|---|---|---|---|
   * | 1 | bare `$(...)` | `VAR=$(cmd)` | yes | pre-existing (#70), unchanged |
   * | 2 | quoted `$(...)` | `VAR="$(cmd)"` | yes | WIDENED (#179) |
   * | 3 | quoted, substitution mixed with literal text | `VAR="prefix-$(cmd)-suffix"` | yes | WIDENED (#179) — same scanner as row 2; this is gate.sh:24's own shape (`W="$(dirname "$root")/$(basename "$root")__worktrees/$H"`), see row 11 |
   * | 4 | keyword-prefixed | `export VAR=$(cmd)`, `local VAR=$(cmd)`, `declare VAR=$(cmd)`, `typeset VAR=$(cmd)`, `readonly VAR=$(cmd)` | **ALWAYS — unconditionally, regardless of a `|| fail` tail or a next-line `_RC=$?`** | WIDENED (#179), REVISED after verification review: recognised, but never treated as checkable. Bash gives `$?` from the KEYWORD BUILTIN, not the substitution — `export V=$(false)` exits 0 even though `false` failed (EXECUTED, see the dedicated test below). A same-line `|| fail` or next-line `_RC=$?` on a keyword-prefixed producer therefore checks the WRONG thing and can never fire; treating it as "checked" (round 1 of this fix did) made the law WORSE than before — invisible became seen-and-excused. `hasKeywordPrefix` on each producer forces this row's population straight into `findUncheckedProducers` regardless of tail shape. |
   * | 5 | backtick | `` VAR=`cmd` `` | yes | WIDENED (#179) |
   * | 6 | quoted backtick | `` VAR="`cmd`" `` | yes | WIDENED (#179) — same scanner as row 2 |
   * | 7 | multi-line `$(...)` | `VAR=$(`⏎`  cmd`⏎`)` | yes | WIDENED (#179) — the paren-depth scan now crosses line boundaries, so a producer that closes several lines down is still found, and the lines in between are not re-scanned as fresh assignment starts |
   * | 8 | single-quoted | `VAR='$(cmd)'` | no — not a producer | EXCLUDED — bash expands NOTHING inside single quotes; the value IS the four-character-plus text `$(cmd)`, no command ever runs, so there is no exit status to check |
   * | 9 | quoted, no substitution inside | `VAR="just text"` | no — not a producer | EXCLUDED — no command runs; `export PATH="$HOME/.local/bin:$PATH"` (gate.sh:14) is a live instance, correctly never flagged |
   * | 10 | escaped `\$(` or `` \` `` inside a quoted string | `VAR="literal \$(not a command)"` | no — not a producer | EXCLUDED — the backslash suppresses expansion, same reasoning as row 8 |
   * | 11 | assignment mid-statement, not the first token on the line | `[ -d "$X" ] || W="$(...)"` (gate.sh:24, verbatim) | not parsed | DECLARED OUT OF SCOPE — the predicate anchors on a (keyword-prefixed) `VAR=` starting the line, matching ruling 1's own reference form; gate.sh's one live instance is :24, and its correctness is instead proven by the very next `[ -d "$W" ]` existence check a few lines down, the same shape already declared for :23's DECLARED_TOLERANCES entry below |
   * | 12 | multiple assignments on one line, target not the first token | `A=1 VAR=$(cmd)` | not parsed | DECLARED OUT OF SCOPE — no live instance in gate.sh; scanning every token on a line for a trailing `VAR=$(...)` would also convict an ordinary `FOO=bar some_cmd` env-prefix invocation, a false positive nobody asked for |
   * | 13 | array assignment | `ARR=($(cmd))` | not parsed | N/A — an array literal (`VAR=(...)`) is a different shape from the scalar `VAR=$(...)` ruling 1 names; `=(` never matches the scanner's `=$(` / `` =` `` / `="` starts |
   * | 14 | unassigned pipeline / substitution used only as an argument | `some_cmd "$(risky)"`, `cmd \| grep x` | not parsed | pre-existing scope note, unaffected by #179 — see "predicate is honest about its own remaining scope limit" below |
   * | 15 | a literal paren inside a quoted string inside a NESTED `$(...)`, inside the assignment being scanned | `VAR=$(cmd "$(echo ')')")` | correctly parsed | HANDLED — the scanner tracks quote state and recurses into nested `$(...)`, so a paren that is only DATA inside a quoted string never perturbs the depth count (EXECUTED below) |
   * | 16 | append assignment | `V+=$(cmd)` | yes | WIDENED (verification review) — `+=` is still plain assignment syntax, not a builtin call, so unlike row 4 its exit status DOES reflect the substitution's (EXECUTED, same dedicated test as row 4) |
   * | 17 | a flag between a keyword and the variable | `declare -r V=$(cmd)` | ALWAYS (row 4's rule) | WIDENED (verification review) — the keyword-prefix consumer is a small loop over (keyword\|flag)\* tokens, not a fixed one-keyword regex, so a flag in between does not hide the keyword from `hasKeywordPrefix` |
   * | 18 | stacked keywords | `export readonly V=$(cmd)` | ALWAYS (row 4's rule) | WIDENED (verification review) — same loop as row 17; `export` treats a second bare word as another export target, which is syntactically legal and still masks the substitution's status via `export`'s own exit code |
   * | 19 | arithmetic expansion | `V=$((1+2))`, `V=$(( a > b ))` | no — not a producer | EXCLUDED (verification review) — `$((` is arithmetic, not command substitution: no external command runs, so there is no process exit status to check at all. The dispatch on `$` + `(` alone (rows 1-3's original shape) could not tell `$(` from `$((`; the third character is now checked before committing to the `$(...)` scanner. gate.sh uses `$((...))` three times today, none line-initial, which is the only reason this stayed silent |
   * | 20 | a `#` comment inside a multi-line `$(...)` or backtick body | `VAR=$(`⏎`  cmd  # note`⏎`)` | correctly parsed | HANDLED (verification review) — an UNBALANCED apostrophe in the comment (`# don't`) used to open a phantom single-quoted string that swallowed the real closing `)`, vanishing the whole producer; a `)` in the comment used to close the substitution early, turning a checked producer's real tail into unrelated later text and convicting it falsely. The scanner now recognises a `#` at a word boundary (start-of-scan or after whitespace, the same convention `stripQuotedRunsAndComments` already uses) and skips to end of line before resuming depth/quote tracking |
   * | 21 | `VAR=$(...)`-shaped TEXT inside a heredoc body | `cat <<'EOF'`⏎`X=$(cmd)`⏎`EOF` | no — not a producer | HANDLED (verification review) — heredoc body lines (quoted or unquoted delimiter, `<<`/`<<-`) are DATA being piped to a command, not executable assignments; a quoted delimiter's body cannot even expand `$(...)` if it somehow were code. Body lines between the opener and the matching terminator are excluded from producer-scanning entirely. `findHeredocStart` tracks quote state and comments itself (rather than reusing `stripQuotedRunsAndComments`, which DISCARDS quoted text and so cannot see a QUOTED delimiter) so a `<<EOF`-looking substring inside a message or comment (`echo "example: cmd <<EOF"`) is not mistaken for a real opener — that direction of mistake is the dangerous one, since it would hide every real producer between the false opener and wherever a same-named terminator line next happens to occur. Declared, not fully closed: two heredocs opened on the same line is not disambiguated further than "first one found, scanned greedily" — no such line exists in gate.sh today |
   * | 22 | a `<<` that is NOT a heredoc opener — the `<<<` here-string, and the `<<` LEFT-SHIFT operator inside an arithmetic `((...))` | `grep -q x <<< foo`, `if (( a << b ))` | no — neither opens a heredoc | HANDLED (review of #191) — row 21's opener scan matched any `<<` whose next word looked like a delimiter, so both of these were read as heredoc openers whose terminator never arrives, marking EVERY remaining line of the script as body. That is row 21's own stated dangerous direction, reached by two spellings its CONTROL (a `<<EOF` inside a quoted message) did not cover. EXECUTED against the real scripts/gate.sh: inserting one `grep -q x <<< foo` line — or one `if (( a << b ))` line — above the first producer took the producer count from **17 to 0**. The pinned-count test does redden on that, so the law never went silently blind; it reddened with a count that points nowhere near the offending line, and a re-derive of the pin to the new smaller number would have blinded it for real. `findHeredocStart` now skips all three characters of `<<<` (retrying at `i + 1` would re-find the trailing `<<`) and skips an arithmetic `((...))` span by paren depth |
   *
   * MEASURED FALSE-POSITIVE RATE (EXECUTED, run against every real producer
   * of ANY spelling above in scripts/gate.sh — prd-46's own open question,
   * re-run after #179's widening rather than retyped, again after prd17 w5
   * (#273) added the verdict's own output-capture producer, and again after
   * prd17 w5 (#274) added the beacon write): 20 such assignments exist — UP
   * from 18 by exactly the two new producers #274 adds. Both are also the
   * FIRST live instance of row 7 (the multi-line `$(...)` form) in this
   * file: `verdict_line=$(python3 -c '...'  ...)` and
   * `beacon_dir=$(REPO_PATH=... "$root/node_modules/.bin/tsx" -e '...' ...)`
   * each open their `$(` on one line and close it several lines down, past
   * a quoted script argument that itself spans multiple lines — so the
   * claim this paragraph made through #273, that every producer here was
   * "still the bare, single-line form of row 1", is no longer true and is
   * corrected rather than repeated.
   *
   * producer-citations:begin — the 20 line numbers between these markers are
   * checked against the real file by a law below. Do not hand-edit one
   * without re-running it; do not move a marker to make a red build green.
   *
   * Exactly 1 is flagged as structurally
   * unchecked — :23 (`W=$(workmux path ...)`), declared before this issue
   * and still declared, because the very next line's existence check is the
   * verdict rather than the redirect. 0 of the 20 are undeclared: the
   * predicate does not convict a single honest line on this file.
   *
   * The other 19 pass structurally on their own merits: 12 same-line forms
   * (:17's `|| exit 2`, written before `fail` is even defined; 9 `|| fail` at
   * :338 (`GATE_OUTFILE`) :414 :429 :489 :583 :593 :657 :743 :798; 2
   * `|| { ...; fail ...; }` rescue blocks at :430 :799) and 7 next-line
   * `_RC=$?` captures (:156's `VERDICT_LINE_RC` and :244's `BEACON_DIR_RC` —
   * both new with #274 — plus :446's `ANCESTOR_RC`, :526's `N_RC`, :530's
   * `STATUS_RC`, :557's `DIRTY_RC`, :658's `CAT_RC`). Re-derived here twice:
   * prd17 w7 (#293) inserted the `$3` (LOAD) validation above these
   * producers (+48 lines), and a review of #293 added the load-batches
   * upper-bound guard right beside it (+21 more) — each closed in the SAME
   * edit as the insertion rather than left for the law below to find.
   *
   * producer-citations:end
   *
   * (This paragraph's line citations have drifted before — once across
   * #273, and now again across #274, both times because lines were added
   * ABOVE producers this paragraph already cited. Re-derived against the
   * current file each time rather than nudged, the same trap the citations
   * themselves are prose about — and the reason every citation here is
   * re-checked on every touch instead of only the ones a diff happens to
   * mention.)
   *
   * These counts moved with #71, and the reason is structural rather than
   * arithmetic: `DIFF_RC` and `GREP_RC` used to be next-line captures of
   * `VAR=$(...)` producers. #71 replaced those producers with a redirect
   * (`git diff -z ... >"$FENCE_LIST"`) and a pipeline (`printf '' | grep`),
   * so both leave this predicate's population by construction rather than
   * by becoming unchecked — their statuses are still read, one line later,
   * exactly as before. They moved again with #73: the rebase-ancestry check
   * (`ANCESTOR_ERR`/`ANCESTOR_RC`, prd46 instance 1) and the lane-manifest
   * prune's shape guard (`MANIFEST_OUT_LOG`, instance 2) each added one real
   * producer, deliberately written so the predicate can see it is checked —
   * `MANIFEST_OUT_LOG` is a same-line `|| fail` on its own `mktemp`, and the
   * multi-line `node -e` itself is run as a bare command (never captured via
   * `VAR=$(...)`) precisely so a multi-line assignment never enters this
   * predicate's blind spot (see the comment beside it in gate.sh).
   *
   * These counts are PINNED below rather than left as prose. The revision
   * that introduced this paragraph said "the remaining 12 ... 9 same-line
   * ... and 3 next-line" and then named five captures in the same sentence
   * — three numbers wrong, in a file whose subject is a claim nothing
   * checks. Only 16 and the flagged count were pinned, so the pins guarded
   * the numbers that were right and let the wrong ones rot.
   *
   * The tolerance table stays DATA, not a rule folded into the sweep: an
   * entry here is an exemption FROM the structural predicate, not (as the
   * old sweep had it) a member of the set the predicate matches. The two
   * dated KNOWN GAP entries are untouched by this issue and remain
   * declared, not fixed, exactly as before.
   */

  /** Bash never expands anything inside single quotes — no escapes, no `$(...)`, no backticks (row 8 of the table above). Scans from the opening `'` at `text[pos]` to the next `'`. Returns the index just past it, or -1 if unterminated. */
  function skipSingleQuoted(text: string, pos: number): number {
    const i = text.indexOf("'", pos + 1)
    return i === -1 ? -1 : i + 1
  }

  /** Is `text[i] === '#'` a shell COMMENT start — a word boundary (the scan's own start, or preceded by whitespace)? Mirrors `stripQuotedRunsAndComments`'s identical convention above, applied here so a `#` inside a multi-line `$(...)`/backtick body (row 20) is recognised the same way. */
  function isCommentStart(text: string, i: number, scanStart: number): boolean {
    return i === scanStart || /\s/.test(text[i - 1]!)
  }

  /** The index just past the end of the line containing `text[i]` — a `#` comment runs to end of line, never past it. */
  function skipToEndOfLine(text: string, i: number): number {
    const nl = text.indexOf('\n', i)
    return nl === -1 ? text.length : nl + 1
  }

  /**
   * Skips a `` `...` `` backtick-delimited (legacy) command substitution
   * starting at `text[pos] === '`'`. A backslash escapes the next character,
   * matching bash's own rule inside backticks. A `#` comment (row 20) is
   * skipped to end of line BEFORE it can be mistaken for a stray backtick or
   * have its own `` ` `` end the substitution early — the same bug row 20
   * fixes for `$(...)`, in its sibling function. Returns the index just past
   * the closing backtick, or -1 if unterminated.
   */
  function skipBacktick(text: string, pos: number): number {
    let i = pos + 1
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '#' && isCommentStart(text, i, pos + 1)) {
        i = skipToEndOfLine(text, i)
        continue
      }
      if (c === '`') return i + 1
      i++
    }
    return -1
  }

  /**
   * Skips a `$(...)` command substitution, `text[pos]` pointing at the `(`
   * right after the `$`. Tracks paren depth AND quote state TOGETHER, and
   * recurses into any further-nested `$(...)` it meets (row 15 of the table
   * above) — the reason a literal `)` inside a quoted argument
   * (`$(cmd "(")`) never miscounts the depth. This is also what makes a
   * MULTI-LINE `$(` ... `)` reachable (row 7): it walks the whole script
   * joined into one string, not one line at a time, so it crosses a `\n`
   * exactly like every other character. A `#` comment (row 20) is skipped to
   * end of line before its contents can be read as quotes or parens — an
   * unbalanced apostrophe in a comment (`# don't`) used to open a phantom
   * single-quoted string that swallowed the real closing `)` (vanishing the
   * whole producer), and a `)` in a comment used to close the substitution
   * early (falsely convicting a producer that really was checked, just
   * further down than the fake close). Returns the index just past the
   * matching `)`, or -1 if unterminated.
   */
  function skipDollarParen(text: string, pos: number): number {
    let i = pos + 1
    let depth = 1
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '#' && isCommentStart(text, i, pos + 1)) {
        i = skipToEndOfLine(text, i)
        continue
      }
      if (c === "'") {
        const j = skipSingleQuoted(text, i)
        if (j === -1) return -1
        i = j
        continue
      }
      if (c === '"') {
        const j = skipDoubleQuoted(text, i).end
        if (j === -1) return -1
        i = j
        continue
      }
      if (c === '`') {
        const j = skipBacktick(text, i)
        if (j === -1) return -1
        i = j
        continue
      }
      if (c === '(') {
        depth++
        i++
        continue
      }
      if (c === ')') {
        depth--
        i++
        if (depth === 0) return i
        continue
      }
      i++
    }
    return -1
  }

  /**
   * Skips a `"..."` double-quoted string starting at `text[pos] === '"'`.
   * Unlike single quotes, bash still expands `$(...)` and `` `...` `` INSIDE
   * double quotes — this is what gate.sh:24's
   * `W="$(dirname "$root")/$(basename "$root")__worktrees/$H"` depends on —
   * so both are recursed into rather than treated as opaque text, and each
   * one found flips `hasSubstitution`, which is how the caller tells a real
   * producer (`VAR="$(cmd)"`, row 2/3/6) apart from an ordinary quoted
   * literal (`VAR="hi"`, row 9): the two are indistinguishable by outer
   * shape alone. Returns the index just past the closing `"` together with
   * that flag, or `end: -1` if unterminated.
   */
  function skipDoubleQuoted(text: string, pos: number): { end: number; hasSubstitution: boolean } {
    let i = pos + 1
    let hasSubstitution = false
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') return { end: i + 1, hasSubstitution }
      if (c === '$' && text[i + 1] === '(') {
        hasSubstitution = true
        const j = skipDollarParen(text, i + 1)
        if (j === -1) return { end: -1, hasSubstitution }
        i = j
        continue
      }
      if (c === '`') {
        hasSubstitution = true
        const j = skipBacktick(text, i)
        if (j === -1) return { end: -1, hasSubstitution }
        i = j
        continue
      }
      i++
    }
    return { end: -1, hasSubstitution }
  }

  /** Declaration keywords that may precede `VAR=` — row 4. Every one of them is a BUILTIN COMMAND, not shell assignment syntax, and that distinction is the whole reason row 4 is treated specially below: bash reports the exit status of the BUILTIN, never of a `$(...)` embedded in its argument (EXECUTED, see the dedicated test near the bottom of this describe block). */
  const ASSIGNMENT_KEYWORDS = ['export', 'local', 'declare', 'typeset', 'readonly'] as const

  /**
   * Consumes a leading run of declaration keywords AND their flags from the
   * start of `line` — a LOOP over (keyword|flag)* tokens, not a fixed
   * one-keyword regex, so `declare -r V=...` (row 17, a flag BETWEEN the
   * keyword and the variable) and `export readonly V=...` (row 18, stacked
   * keywords — legal bash: `export` accepts any number of NAME or
   * NAME=value arguments, so a second bare word is simply another export
   * target) are both consumed by the SAME mechanism a verification review
   * found the original fixed-prefix regex could not see at all. A bare flag
   * with no keyword ever preceding it (`-r V=$(cmd)` on its own) is not
   * valid bash to begin with — consuming it here is harmless because
   * `hasKeyword` only turns true when an actual keyword token is seen, and
   * the caller still requires what is left over to start with `VAR=`.
   */
  function consumeKeywordPrefix(line: string): { rest: string; hasKeyword: boolean } {
    let rest = line.replace(/^\s*/, '')
    let hasKeyword = false
    for (;;) {
      const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*|-[A-Za-z]+)\s+/)
      if (!m) break
      const token = m[1]!
      const isKeyword = (ASSIGNMENT_KEYWORDS as readonly string[]).includes(token)
      const isFlag = token.startsWith('-')
      if (!isKeyword && !isFlag) break
      if (isKeyword) hasKeyword = true
      rest = rest.slice(m[0].length)
    }
    return { rest, hasKeyword }
  }

  /**
   * Does `line` (the physical line at `lineStartOffset` inside `text`, the
   * whole script joined by `\n`) open a `VAR=` assignment — optionally
   * keyword/flag-prefixed, optionally `+=` (row 16, append) — whose value is
   * a command substitution of ANY spelling in the production table above?
   * Returns the variable name, whether a declaration keyword was seen
   * anywhere in the prefix (`hasKeywordPrefix` — row 4's masking applies
   * regardless of which token in a stacked/flagged prefix carried it), and
   * the absolute offset in `text` just past the value's closing delimiter —
   * or `null` if this line does not open a producer. A single-quoted RHS
   * (row 8), a plain quoted string with no substitution inside it (row 9), a
   * bare word with no `$(`/backtick/quote at all, and arithmetic expansion
   * `$((...))` (row 19 — no external command runs) all return `null`.
   */
  function matchProducerAt(text: string, lineStartOffset: number, line: string): { varName: string; endOffset: number; hasKeywordPrefix: boolean } | null {
    const { rest, hasKeyword } = consumeKeywordPrefix(line)
    const varMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=/)
    if (!varMatch) return null
    const rhsStart = lineStartOffset + (line.length - rest.length) + varMatch[0].length
    const c0 = text[rhsStart]
    if (c0 === '$' && text[rhsStart + 1] === '(') {
      // `$((` is ARITHMETIC expansion (row 19), not command substitution —
      // no process runs, so there is no exit status for this law to demand
      // a check on. Checked here, before committing to skipDollarParen,
      // which a verification review found dispatches on `$` + `(` alone and
      // so could not tell the two apart.
      if (text[rhsStart + 2] === '(') return null
      const end = skipDollarParen(text, rhsStart + 1)
      return end === -1 ? null : { varName: varMatch[1]!, endOffset: end, hasKeywordPrefix: hasKeyword }
    }
    if (c0 === '`') {
      const end = skipBacktick(text, rhsStart)
      return end === -1 ? null : { varName: varMatch[1]!, endOffset: end, hasKeywordPrefix: hasKeyword }
    }
    if (c0 === '"') {
      const { end, hasSubstitution } = skipDoubleQuoted(text, rhsStart)
      return end === -1 || !hasSubstitution ? null : { varName: varMatch[1]!, endOffset: end, hasKeywordPrefix: hasKeyword }
    }
    return null
  }

  /** Cumulative start offset of each line inside `scriptLines.join('\n')` — lets a character offset be mapped back to the line it falls on. */
  function lineStartOffsets(scriptLines: readonly string[]): number[] {
    const starts: number[] = []
    let offset = 0
    for (const l of scriptLines) {
      starts.push(offset)
      offset += l.length + 1
    }
    return starts
  }

  /** The index of the line containing absolute offset `pos` (binary search over the ascending `starts`). */
  function lineIndexForOffset(starts: readonly number[], pos: number): number {
    let lo = 0
    let hi = starts.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! <= pos) {
        ans = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return ans
  }

  /** The largest literal bash will accept for `exit`; beyond it bash prints "numeric argument required" and exits 2 — itself an honest abort. */
  const BASH_EXIT_MAX = 9223372036854775807n

  /**
   * Is `exit <n>` an honest abort, or a fake success wearing a nonzero
   * number? The shell truncates an exit status to its low 8 bits, so
   * `exit 256` and `exit 512` leave a status of 0 — indistinguishable from
   * `exit 0`, which this predicate deliberately refuses to treat as safe.
   * Testing `n !== '0'` accepted them, so the test asserting the predicate
   * "tells apart || exit 2 from || exit 0" was making a claim it did not
   * meet for every other multiple of 256.
   *
   * BigInt, not Number, and the bound is not decoration. `\d+` admits a
   * literal of any length, and IEEE754 rounds: `Number('9007199254740993')`
   * becomes ...992, so a Number-based rule called an honest `exit` (bash
   * status 1) a fake success. Rounding the other way is worse — bash exits
   * 0 on `exit 9007199254741248`, a genuine fake success that any
   * safe-integer shortcut waves through. Only exact decimal arithmetic plus
   * bash's own accepted range agrees with the shell at every input; the
   * test below asserts that agreement against bash rather than against a
   * re-typed table.
   */
  function isHonestAbortStatus(digits: string): boolean {
    const n = BigInt(digits)
    if (n > BASH_EXIT_MAX) return true
    return n % 256n !== 0n
  }

  /**
   * The shell text of a rescue block with every quoted RUN and any trailing
   * COMMENT removed, so a `fail`/`exit N` that is merely MENTIONED — in a
   * message or in a comment — is not mistaken for one that is CALLED.
   *
   * `tailChecksStatus`'s same-line branches anchor at the start of the
   * right-hand side (`/^fail\b/`, `/^exit\s+(\d+)\b/`), so no string can
   * precede them there. Its BLOCK branch scans the whole block with
   * `\bfail\b` / `\bexit\s+(\d+)\b`, which a string literal satisfies —
   * that is a spelling match inside the predicate whose whole subject is
   * structure over spelling. EXECUTED, planted into a copy of the real
   * scripts/gate.sh: `RES=$(some_new_check) || { echo "  fail to check"; }`
   * left ruling 1's own test GREEN over a producer that swallows its
   * failure entirely.
   *
   * A single left-to-right scan, not two `replace` passes: stripping `'...'`
   * first would let an apostrophe inside a double-quoted message open a
   * bogus run and swallow the rest of the line. A stripped run leaves a
   * space behind so `fail"x"` cannot be glued into a new token.
   *
   * A comment is the SIBLING of the quoted message and arrives at the same
   * branch by the same route: `|| { echo no; }  # fail is handled elsewhere`
   * was still credited with calling fail() after quoted runs alone were
   * stripped (EXECUTED, review of #126). It is cut in the SAME scan rather
   * than by a later `replace`, because whether a `#` opens a comment depends
   * on quote state and on the character before it: bash starts a comment
   * only at the start of a word, so `${LOG#/tmp/}` and `$#` are not
   * comments, and neither is the `#` in `echo "x"# fail`, where the closing
   * quote leaves a space in the OUTPUT that the original never had. Running
   * the cut after the strip would read that manufactured space and eat a
   * real call; running it inside the scan reads the source.
   */
  function stripQuotedRunsAndComments(s: string): string {
    let out = ''
    let quote: "'" | '"' | null = null
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!
      if (quote === null) {
        if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) break
        else if (c === "'" || c === '"') {
          quote = c
          out += ' '
        } else if (c === '\\') {
          i++
          out += ' '
        } else out += c
      } else {
        if (quote === '"' && c === '\\') i++
        else if (c === quote) quote = null
      }
    }
    return out
  }

  /** Does the text AFTER the $(...)'s closing paren, on the SAME line, terminate the script on failure — `|| fail`, `|| exit N` (N != 0), or a `|| { ... }` block calling either? `exit 0` is deliberately NOT terminal-safe: it swallows a failure into a fake overall SUCCESS rather than an honest abort. */
  function tailChecksStatus(tail: string): boolean {
    const t = tail.trim()
    if (!t.startsWith('||')) return false
    const rhs = t.slice(2).trim()
    if (/^fail\b/.test(rhs)) return true
    const exitMatch = rhs.match(/^exit\s+(\d+)\b/)
    if (exitMatch && isHonestAbortStatus(exitMatch[1]!)) return true
    if (rhs.startsWith('{')) {
      // Quoted runs and any trailing comment stripped first: a block that
      // merely NAMES failure — in its message or in a comment beside it —
      // is not a block that calls fail(). See stripQuotedRunsAndComments.
      const body = stripQuotedRunsAndComments(rhs)
      if (/\bfail\b/.test(body)) return true
      const blockExit = body.match(/\bexit\s+(\d+)\b/)
      if (blockExit && isHonestAbortStatus(blockExit[1]!)) return true
    }
    return false
  }

  /** Does the very NEXT source line capture the assignment's own `$?` (the `DIFF_RC=$?` / `STATUS_RC=$?` shape)? Deliberately not anchored to the SAME variable name — gate.sh names these after what they check (`GREP_RC` for a `viol=` assignment), not after the assigned variable. */
  function nextLineCapturesRC(nextLine: string | undefined): boolean {
    if (nextLine === undefined) return false
    return /^\s*[A-Za-z_][A-Za-z0-9_]*=\$\?\s*$/.test(nextLine)
  }

  /**
   * Finds a heredoc opener (`<<`, optionally `-` to strip leading tabs, an
   * optional matching quote around the delimiter, then the delimiter word)
   * in `line`, tracking quote state and comments ITSELF rather than reusing
   * `stripQuotedRunsAndComments` — that helper DISCARDS quoted content
   * entirely (it exists to feed `tailChecksStatus`'s spelling checks, which
   * never need the text back), so it silently ate the delimiter of a
   * QUOTED heredoc (`<<'EOF'`) and broke detection of exactly that form.
   * This scanner keeps the delimiter text; it stops at an unquoted `#`
   * (nothing real follows) and never fires while inside a `'...'`/`"..."`
   * span, so a `<<EOF`-looking substring sitting inside a message
   * (`echo "example: cmd <<EOF"`) is not mistaken for a real opener — that
   * mistake is the dangerous direction, since it would hide every real
   * producer between the false opener and wherever a same-named terminator
   * line next happens to occur.
   */
  function findHeredocStart(line: string): { delimiter: string; stripLeadingTabs: boolean } | null {
    let quote: "'" | '"' | null = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote === null) {
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return null
        if (c === "'" || c === '"') {
          quote = c
          continue
        }
        if (c === '\\') {
          i++
          continue
        }
        if (c === '(' && line[i + 1] === '(') {
          // `((...))` is an ARITHMETIC context, where `<<` is the LEFT-SHIFT
          // OPERATOR, not a heredoc opener (row 22). The whole span is
          // skipped by paren depth so `(( a << b ))` cannot name `b` as a
          // delimiter. An unbalanced `((` runs the scan to end of line and
          // returns null — the safe direction, since a false opener hides
          // producers while a missed one only leaves them visible.
          let depth = 0
          let j = i
          for (; j < line.length; j++) {
            if (line[j] === '(') depth++
            else if (line[j] === ')') {
              depth--
              if (depth === 0) break
            }
          }
          i = j
          continue
        }
        if (c === '<' && line[i + 1] === '<') {
          // `<<<` is a HERE-STRING (row 22): its operand is a word fed on
          // stdin, never a delimiter naming a body. All THREE characters are
          // skipped deliberately — letting the loop retry at `i + 1` would
          // find the trailing `<<` and read the operand as a delimiter,
          // which is exactly the bug this guards.
          if (line[i + 2] === '<') {
            i += 2
            continue
          }
          const m = line.slice(i).match(/^<<([-~]?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/)
          if (m) return { delimiter: m[3]!, stripLeadingTabs: m[1] === '-' }
        }
      } else {
        if (quote === '"' && c === '\\') i++
        else if (c === quote) quote = null
      }
    }
    return null
  }

  /**
   * Which lines of `scriptLines` are heredoc BODY content (row 21) — DATA
   * being piped to a command, never executable assignments, so
   * `findAllProducers` must not scan them at all.
   */
  function computeHeredocBodyLines(scriptLines: readonly string[]): boolean[] {
    const isBody = new Array<boolean>(scriptLines.length).fill(false)
    let i = 0
    while (i < scriptLines.length) {
      const found = findHeredocStart(scriptLines[i]!)
      if (!found) {
        i++
        continue
      }
      let j = i + 1
      while (j < scriptLines.length) {
        isBody[j] = true
        const body = found.stripLeadingTabs ? scriptLines[j]!.replace(/^\t+/, '') : scriptLines[j]!
        if (body === found.delimiter) break
        j++
      }
      i = j + 1
    }
    return isBody
  }

  /**
   * Every producer (any spelling in the table above) in `scriptLines`,
   * paired with its TAIL — the text right after its closing delimiter, on
   * whichever physical line that delimiter falls on (the same line as the
   * start for every spelling except row 7, the multi-line form) — and
   * whether a declaration keyword prefixed it (row 4). A producer that spans
   * multiple lines advances the scan past its own close, so an intermediate
   * or closing line is never re-scanned as a fresh assignment start, and a
   * heredoc body line (row 21) is skipped outright.
   */
  function findAllProducers(scriptLines: readonly string[]): { index: number; line: string; tail: string; endLineIndex: number; hasKeywordPrefix: boolean }[] {
    const text = scriptLines.join('\n')
    const starts = lineStartOffsets(scriptLines)
    const heredocBody = computeHeredocBodyLines(scriptLines)
    const out: { index: number; line: string; tail: string; endLineIndex: number; hasKeywordPrefix: boolean }[] = []
    let i = 0
    while (i < scriptLines.length) {
      const line = scriptLines[i]!
      if (line.trim().startsWith('#') || heredocBody[i]) {
        i++
        continue
      }
      const m = matchProducerAt(text, starts[i]!, line)
      if (!m) {
        i++
        continue
      }
      const endLineIndex = lineIndexForOffset(starts, m.endOffset - 1)
      const tail = scriptLines[endLineIndex]!.slice(m.endOffset - starts[endLineIndex]!)
      out.push({ index: i, line, tail, endLineIndex, hasKeywordPrefix: m.hasKeywordPrefix })
      i = endLineIndex + 1
    }
    return out
  }

  /**
   * The structural predicate itself (ruling 1): every producer (any spelling
   * in the table above) whose exit status is checked neither on its tail nor
   * on the line right after its close — with row 4's rule applied FIRST and
   * unconditionally: a keyword-prefixed producer's `$?` comes from the
   * KEYWORD BUILTIN, never from the substitution, so no tail shape and no
   * next-line capture can ever legitimately check it (EXECUTED, see the
   * dedicated test below) — it is always reported unchecked, regardless of
   * how safe the line looks to a human reader.
   */
  function findUncheckedProducers(scriptLines: readonly string[]): { index: number; line: string }[] {
    return findAllProducers(scriptLines)
      .filter((p) => p.hasKeywordPrefix || (!tailChecksStatus(p.tail) && !nextLineCapturesRC(scriptLines[p.endLineIndex + 1])))
      .map((p) => ({ index: p.index, line: p.line }))
  }

  const DECLARED_TOLERANCES = [
    { needle: 'checkout -- package-lock.json 2>/dev/null || true', count: 2, reason: 'clean(): best-effort lockfile checkout; nothing to clean is not a check failure' },
    { needle: 'workmux rebase "$H" >/dev/null 2>&1 || echo', count: 1, reason: "workmux's exit code is not the check — ancestry is asserted separately right after" },
    { needle: 'git push origin main 2>&1 | tail -1 || {', count: 1, reason: 'push_or_warn(): the one documented non-fatal check in the file (prd-39 ruling 1)' },
    { needle: 'workmux path "$H" 2>/dev/null | tail -1', count: 1, reason: 'resolves $W; the very next line ([ -d "${W:-}" ] on :24) checks the result and falls back to a constructed path — the verdict is the existence check, not this redirect. Structural predicate: an UNCHECKED $(...) assignment, exempted here rather than by spelling.' },
    { needle: 'rev-parse --abbrev-ref HEAD 2>/dev/null) || fail', count: 1, reason: "stderr text is discarded, but the command's own exit code is still routed through fail() via || — structurally CHECKED, kept here for the historical record only." },
    {
      // This needle deliberately avoids gate.sh's timing-opt-in marker
      // comment text as a contiguous substring. An earlier version of this
      // entry embedded that exact marker literally, which made THIS test
      // file itself match gate.sh's own fixed-string content grep for it
      // (that grep has no notion of "inside a JS string" — a literal
      // substring match is a literal substring match) — enrolling this law
      // in the timing set it does not belong to (verified: TCOUNT 6 on
      // origin/main -> 7 on this branch, this file the seventh). Anchoring
      // on a marker-free substring of the SAME source line keeps the
      // entry's identity without re-triggering the defect it describes.
      needle: "include='*.test.tsx' packages 2>/dev/null",
      count: 1,
      reason:
        "KNOWN GAP, dated 2026-08-25, not fixed by #42 or #70 — this producer's own exit status is never checked before its output feeds the process substitution a few lines below (the same producer-swallowed-by-a-process-substitution shape the NUL guard itself needed fixing for). Out of the structural predicate's scope too: it is a process substitution feeding a `while read` loop, not a `VAR=$(...)` assignment. Named in #42's commit body as a real ninth instance; #70 folds gate.sh:82 and the sweep redesign into one issue but leaves THIS one declared, per the issue's own text ('the two dated KNOWN GAP entries stay as they are').",
    },
    { needle: "find packages -name '*.bench.test.ts' 2>/dev/null", count: 1, reason: 'the second half of the same undeclared producer pair above; same deferral' },
  ] as const

  function codeLines(): string[] {
    return LINES.filter((l) => !l.trim().startsWith('#'))
  }

  it('every declared tolerance is present exactly where declared', () => {
    for (const t of DECLARED_TOLERANCES) {
      const hits = codeLines().filter((l) => l.includes(t.needle))
      expect(hits.length, `expected ${t.count} occurrence(s) of ${JSON.stringify(t.needle)} (${t.reason}), found ${hits.length}`).toBe(t.count)
    }
  })

  it('ruling 1 — no undeclared $(...) assignment in scripts/gate.sh leaves its exit status unread before a verdict prints', () => {
    const unchecked = findUncheckedProducers(LINES)
    const undeclared = unchecked.filter((u) => !DECLARED_TOLERANCES.some((t) => u.line.includes(t.needle)))
    expect(undeclared.map((u) => `${u.index + 1}: ${u.line.trim()}`), 'undeclared unchecked producer(s) in scripts/gate.sh — fix the shape (see the :82 commit-count fix below) or add a DECLARED_TOLERANCES entry with a reason').toEqual([])
  })

  it('EXECUTED — the measured false-positive rate on the real file, RE-DERIVED after #179 widened the predicate, #273 added the verdict output-capture producer, and #274 added two more: still 1 of 20 flagged, it is declared, 0 undeclared', () => {
    // findAllProducers, not a codeLines()+regex filter: the widened predicate
    // recognises multi-line producers that a per-line filter cannot even
    // represent (row 7), so the count of "producers" and the count of
    // "unchecked producers" must come from the SAME walk that does the real
    // scanning, not two different notions of "a $(...) line" that could
    // silently drift apart.
    const allProducers = findAllProducers(LINES)
    const unchecked = findUncheckedProducers(LINES)
    const undeclared = unchecked.filter((u) => !DECLARED_TOLERANCES.some((t) => u.line.includes(t.needle)))
    // UNCHANGED from before #179's widening THROUGH #273: gate.sh contained
    // no live instance of rows 2-7 of the table above, so widening the
    // predicate found nothing NEW there — it only meant a FUTURE line
    // written that way would now be seen. That changed with #274, below.
    //
    // 18 -> 20 (#274): `emit_gate_verdict` gained two producers when the
    // beacon write landed — `verdict_line=$(python3 ...)` (capturing the
    // line that used to be printed directly, uncaptured, so it could also be
    // appended byte-for-byte to the beacon file) and
    // `beacon_dir=$(... "$root/node_modules/.bin/tsx" -e ...)` (resolving
    // beaconDirFor() rather than re-deriving its path in shell). Both are
    // CHECKED, not flagged: each is followed on the very next line by its
    // own bare `_RC=$?` capture (`VERDICT_LINE_RC=$?`, `BEACON_DIR_RC=$?`),
    // so `unchecked` does not move — see the next-line bucket below, which
    // is where both land. Both are ALSO the first live instance of row 7
    // (the multi-line `$(...)` form): each opens its `$(` on one line and
    // closes it several lines down, past a quoted script argument that
    // itself spans multiple lines — so "no live instance of rows 2-7" is no
    // longer true of this file, proven by count rather than left as the
    // stale claim above would still have it.
    expect(allProducers.length, 'total producers (any spelling) in scripts/gate.sh drifted — the doc comment above cites this count').toBe(20)
    expect(unchecked.length, 'flagged (structurally unchecked) count drifted — the doc comment above cites this count').toBe(1)
    expect(undeclared.length).toBe(0)

    // The doc comment's OTHER numbers, pinned since #179. The revision before
    // that one got all three wrong precisely because only the totals were
    // pinned.
    //
    // `!p.hasKeywordPrefix` on both buckets: a keyword-prefixed producer
    // whose TAIL merely LOOKS like `|| fail` (or is followed by a `_RC=$?`
    // capture) is never actually checked — see findUncheckedProducers — so
    // counting it as "same-line" or "next-line" here would double-book it
    // against `unchecked` below and break the invariant on the last line.
    // No live instance changes today (gate.sh has no keyword-prefixed
    // producer), but the filters must agree with the real classification
    // rather than happen to agree by the accident of an empty case.
    //
    // 5 -> 7 (#274): both new producers land in the NEXT-LINE bucket, not
    // same-line — `verdict_line=$(...)` and `beacon_dir=$(...)` are each
    // checked by a bare `_RC=$?` assignment on the line right after them,
    // never by a `||`-shaped tail on the same line. `sameLine` is unmoved.
    const sameLine = allProducers.filter((p) => !p.hasKeywordPrefix && tailChecksStatus(p.tail))
    const nextLine = allProducers.filter((p) => !p.hasKeywordPrefix && !tailChecksStatus(p.tail) && nextLineCapturesRC(LINES[p.endLineIndex + 1]))
    expect(sameLine.length, 'same-line-checked count drifted — the doc comment above cites it').toBe(12)
    expect(nextLine.length, 'next-line _RC=$? count drifted — the doc comment above cites it').toBe(7)
    expect(sameLine.length + nextLine.length + unchecked.length).toBe(allProducers.length)
  })

  /**
   * Review of #274, round 3 (EXECUTED). The doc comment above cites all 20
   * producers BY LINE NUMBER, and those numbers have now staled three times:
   * across #273, across #274's first repair, and across #274's SECOND repair
   * — which staled 17 of the 20 while its own commit body asserted the
   * sibling sweep had found none left. Each time the counts were pinned and
   * the citations were not, so each time the suite stayed green over a
   * paragraph that had become false.
   *
   * The counts were already pinned; pinning them again would not have caught
   * any of the three. What was missing is that the CITATIONS and the FILE
   * never had to agree. They do now: the numbers between the markers are
   * extracted from this file's own source and compared, as a set, against
   * the producers `findAllProducers` finds. A line added anywhere above a
   * cited producer reddens this the moment it lands.
   *
   * The two guards on the markers are not decoration — without them, deleting
   * a marker turns the law into `expect([]).toEqual([])` and it passes
   * having checked nothing, which is precisely how the pinned counts kept
   * passing over stale prose.
   */
  it('every gate.sh line the producer doc comment cites IS a producer, and every producer is cited', () => {
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const begin = own.indexOf('producer-citations:begin')
    const end = own.indexOf('producer-citations:end')
    expect(begin, 'the opening marker is gone — a law that cannot find its subject passes vacuously, which is the failure this law exists to end').toBeGreaterThan(-1)
    expect(end, 'the closing marker is gone, or precedes the opening one').toBeGreaterThan(begin)

    const cited = [...new Set([...own.slice(begin, end).matchAll(/:(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
    const actual = findAllProducers(LINES).map((pr) => pr.index + 1).sort((a, b) => a - b)

    expect(cited.length, 'the citation block must not be empty — see the marker guards above').toBeGreaterThan(0)
    expect(
      cited,
      'the producer doc comment cites gate.sh line numbers that are no longer producers. Re-derive them against the current file — every one of them, not only the ones this diff happens to touch. This is the third recurrence; .swarm/coupling.txt:64 and the PRD both require the prose to move in the SAME edit as the pins.',
    ).toEqual(actual)
  })

  describe("ruling 2 — the structural predicate's own controls run the REAL predicate, not a restatement of it", () => {
    /**
     * Ruling 2's own target, named in the issue: the OLD non-vacuity
     * control asserted a rigged STRING failed to match a declared NEEDLE
     * and never ran the sweep at all. Every case below calls
     * `findUncheckedProducers`, the actual predicate defined above, against
     * real (synthetic) script text — first in isolation, then planted into
     * a COPY of gate.sh's real lines, the way #68's verification did.
     */
    const RIGGED_LINES: { label: string; lines: string[] }[] = [
      { label: '|| : — four characters from || true, identical semantics', lines: ['SOME_NEW_CHECK=$(some_new_check) || :', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '2> /dev/null — spaced stderr redirect, no status check at all', lines: ['SOME_NEW_CHECK=$(some_new_check 2> /dev/null)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '&>/dev/null — both streams redirected, no status check', lines: ['SOME_NEW_CHECK=$(some_new_check &>/dev/null)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '||true — no space', lines: ['SOME_NEW_CHECK=$(some_new_check) ||true', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'RES=$(cmd | tail -1) — a bare pipeline assignment, no check', lines: ['SOME_NEW_CHECK=$(some_new_check | tail -1)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'cmd || { echo "(could not check)"; } — rescue block with no fail/exit', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  (could not check)"; }', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — 2>&- (closes stderr, no status check)', lines: ['SOME_NEW_CHECK=$(some_new_check 2>&-)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — >/dev/null 2>&1 (redirect-combo spelling)', lines: ['SOME_NEW_CHECK=$(some_new_check >/dev/null 2>&1)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — || exit 0 (aborts the WHOLE gate with a fake SUCCESS, not an honest hold)', lines: ['SOME_NEW_CHECK=$(some_new_check) || exit 0', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — ; true (sequential, not ||, so the assignment status is simply discarded)', lines: ['SOME_NEW_CHECK=$(some_new_check) ; true', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — no check anywhere near it, an unrelated line intervenes before the verdict', lines: ['SOME_NEW_CHECK=$(some_new_check)', 'echo "checked"', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      // The block branch used to scan the RAW block text, so a message that
      // merely NAMED failure was credited as a call to fail() — a spelling
      // match sitting inside the predicate whose subject is structure over
      // spelling. Both routes into that branch are covered.
      { label: 'BEYOND THE SIX — rescue block whose MESSAGE says "fail" while calling neither fail nor exit', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  fail to check"; }', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — rescue block whose MESSAGE says "exit 2" while calling neither', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  would exit 2 if this were fatal"; }', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: "BEYOND THE SIX — single-quoted message naming fail, with an apostrophe-bearing double-quoted message beside it", lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "don\'t panic"; echo \'soft fail\'; }', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      // The sibling of the three above (review of #126): stripping quoted
      // runs alone left the same branch crediting a `fail`/`exit N` that a
      // COMMENT merely names. All three of these were EXECUTED against the
      // quotes-only predicate and went unflagged.
      { label: 'BEYOND THE SIX — swallowing rescue block whose trailing COMMENT names fail', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  soft"; }  # fail is handled elsewhere', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — swallowing rescue block whose trailing COMMENT names exit 2', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  soft"; }  # would exit 2 if this were fatal', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'BEYOND THE SIX — comment carrying a semicolon, so a segment-splitting cut would resurrect the token a whole-comment cut removes', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  soft"; }  # not fatal; fail comes later', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      // #179 — the four spellings the OLD (bare-`VAR=$(`-only) predicate was
      // blind to (production table rows 2, 3, 4, 5, 6, 7 above). Each one
      // runs the SAME `some_new_check` unchecked; only the assignment's
      // spelling differs.
      { label: '#179 — quoted $(...): VAR="$(cmd)"', lines: ['SOME_NEW_CHECK="$(some_new_check)"', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — quoted, substitution mixed with literal text: VAR="prefix-$(cmd)-suffix" (gate.sh:24\'s own shape)', lines: ['SOME_NEW_CHECK="prefix-$(some_new_check)-suffix"', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — export-prefixed: export VAR=$(cmd)', lines: ['export SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — local-prefixed: local VAR=$(cmd)', lines: ['local SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — declare-prefixed: declare VAR=$(cmd)', lines: ['declare SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — typeset-prefixed: typeset VAR=$(cmd)', lines: ['typeset SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — readonly-prefixed: readonly VAR=$(cmd)', lines: ['readonly SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: "#179 — backtick (legacy substitution): VAR=`cmd`", lines: ['SOME_NEW_CHECK=`some_new_check`', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — quoted backtick: VAR="`cmd`"', lines: ['SOME_NEW_CHECK="`some_new_check`"', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 — multi-line $(...): VAR=$(\\n  cmd\\n)', lines: ['SOME_NEW_CHECK=$(', '  some_new_check', ')', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      // Row 15 of the production table: a literal paren, only DATA because it
      // sits inside a quoted string inside a NESTED $(...), must not confuse
      // the depth count into closing early (or never).
      { label: "#179 — a literal ')' inside a quoted string inside a nested $(...) does not miscount the outer depth", lines: [`SOME_NEW_CHECK=$(some_new_check "$(echo ')')")`, '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      // Row 4, REVISED after verification review — the single most dishonest
      // shape in the whole grammar: a same-line `|| fail` or next-line
      // `_RC=$?` on a KEYWORD-PREFIXED producer reads $? from the KEYWORD
      // BUILTIN, never from the substitution (EXECUTED against real bash, see
      // the dedicated test below), so it can NEVER fire and must still
      // convict — moved here from HONEST_LINES, where round 1 of this fix
      // wrongly shipped them as "the real predicate stays SILENT on an
      // honest form".
      { label: '#179 — export-prefixed producer with a same-line || fail that CANNOT actually check it', lines: ['export SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: '#179 — export-prefixed producer with a next-line _RC=$? that CANNOT actually check it (captures export\'s own $?, always 0)', lines: ['export SOME_NEW_CHECK=$(some_new_check)', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
      { label: '#179 — local-prefixed producer with a same-line || fail that CANNOT actually check it', lines: ['local SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: '#179 — declare-prefixed producer with a same-line || fail that CANNOT actually check it', lines: ['declare SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: '#179 — typeset-prefixed producer with a same-line || fail that CANNOT actually check it', lines: ['typeset SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: '#179 — readonly-prefixed producer with a same-line || fail that CANNOT actually check it', lines: ['readonly SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      // Rows 17 and 18 — a flag between the keyword and the variable, and
      // stacked keywords — both consumed by the same (keyword|flag)* loop
      // `consumeKeywordPrefix` runs, so both are recognised AND masked.
      { label: '#179 row 17 — a flag between the keyword and the variable: declare -r VAR=$(cmd)', lines: ['declare -r SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 row 17 — same, WITH a same-line || fail that still cannot check it', lines: ['declare -r SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: '#179 row 18 — stacked keywords: export readonly VAR=$(cmd)', lines: ['export readonly SOME_NEW_CHECK=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: '#179 row 18 — same, WITH a same-line || fail that still cannot check it', lines: ['export readonly SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      // Row 16 — append assignment. Unlike row 4, `+=` is plain assignment
      // syntax (no builtin involved), so it is checkable exactly like bare
      // `=` and belongs in RIGGED_LINES only when genuinely unchecked.
      { label: '#179 row 16 — append assignment: VAR+=$(cmd), unchecked', lines: ['SOME_NEW_CHECK+=$(some_new_check)', '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
    ]

    it.each(RIGGED_LINES)('EXECUTED — the real predicate FIRES on: $label', ({ lines }) => {
      const found = findUncheckedProducers(lines)
      expect(found.length).toBe(1)
      expect(found[0]!.line).toBe(lines[0])
    })

    it("EXECUTED — planting each rigged line into a COPY of gate.sh's real text (after the NUL check, as #68's verification did) still fires — the predicate sees the whole file, not just isolated snippets", () => {
      const anchor = uniqueLineIndex('no NUL bytes (text files; binary assets exempt)')
      for (const { lines, label } of RIGGED_LINES) {
        const planted = [...LINES.slice(0, anchor + 1), ...lines, ...LINES.slice(anchor + 1)]
        const found = findUncheckedProducers(planted)
        const plantedHit = found.find((f) => f.line === lines[0])
        expect(plantedHit, `${label} was not flagged once planted into the real file`).toBeDefined()
      }
    })

    const HONEST_LINES: { label: string; lines: string[] }[] = [
      { label: 'same-line || fail', lines: ['SOME_NEW_CHECK=$(some_new_check) || fail "problem"'] },
      { label: 'same-line || exit N (N != 0) — the form :17 uses, before fail() is even defined', lines: ['SOME_NEW_CHECK=$(some_new_check) || exit 2'] },
      { label: 'same-line || { ...; fail ...; } rescue block — the form :57 uses', lines: ['SOME_NEW_CHECK=$(some_new_check) || { cleanup; fail "problem"; }'] },
      { label: 'rescue block that CALLS fail after a quoted message mentioning neither — stripping quotes must not lose the real call', lines: ['SOME_NEW_CHECK=$(some_new_check) || { cat "$LOG"; rm -f "$LOG"; fail "cannot resolve it"; }'] },
      { label: 'rescue block that CALLS exit 2 after a quoted message — same, via the block exit path', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  giving up now"; exit 2; }'] },
      { label: 'rescue block that CALLS fail and then EXPLAINS itself in a trailing comment — cutting the comment must not cut the call', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "  context"; fail "cannot go on"; }  # non-obvious, see prd-46'] },
      { label: 'rescue block whose ${VAR#pat} expansion contains a # that does NOT open a comment — bash starts one only at a word start', lines: ['SOME_NEW_CHECK=$(some_new_check) || { rm -f ${LOG#/tmp/}; fail "cannot go on"; }'] },
      { label: 'rescue block where the # is glued to a closing quote (echo "x"# is one word, not a comment) and a real fail follows', lines: ['SOME_NEW_CHECK=$(some_new_check) || { echo "x"#y; fail "cannot go on"; }'] },
      { label: 'next-line _RC=$? capture — the form :74/:77 and :100 use', lines: ['SOME_NEW_CHECK=$(some_new_check)', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
      // #179 — the same four new spellings, this time CHECKED, both ways
      // (same-line `|| fail` and next-line `_RC=$?`) — DoD: "EXECUTED both
      // directions per spelling".
      { label: '#179 — quoted $(...), checked same-line', lines: ['SOME_NEW_CHECK="$(some_new_check)" || fail "problem"'] },
      { label: '#179 — quoted $(...), checked next-line', lines: ['SOME_NEW_CHECK="$(some_new_check)"', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
      { label: '#179 — quoted, mixed literal + substitution, checked same-line (gate.sh:24\'s own shape)', lines: ['SOME_NEW_CHECK="prefix-$(some_new_check)-suffix" || fail "problem"'] },
      { label: "#179 — backtick, checked same-line", lines: ['SOME_NEW_CHECK=`some_new_check` || fail "problem"'] },
      { label: "#179 — backtick, checked next-line", lines: ['SOME_NEW_CHECK=`some_new_check`', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
      { label: '#179 — quoted backtick, checked same-line', lines: ['SOME_NEW_CHECK="`some_new_check`" || fail "problem"'] },
      { label: '#179 — multi-line $(...), checked on the CLOSING line', lines: ['SOME_NEW_CHECK=$(', '  some_new_check', ') || fail "problem"'] },
      { label: '#179 — multi-line $(...), checked on the line AFTER the close', lines: ['SOME_NEW_CHECK=$(', '  some_new_check', ')', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
      { label: "#179 — a literal ')' inside a quoted string inside a nested $(...), checked", lines: [`SOME_NEW_CHECK=$(some_new_check "$(echo ')')") || fail "problem"`] },
      // Rows 8-10 of the production table: never producers at all, so the
      // predicate must be SILENT on them too — not because they are
      // "checked", but because there is nothing to check.
      { label: "row 8 — single-quoted: VAR='$(cmd)' is a literal string, not a command; never a producer", lines: ["SOME_NEW_CHECK='$(some_new_check)'", '[ -n "$SOME_NEW_CHECK" ] && fail "new problem"'] },
      { label: 'row 9 — a quoted string with no substitution inside is not a producer', lines: ['SOME_NEW_CHECK="just text"'] },
      { label: 'row 10 — an escaped \\$( inside a quoted string is not a producer (the backslash suppresses expansion)', lines: ['SOME_NEW_CHECK="literal \\$(not a command)"'] },
      { label: 'row 9, live in gate.sh — export PATH="$HOME/.local/bin:$PATH" (:14) is a plain quoted string, not a producer', lines: ['export PATH="$HOME/.local/bin:$PATH"'] },
      // Row 16 — append assignment, checked both ways (no keyword involved,
      // so unlike row 4 this genuinely IS checkable).
      { label: '#179 row 16 — append assignment, checked same-line', lines: ['SOME_NEW_CHECK+=$(some_new_check) || fail "problem"'] },
      { label: '#179 row 16 — append assignment, checked next-line', lines: ['SOME_NEW_CHECK+=$(some_new_check)', 'SOME_NEW_CHECK_RC=$?', '[ "$SOME_NEW_CHECK_RC" -ne 0 ] && fail "problem"'] },
    ]

    it.each(HONEST_LINES)('EXECUTED — the real predicate stays SILENT on an honest form: $label', ({ lines }) => {
      expect(findUncheckedProducers(lines)).toEqual([])
    })

    /**
     * Row 4's whole justification, asserted against bash itself rather than
     * against this file's own model of it — a verification review found the
     * distinction and verified it exactly this way. `export`, `local`,
     * `declare`, `typeset` and `readonly` are all BUILTIN COMMANDS: writing
     * `KEYWORD V=$(cmd)` hands the assignment to that builtin as an
     * argument, and the exit status of the whole simple command becomes the
     * BUILTIN's own — `export` succeeds (name is valid) regardless of
     * whether `cmd` failed. A bare `V=$(cmd)` has no command name at all, so
     * bash's assignment-expansion rule applies instead: the exit status IS
     * the substitution's. Round 1 of this fix treated all keyword-prefixed
     * forms as checkable, which is what made three HONEST_LINES fixtures
     * (now moved to RIGGED_LINES) wrong.
     */
    it("EXECUTED — bash reports a keyword-prefixed assignment's OWN exit status, never the substitution's — every ASSIGNMENT_KEYWORDS entry, both `|| echo` and `_RC=$?` shapes", () => {
      const bareGuard = spawnSync('bash', ['-c', 'V=$(false) || echo GUARD_RAN'], { encoding: 'utf8' })
      expect(bareGuard.stdout, 'CONTROL: the bare form must still let the guard run, or this test proves nothing').toContain('GUARD_RAN')
      const bareRc = spawnSync('bash', ['-c', 'V=$(false); echo "RC=$?"'], { encoding: 'utf8' })
      expect(bareRc.stdout, "CONTROL: the bare form must report the substitution's own nonzero status").toContain('RC=1')

      for (const kw of ASSIGNMENT_KEYWORDS) {
        // `local` is only legal inside a function.
        const guardScript = kw === 'local' ? 'f() { local V=$(false) || echo GUARD_RAN; }; f' : `${kw} V=$(false) || echo GUARD_RAN`
        const guardRes = spawnSync('bash', ['-c', guardScript], { encoding: 'utf8' })
        expect(guardRes.stdout, `${kw} V=$(false) || echo GUARD_RAN must print NOTHING — ${kw}'s own exit status (0) masks false's`).not.toContain('GUARD_RAN')

        const rcScript = kw === 'local' ? 'f() { local V=$(false); echo "RC=$?"; }; f' : `${kw} V=$(false); echo "RC=$?"`
        const rcRes = spawnSync('bash', ['-c', rcScript], { encoding: 'utf8' })
        expect(rcRes.stdout, `${kw} V=$(false) must leave $?=0, not false's 1`).toContain('RC=0')
      }
    })

    /** Row 19 — arithmetic expansion never runs a command, so it is never a producer, and the boundary with an ordinary $(...) is exact rather than over-broad. */
    it('EXECUTED — #179 row 19: arithmetic expansion $((...)) is never treated as a producer', () => {
      expect(findUncheckedProducers(['SOME_NEW_CHECK=$((1+2))'])).toEqual([])
      expect(findUncheckedProducers(['SOME_NEW_CHECK=$(( (1+2) * (3-1) ))'])).toEqual([])
      // CONTROL: the third-character check must not swallow an ORDINARY
      // command substitution — the boundary is exact, not over-broad.
      expect(findUncheckedProducers(['SOME_NEW_CHECK=$(some_new_check)'])).toHaveLength(1)
    })

    /** Row 20 — a `#` comment inside a multi-line $(...) used to either vanish the producer (an apostrophe) or falsely convict it (a paren), depending on what the comment happened to contain. */
    it('EXECUTED — #179 row 20: a comment inside a multi-line $(...) neither vanishes an unchecked producer nor falsely convicts a checked one', () => {
      const vanishing = findUncheckedProducers(['SOME_NEW_CHECK=$(', "  some_new_check  # don't lose this line", ')'])
      expect(vanishing, 'an unbalanced apostrophe in the comment used to open a phantom single-quoted string that ate the real closing )').toHaveLength(1)
      expect(vanishing[0]!.line).toBe('SOME_NEW_CHECK=$(')

      const falseConviction = findUncheckedProducers(['SOME_NEW_CHECK=$(', '  some_new_check  # this looks like a close )', ') || fail "problem"'])
      expect(falseConviction, "a ')' in the comment used to close the substitution EARLY, hiding the real || fail two lines later").toEqual([])
    })

    /** Row 21 — heredoc body lines are DATA, not code; scanning must both skip them and correctly resume right after the terminator. */
    it('EXECUTED — #179 row 21: heredoc body lines are not producers (quoted and unquoted delimiter), and scanning resumes correctly after the terminator', () => {
      expect(findUncheckedProducers(["cat <<'EOF'", 'SOME_NEW_CHECK=$(some_new_check)', 'EOF'])).toEqual([])
      expect(findUncheckedProducers(['cat <<EOF', 'SOME_NEW_CHECK=$(some_new_check)', 'EOF'])).toEqual([])

      const afterHeredoc = findUncheckedProducers(["cat <<'EOF'", 'SOME_NEW_CHECK=$(some_new_check)', 'EOF', 'REAL_CHECK=$(some_new_check)'])
      expect(afterHeredoc, 'the producer INSIDE the heredoc must stay invisible, and the REAL one right after the terminator must still be found').toHaveLength(1)
      expect(afterHeredoc[0]!.line).toBe('REAL_CHECK=$(some_new_check)')

      // CONTROL: a `<<WORD`-looking substring sitting inside a STRING (not a
      // real heredoc) must not be mistaken for one — that direction of
      // mistake would hide every real producer after it.
      const inQuotedMessage = findUncheckedProducers(['echo "example: cmd <<EOF"', 'SOME_NEW_CHECK=$(some_new_check)'])
      expect(inQuotedMessage).toHaveLength(1)
      expect(inQuotedMessage[0]!.line).toBe('SOME_NEW_CHECK=$(some_new_check)')
    })

    /**
     * Row 22 — the sibling of row 21's CONTROL. That control proved a
     * `<<EOF` inside a QUOTED MESSAGE is not mistaken for an opener; these
     * are the two spellings where the `<<` is real text, not inside any
     * quote, and still does not open a heredoc. Both hid every producer
     * below them, which is the failure direction row 21 itself names as the
     * dangerous one.
     */
    it('EXECUTED — #179 row 22: a `<<<` here-string and an arithmetic `<<` left-shift do not open a heredoc, so producers below them stay visible', () => {
      const afterHereString = findUncheckedProducers(['grep -q x <<< foo', 'SOME_NEW_CHECK=$(some_new_check)'])
      expect(afterHereString, 'a `<<<` here-string used to be read as a heredoc opener with delimiter "foo", hiding every line after it').toHaveLength(1)
      expect(afterHereString[0]!.line).toBe('SOME_NEW_CHECK=$(some_new_check)')

      // The quoted-operand spelling took the same path to the same place.
      expect(findUncheckedProducers(['grep -q x <<< "foo"', 'SOME_NEW_CHECK=$(some_new_check)'])).toHaveLength(1)

      const afterShift = findUncheckedProducers(['if (( a << b )); then :; fi', 'SOME_NEW_CHECK=$(some_new_check)'])
      expect(afterShift, 'an arithmetic left-shift with an IDENTIFIER right operand used to name that identifier as a heredoc delimiter').toHaveLength(1)
      expect(afterShift[0]!.line).toBe('SOME_NEW_CHECK=$(some_new_check)')

      // CONTROL 1: a REAL heredoc on a line that also carries an arithmetic
      // span must still be found — the new skip must not eat the opener.
      expect(findUncheckedProducers(['if (( a > 1 )); then cat <<EOF', 'SOME_NEW_CHECK=$(some_new_check)', 'EOF', 'fi'])).toEqual([])

      // CONTROL 2: `<<` on its own is still a heredoc opener. Without this
      // the fix could pass by disabling heredoc detection altogether.
      expect(findUncheckedProducers(['cat <<EOF', 'SOME_NEW_CHECK=$(some_new_check)', 'EOF'])).toEqual([])
    })

    /**
     * The blast radius, measured on the REAL file rather than on fixtures:
     * one line of either row-22 spelling above the first producer used to
     * take gate.sh's producer population from 17 to 0.
     */
    it('EXECUTED — #179 row 22: one here-string or left-shift line in the REAL scripts/gate.sh does not blind the scan', () => {
      const firstProducer = findAllProducers(LINES)[0]!.index
      for (const intruder of ['grep -q x <<< foo', 'if (( a << b )); then :; fi']) {
        const mutated = [...LINES.slice(0, firstProducer), intruder, ...LINES.slice(firstProducer)]
        expect(findAllProducers(mutated).length, `inserting ${JSON.stringify(intruder)} above the first producer must not change how many producers gate.sh has`).toBe(findAllProducers(LINES).length)
      }
    })

    it('EXECUTED — the predicate tells apart || exit 2 (honest abort) from || exit 0 (fake success) — same verb, opposite honesty', () => {
      expect(findUncheckedProducers(['X=$(cmd) || exit 2'])).toEqual([])
      expect(findUncheckedProducers(['X=$(cmd) || exit 0'])).toHaveLength(1)
    })

    /**
     * The sibling of the case above (ruling 3), and the reason `exit 0` on
     * its own was not enough: the shell truncates an exit status to 8 bits,
     * so a NONZERO literal can still leave a status of 0. bash's behaviour
     * is asserted here too, so this stays a claim about the shell rather
     * than about our own arithmetic.
     */
    it('EXECUTED — a nonzero exit LITERAL that wraps to status 0 is a fake success, not an honest abort', () => {
      for (const wrapping of ['256', '512', '768']) {
        const res = spawnSync('bash', ['-c', `X=$(false) || exit ${wrapping}; echo VERDICT`], { encoding: 'utf8' })
        expect(res.status, `bash should truncate exit ${wrapping} to 0`).toBe(0)
        expect(res.stdout, `exit ${wrapping} should still abort before the verdict`).not.toContain('VERDICT')
        expect(findUncheckedProducers([`X=$(cmd) || exit ${wrapping}`]), `|| exit ${wrapping} leaves status 0 — as dishonest as || exit 0`).toHaveLength(1)
      }
      // CONTROLS: statuses that do NOT wrap are still honest aborts.
      const control = spawnSync('bash', ['-c', 'X=$(false) || exit 2; echo VERDICT'], { encoding: 'utf8' })
      expect(control.status).toBe(2)
      expect(findUncheckedProducers(['X=$(cmd) || exit 255'])).toEqual([])
      expect(findUncheckedProducers(['X=$(cmd) || exit 257'])).toEqual([])
    })

    /**
     * The strongest form available here: rather than re-typing which
     * literals wrap, ASK BASH for each one and require the predicate to
     * agree. A re-typed expectation could encode the same wrong model the
     * code has — which is exactly how the Number()-based first attempt at
     * this rule passed its own tests while disagreeing with the shell.
     */
    it('EXECUTED — for every exit literal, the predicate agrees with what bash actually does', () => {
      const literals = ['0', '1', '2', '3', '255', '256', '257', '512', '768', '010', '0256', '0777', '1280', '65536', '9007199254740992', '9007199254740993', '9007199254741248', '9223372036854775807', '9223372036854775808', '18446744073709551616', '99999999999999999999']
      const disagreements: string[] = []
      for (const lit of literals) {
        const bashStatus = spawnSync('bash', ['-c', `exit ${lit}`], { encoding: 'utf8' }).status
        // An abort is honest iff the shell it produces is actually nonzero.
        const bashIsHonest = bashStatus !== 0
        const predicateSaysHonest = findUncheckedProducers([`X=$(cmd) || exit ${lit}`]).length === 0
        if (bashIsHonest !== predicateSaysHonest) disagreements.push(`exit ${lit}: bash status ${bashStatus} (${bashIsHonest ? 'honest' : 'fake success'}) but the predicate says ${predicateSaysHonest ? 'honest' : 'fake success'}`)
        // The rescue-block path must reach the same verdict as the same-line path.
        const blockSaysHonest = findUncheckedProducers([`X=$(cmd) || { cleanup; exit ${lit}; }`]).length === 0
        if (blockSaysHonest !== predicateSaysHonest) disagreements.push(`exit ${lit}: same-line and rescue-block paths disagree`)
      }
      expect(disagreements, 'the predicate must classify an exit literal the way bash does').toEqual([])
      // CONTROL: the table must contain both verdicts, or agreement is vacuous.
      expect(literals.some((l) => spawnSync('bash', ['-c', `exit ${l}`]).status === 0)).toBe(true)
      expect(literals.some((l) => spawnSync('bash', ['-c', `exit ${l}`]).status !== 0)).toBe(true)
    })

    /**
     * The same class in spellings nobody used to FIND it — a leading zero,
     * a larger multiple, and the rescue-BLOCK form, which reaches the wrap
     * check by a second code path. A repair proven only against the input
     * that exposed it has been narrowed by one, not closed.
     */
    it('EXECUTED — the wrap rule holds for spellings the finding did not use, including the rescue-block path', () => {
      for (const wrapping of ['0256', '1280', '65536']) {
        expect(findUncheckedProducers([`X=$(cmd) || exit ${wrapping}`]), `exit ${wrapping} wraps to 0`).toHaveLength(1)
        expect(findUncheckedProducers([`X=$(cmd) || { cleanup; exit ${wrapping}; }`]), `block-form exit ${wrapping} wraps to 0`).toHaveLength(1)
      }
      // CONTROL on BOTH paths: a non-wrapping status stays honest either way.
      expect(findUncheckedProducers(['X=$(cmd) || exit 3'])).toEqual([])
      expect(findUncheckedProducers(['X=$(cmd) || { cleanup; exit 3; }'])).toEqual([])
    })

    it("EXECUTED — not vacuous: silent against the REAL, current scripts/gate.sh once the declared exemption is subtracted, but it DOES find that exemption first — proving it walked the file rather than short-circuiting to an empty result", () => {
      const unchecked = findUncheckedProducers(LINES)
      const undeclared = unchecked.filter((u) => !DECLARED_TOLERANCES.some((t) => u.line.includes(t.needle)))
      expect(undeclared).toEqual([])
      expect(unchecked.length).toBeGreaterThan(0)
    })

    /**
     * Scope, proven rather than asserted (see the doc comment above the
     * predicate). A bare backgrounded command carries no `$(...)`
     * assignment for the predicate to even see, and a plain unassigned
     * pipeline (gate.sh's own `workmux merge "$H" | grep ...` at its merge
     * step) is likewise outside the `VAR=$(...)` shape ruling 1 names. This
     * differs from the OLD sweep's uncovered list in the respect that
     * matters: every OTHER evasion that list named (`|| :`, `2>&-`,
     * `>/dev/null 2>&1`, `|| exit 0`, `; true`) is now CAUGHT — see
     * RIGGED_LINES above — because each still occurs inside a `$(...)`
     * assignment. Only the shape that isn't an assignment survives, and
     * gate.sh's one live instance of it already has an independent,
     * RC-checked verdict a few lines later (proven by the
     * `:287 branch containment` describe block further down).
     */
    it('EXECUTED — the predicate is honest about its own remaining scope limit: a backgrounded command and a bare unassigned pipeline carry no $(...) assignment, so neither is parsed', () => {
      expect(findUncheckedProducers(['some_new_check &'])).toEqual([])
      expect(findUncheckedProducers(['some_new_check | grep pattern'])).toEqual([])
      expect(SOURCE).toContain('workmux merge "$H" 2>&1 | grep')
    })

    /**
     * #179's remaining scope limits (production table rows 11-13), proven
     * the same way as the pre-existing ones above: each shape genuinely
     * carries an unchecked producer if read as PROSE, and the predicate
     * stays silent on all three anyway, because none of them opens with a
     * (keyword-prefixed) `VAR=` at the start of the line — the anchor ruling
     * 1's own reference form sets. Declaring this rather than silently
     * matching it avoids inventing a new false positive (a `FOO=bar
     * some_cmd` env-prefix invocation, row 12) to chase a hypothetical one
     * (row 11 has exactly one live instance, gate.sh:24, and it is proven
     * checked structurally below rather than by this predicate).
     */
    it('EXECUTED — an assignment that is not the first token on the line (after `||`, or preceded by another VAR=) is declared out of scope, not silently matched', () => {
      // Row 11: gate.sh:24's own shape — `[ -d ... ] || W="$(...)"`.
      expect(findUncheckedProducers(['[ -d "$X" ] || W="$(some_new_check)"'])).toEqual([])
      // Row 12: a leading env-prefix assignment before the real target.
      expect(findUncheckedProducers(['A=1 SOME_NEW_CHECK=$(some_new_check)'])).toEqual([])
      // gate.sh:24 itself, verbatim, is exactly row 11 — proven live, not
      // hypothetical — and its correctness is NOT this predicate's job: an
      // independent existence check on $W (:40) is the actual verdict,
      // further down in the file than :24 itself.
      const w24 = uniqueLineIndex('W="$(dirname "$root")/$(basename "$root")__worktrees/$H"')
      const w40 = uniqueLineIndex('[ -d "$W" ] || fail "worktree missing')
      expect(w40).toBeGreaterThan(w24)
    })

    it('EXECUTED — an array assignment (`ARR=($(cmd))`) is a different shape entirely, not a degraded case of the scalar producer (row 13)', () => {
      expect(findUncheckedProducers(['ARR=($(some_new_check))'])).toEqual([])
    })
  })

  /**
   * A verification pass found this law had enrolled ITSELF in gate.sh's
   * timing set: an earlier revision's KNOWN GAP needle above embedded the
   * literal marker text gate.sh's own discovery greps for, and a
   * fixed-string content grep does not care whether the text it matches
   * sits inside a JS string literal — it matched this very file (TCOUNT 6
   * on origin/main -> 7 on this branch, this file the seventh). Fixing the
   * needle removes the false enrollment; this test proves it, by running
   * the REAL discovery block extracted from gate.sh — not a re-typed
   * stand-in — against this repo.
   */
  it("EXECUTED — gate.sh's real timing-file discovery, extracted and run, does NOT enroll this law file", () => {
    const DISCOVERY_BLOCK = sliceLines('TIMING_FILES=()', "find packages -name '*.bench.test.ts'")
    const script = `#!/bin/bash\nset -uo pipefail\nW="${REPO_ROOT}"\n${DISCOVERY_BLOCK}\nprintf '%s\\n' "\${TIMING_FILES[@]}"\n`
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    const files = out.split('\n').filter(Boolean)
    expect(files).not.toContain('packages/server/src/gate-honesty-law.test.ts')
    // Not vacuous: the discovery genuinely finds SOME timing files (the ones
    // that are supposed to be in the set), so an empty result here would not
    // prove exclusion, it would prove the extraction itself is broken.
    expect(files.length).toBeGreaterThan(0)
  })

  describe(':82 commit-count producer — a git-log/wc pipeline failure holds, it does not print "no commits" as if a worker forgot to commit', () => {
    const NEW_BLOCK = sliceLines('n=$(git -C "$W" log --oneline main..HEAD | wc -l)', 'no commits on the branch (a worker may have left work uncommitted — check git status in the worktree)')

    it("the fix reads the pipeline's own exit status (N_RC) before trusting $n", () => {
      expect(NEW_BLOCK).toContain('N_RC=$?')
      expect(NEW_BLOCK).toContain('git log/wc -l failed')
    })

    function corruptRepo(): string {
      const dir = scratchDir('commitcount')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      execFileSync('mv', [join(dir, '.git', 'HEAD'), join(dir, '.git', 'HEAD.bak')])
      return dir
    }

    it('EXECUTED — the OLD form reports "no commits on the branch" (the WRONG reason) when the producer itself fails', () => {
      const dir = corruptRepo()
      const OLD_BLOCK = 'n=$(git -C "$W" log --oneline main..HEAD | wc -l)\n' + '[ "$n" -eq 0 ] && fail "no commits on the branch (a worker may have left work uncommitted — check git status in the worktree)"\n' + 'echo "VERDICT: n=$n commits, no fail"\n'
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('no commits on the branch')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS on the same corrupted repo, naming the ACTUAL rc rather than blaming an uncommitted worker', () => {
      const dir = corruptRepo()
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('git log/wc -l failed')
      expect(res.stdout + res.stderr).not.toContain('a worker may have left work uncommitted')
    })

    it('EXECUTED — the NEW form still holds (unchanged) on a GENUINE zero-commit branch — not vacuously silent on the fault it was written for', () => {
      const dir = scratchDir('commitcount-zero')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('a worker may have left work uncommitted')
    })

    it('EXECUTED — the NEW form is silent on a branch with real commits ahead of main', () => {
      const dir = scratchDir('commitcount-ok')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'feature commit')
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
    })
  })

  describe(':113 dirty-count producer — a pipeline that could not RUN holds, it does not certify the worktree clean', () => {
    const NEW_BLOCK = sliceLines("dirty=$(printf '%s' \"$STATUS_OUT\" | grep -v package-lock.json | wc -l)", 'uncommitted work stranded in the worktree')

    it("the fix reads the pipeline's own exit status (DIRTY_RC) before trusting $dirty", () => {
      expect(NEW_BLOCK).toContain('DIRTY_RC=$?')
      expect(NEW_BLOCK).toContain('the dirty-count pipeline failed')
    })

    /**
     * The guard is `-gt 1`, and the four cases below are why. `-ne 0` would
     * have held every clean landing, because grep -v exits 1 when it emits
     * nothing — the ORDINARY clean-tree result, not a fault. That asymmetry
     * is why the line was DECLARED rather than fixed for one revision; the
     * declaration's second half ("-gt 1 would never fire, the pattern is a
     * fixed literal") was false, and the grep-absent case below is the
     * counter-example it missed.
     */
    /**
     * A PATH holding every tool the block needs EXCEPT the named ones.
     *
     * Removing the WHOLE PATH would be the easy version, and it does not
     * test what this block claims. `wc -l` is the RIGHTMOST stage, so if it
     * is missing too its 127 becomes the pipeline's status with or without
     * `pipefail` — and `pipefail` is the entire reason a MIDDLE stage's
     * failure is visible at all. EXECUTED: with the whole PATH blanked the
     * fixture passed identically under `set -o pipefail` and `set +o
     * pipefail`, so it could not fail for the reason it names.
     */
    /**
     * The EXTERNAL commands the dirty-count block runs. `printf` is
     * deliberately absent: bash resolves it as a BUILTIN before consulting
     * PATH, so it can be neither provided nor removed by this helper.
     * Listing it would make `pathWithout('printf')` a silent no-op — the
     * pipeline would still run, the test would still pass, and it would
     * pass for a reason it did not name, which is the defect class this
     * whole block exists to repair. Naming only what PATH can actually
     * control keeps the helper's claim true.
     */
    const DIRTY_BLOCK_EXTERNALS = ['grep', 'wc', 'head'] as const

    function pathWithout(...missing: string[]): string {
      for (const m of missing) {
        if (!DIRTY_BLOCK_EXTERNALS.includes(m as (typeof DIRTY_BLOCK_EXTERNALS)[number])) {
          throw new Error(`pathWithout(${JSON.stringify(m)}): not an external command of the dirty-count block (${DIRTY_BLOCK_EXTERNALS.join(', ')}) — removing it from PATH would be a no-op and the test would pass for the wrong reason`)
        }
      }
      const bin = scratchDir('dirtybin')
      for (const tool of DIRTY_BLOCK_EXTERNALS) {
        if (missing.includes(tool)) continue
        // `type -P` answers a PATH lookup only: a path, or nothing. `command -v`
        // answers "printf" for a builtin, and linking that name would create a
        // self-referential symlink — the helper breaking a tool it claims to hold.
        const real = execFileSync('bash', ['-c', `type -P ${tool} || true`], { encoding: 'utf8' }).trim()
        if (!real.startsWith('/')) throw new Error(`pathWithout: cannot resolve ${tool} to a real binary (got ${JSON.stringify(real)})`)
        symlinkSync(real, join(bin, tool))
      }
      return bin
    }

    function runDirty(statusOut: string, pathOverride?: string): FragmentResult {
      const dir = scratchDir('dirtycount')
      const pathLine = pathOverride === undefined ? '' : `export PATH=${JSON.stringify(pathOverride)}\n`
      const script = preludeScript(0, `STATUS_OUT=${JSON.stringify(statusOut)}\n`) + pathLine + NEW_BLOCK + '\necho "  worktree clean"\n'
      return runFragment(script, dir)
    }

    it("EXECUTED — a genuinely clean tree still passes: grep -v's no-match exit 1 is NOT treated as a fault", () => {
      const res = runDirty('')
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('worktree clean')
    })

    it('EXECUTED — a tree dirty ONLY in package-lock.json still passes (the other ordinary exit-1 shape)', () => {
      const res = runDirty(' M package-lock.json')
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('worktree clean')
    })

    it('EXECUTED — genuinely stranded work still HOLDS, exactly as before the fix', () => {
      const res = runDirty(' M packages/server/src/thing.ts')
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('uncommitted work stranded')
    })

    /**
     * The case the false declaration said could not happen. gate.sh rewrites
     * PATH itself (:14), and git resolving while grep does not is enough:
     * the pipeline reports 127, `dirty` is empty, and the OLD code printed
     * the clean verdict over genuinely stranded work.
     */
    it('EXECUTED — with grep (a MIDDLE stage) absent while wc still resolves, stranded work is HELD rather than certified clean', () => {
      const res = runDirty(' M packages/server/src/thing.ts', pathWithout('grep'))
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('the dirty-count pipeline failed')
      expect(res.stdout).not.toContain('worktree clean')
    })

    it('EXECUTED — CONTROL: the same scratch PATH with grep PRESENT behaves normally, so the fault above is the missing stage and not the harness', () => {
      const stranded = runDirty(' M packages/server/src/thing.ts', pathWithout())
      expect(stranded.status).toBe(1)
      expect(stranded.stdout + stranded.stderr).toContain('uncommitted work stranded')
      const clean = runDirty('', pathWithout())
      expect(clean.status).toBe(0)
      expect(clean.stdout).toContain('worktree clean')
    })

    it('EXECUTED — the OLD form certified that same stranded worktree CLEAN and exited 0', () => {
      const dir = scratchDir('dirtycount-old')
      const OLD_BLOCK = 'dirty=$(printf \'%s\' "$STATUS_OUT" | grep -v package-lock.json | wc -l)\n' + '[ "$dirty" -ne 0 ] && { printf \'%s\\n\' "$STATUS_OUT" | head -5; fail "uncommitted work stranded in the worktree"; }\n'
      const script = preludeScript(0, 'STATUS_OUT=" M packages/server/src/thing.ts"\n') + `export PATH=${JSON.stringify(pathWithout('grep'))}\n` + OLD_BLOCK + 'echo "  worktree clean"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('worktree clean')
    })
  })

  describe(':98 fence audit — an invalid FENCE holds, and a hostile path is compared as bytes, not as text', () => {
    const NEW_BLOCK = sliceLines('printf \'\' | grep -E "$FENCE"', 'fence OK: ${DIFF_FILES')

    it('the old masking form ( grep -vE "$FENCE" || true ) is gone from the file', () => {
      expect(SOURCE).not.toContain('grep -vE "$FENCE" || true')
    })

    it('the fix checks the producer (git diff) and the grep exit code separately', () => {
      expect(NEW_BLOCK).toContain('DIFF_RC=$?')
      expect(NEW_BLOCK).toMatch(/GREP_RC=\$\?/)
      expect(NEW_BLOCK).toContain('-gt 1')
    })

    it('the fix reads a NUL-delimited listing via -z / read -r -d \'\', not line-delimited `read -r`', () => {
      expect(NEW_BLOCK).toContain('diff -z main...HEAD --name-only')
      expect(NEW_BLOCK).toContain("read -r -d ''")
    })

    /**
     * The two pairs below close the two gaps the review of #155 EXECUTED against
     * the merged shape of this block. Both follow the standard the café.ts pair
     * one screen down already sets — a text assertion AND a real fixture — and
     * each fixture is run through the SUPERSEDED form too, so it is shown to
     * discriminate rather than merely to pass.
     */

    it('the fence match is whole-string (`[[ =~ ]]`), not the line-by-line `grep -qE` it replaced', () => {
      expect(NEW_BLOCK).toContain('[[ $f =~ $FENCE ]]')
      expect(NEW_BLOCK).not.toContain('grep -qE "$FENCE"')
    })

    /** An OUT-of-fence path whose name contains a newline, one line of which looks in-fence. */
    function fixtureWithNewlineInName(): string {
      const dir = scratchDir('fence-newline')
      initRepo(dir)
      mkdirSync(join(dir, 'src', 'foo'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo', 'plain.ts'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      const hostile = join(dir, 'evil/a\nsrc/foo/b.ts')
      mkdirSync(dirname(hostile), { recursive: true })
      writeFileSync(hostile, 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'add an OUT-OF-FENCE file whose name contains a newline')
      return dir
    }

    it('EXECUTED — the per-file `grep -qE` form ADMITS an out-of-fence name containing an in-fence-looking line', () => {
      const dir = fixtureWithNewlineInName()
      const GREP_BLOCK =
        'viol=()\n' +
        "while IFS= read -r -d '' f; do\n" +
        '  printf \'%s\' "$f" | grep -qE "$FENCE" || viol+=("$f")\n' +
        'done < <(git diff -z main...HEAD --name-only)\n' +
        '[ "${#viol[@]}" -gt 0 ] && { echo "VERDICT: fence violated"; fail "fence violated"; }\n' +
        'echo "VERDICT: fence OK"\n'
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + `cd "$W"\n` + GREP_BLOCK
      const res = runFragment(script, dir)
      // grep matches LINE BY LINE, so the "src/foo/b.ts" line of the NAME matches
      // the fence and the file is waved through — a fail-OPEN fence bypass.
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: fence OK')
    })

    it('EXECUTED — the real, extracted form HOLDS that same out-of-fence name', () => {
      const dir = fixtureWithNewlineInName()
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('fence violated')
    })

    it('the fence-OK line survives an empty array under `set -u` (bash < 4.4 — /bin/bash on macOS is 3.2)', () => {
      // extractLine, not NEW_BLOCK: the block also carries the comment that
      // explains this fix, and that comment quotes the literal — asserting over
      // the whole block would pass with the CODE reverted. EXECUTED: it did.
      expect(extractLine('echo "  fence OK: ${DIFF_FILES')).toContain('${DIFF_FILES[*]-}')
    })

    it.skipIf(SYSTEM_BASH_GUARDS_EMPTY_ARRAYS)(
      `EXECUTED — a branch with an empty diff prints "fence OK" and exits 0, rather than aborting past fail() (skipped: /bin/bash here is ${SYSTEM_BASH_MAJOR}.x, and empty-array expansion under \`set -u\` stopped being an error in 4.4, so this fragment cannot fail for the reason it claims — it is a proof only on bash < 4.4, which is what macOS ships)`,
      () => {
      const dir = scratchDir('fence-emptydiff')
      initRepo(dir)
      mkdirSync(join(dir, 'src', 'foo'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo', 'plain.ts'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + NEW_BLOCK + '\n'
      // `/bin/bash`, not PATH's bash: gate.sh's own shebang, and the only
      // interpreter whose empty-array behaviour can hold a real landing.
      const res = runFragment(script, dir, '/bin/bash')
      // Without the `-` default this aborts "DIFF_FILES[*]: unbound variable" on
      // bash 3.2 WITHOUT reaching fail() — no "GATE FAILED", no ">>> HOLDING" —
      // on the very path :142 has a dedicated diagnosis for.
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('fence OK')
      expect(res.stderr).not.toContain('unbound variable')
    })


    /**
     * The pair below is the half this describe was missing, and its absence was
     * found by reverting #71 wholesale and watching this file stay green: the
     * four tests above pin the rc separation and plain-ASCII paths, so both of
     * #71's central edits could be undone without a single assertion moving.
     * The NUL-guard describe below already carries both halves for the same
     * shape — a text assertion AND a real café.ts fixture — and #71 reused that
     * shape here deliberately (`gate.sh:79`). This makes the standard the same
     * on both sides of the file.
     */
    function fixtureWithNonAsciiInFenceName(): string {
      const dir = scratchDir('fence-nonascii')
      initRepo(dir)
      mkdirSync(join(dir, 'src', 'foo'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo', 'plain.ts'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'src', 'foo', 'caf\u00e9.ts'), 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'add an IN-FENCE file with a non-ASCII name')
      return dir
    }

    it('EXECUTED — the OLD (line-delimited) form convicts an IN-FENCE caf\u00e9.ts, because git quotes the name', () => {
      const dir = fixtureWithNonAsciiInFenceName()
      const OLD_BLOCK =
        'viol=$(git diff main...HEAD --name-only | grep -vE "$FENCE" || true)\n' +
        '[ -n "$viol" ] && { echo "VERDICT: fence violated"; fail "fence violated"; }\n' +
        'echo "VERDICT: fence OK"\n'
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + `cd "$W"\n` + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('fence violated')
    })

    it('EXECUTED — the NEW (real, extracted) form passes that same IN-FENCE caf\u00e9.ts', () => {
      const dir = fixtureWithNonAsciiInFenceName()
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('fence OK')
    })

    function fixture(): string {
      const dir = scratchDir('fence')
      initRepo(dir)
      mkdirSync(join(dir, 'src', 'foo'), { recursive: true })
      mkdirSync(join(dir, 'src', 'bar'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo', 'allowed.ts'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'src', 'bar', 'outside.ts'), 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'add outside-fence file')
      return dir
    }

    it('EXECUTED — the OLD form prints "fence OK" (exit 0) when FENCE is an invalid regex, with an out-of-fence file present', () => {
      const dir = fixture()
      const OLD_BLOCK = 'viol=$(git diff main...HEAD --name-only | grep -vE "$FENCE" || true)\n' + '[ -n "$viol" ] && { echo "VERDICT: fence violated"; fail "fence violated"; }\n' + 'echo "VERDICT: fence OK"\n'
      const script = preludeScript(0, 'FENCE=\'[\'\nW=.\n') + `cd "$W"\n` + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: fence OK')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS when FENCE is an invalid regex, same fixture', () => {
      const dir = fixture()
      const script = preludeScript(0, 'FENCE=\'[\'\nW=.\n') + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('GATE FAILED')
      expect(res.stdout + res.stderr).toContain("fence regex '[' is invalid")
    })

    it('EXECUTED — the NEW form still holds on a REAL violation with a valid regex (not just on regex errors)', () => {
      const dir = fixture()
      const script = preludeScript(0, "FENCE='^src/foo/'\nW=.\n") + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('fence violated')
    })

    it('EXECUTED — the NEW form prints "fence OK" and exits 0 on a genuinely clean tree — not vacuously always-holding', () => {
      const dir = fixture()
      const script = preludeScript(0, "FENCE='^src/'\nW=.\n") + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('fence OK')
    })
  })

  describe(':89 git status — a failed `git status` holds, it does not print "worktree clean"', () => {
    const NEW_BLOCK = sliceLines('STATUS_OUT=$(git -C "$W" status --porcelain)', 'uncommitted work stranded in the worktree')

    it('the fix checks git status\'s own exit code before trusting the dirty count', () => {
      expect(NEW_BLOCK).toContain('STATUS_RC=$?')
      expect(NEW_BLOCK).toContain('git status failed')
    })

    function corruptRepo(): string {
      const dir = scratchDir('status')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      execFileSync('mv', [join(dir, '.git', 'HEAD'), join(dir, '.git', 'HEAD.bak')])
      return dir
    }

    it('EXECUTED — the OLD form reports "worktree clean" (exit 0) when git status itself fails', () => {
      const dir = corruptRepo()
      const OLD_BLOCK = 'dirty=$(git status --porcelain | grep -v package-lock.json | wc -l)\n' + '[ "$dirty" -ne 0 ] && fail "uncommitted work stranded in the worktree"\n' + 'echo "VERDICT: worktree clean"\n'
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: worktree clean')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS when git status fails, same corrupted repo', () => {
      const dir = corruptRepo()
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('git status failed')
    })

    it('EXECUTED — the NEW form is silent (no fail) on a genuinely clean, working repo', () => {
      const dir = scratchDir('status-clean')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      const script = preludeScript(0, 'W=.\n') + `cd "$W"\n` + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
    })
  })

  describe(":116 NUL guard — a quoted/hostile filename is checked, and the file-list producer's own failure holds", () => {
    const NEW_BLOCK = sliceLines('NUL_LIST=$(mktemp "/tmp/gate-nul-list-$H.XXXXXX")', 'no NUL bytes (text files; binary assets exempt)')

    it('the fix reads a NUL-delimited listing via -z / read -r -d \'\', not line-delimited `read -r`', () => {
      expect(NEW_BLOCK).toContain('diff -z main...HEAD --name-only')
      expect(NEW_BLOCK).toContain("read -r -d ''")
    })

    function fixtureWithNulFile(): string {
      const dir = scratchDir('nul')
      initRepo(dir)
      writeFileSync(join(dir, 'clean.ts'), 'clean\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'café.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x00, 0x00, 0x0a]))
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'add file with NUL bytes')
      return dir
    }

    it('EXECUTED — the OLD (line-delimited) form reports "no NUL bytes" (exit 0) for a café.ts carrying 2 NUL bytes', () => {
      const dir = fixtureWithNulFile()
      const OLD_BLOCK =
        'while read -r f; do\n' +
        '  [ -f "$W/$f" ] || continue\n' +
        '  c=$(python3 -c "import sys;print(open(sys.argv[1],\'rb\').read().count(b\'\\x00\'))" "$W/$f") || fail "$f unreadable"\n' +
        '  [ "$c" != "0" ] && fail "$f contains $c NUL byte(s)"\n' +
        'done < <(git -C "$W" diff main...HEAD --name-only)\n' +
        'echo "VERDICT: no NUL bytes"\n'
      const script = preludeScript(0, 'W=.\n') + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: no NUL bytes')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS on the same café.ts, naming the NUL count', () => {
      const dir = fixtureWithNulFile()
      const script = preludeScript(0, 'W=.\n') + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('café.ts contains 2 NUL byte(s)')
    })

    it('EXECUTED — the NEW form holds when the file-listing producer itself fails (corrupted repo)', () => {
      const dir = scratchDir('nul-producer')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      execFileSync('mv', [join(dir, '.git', 'HEAD'), join(dir, '.git', 'HEAD.bak')])
      const script = preludeScript(0, 'W=.\n') + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('git diff (file listing) failed')
    })

    it('EXECUTED — the NEW form passes clean on a tree with only exempt binary and ordinary text files', () => {
      const dir = scratchDir('nul-clean')
      initRepo(dir)
      writeFileSync(join(dir, 'ok.txt'), 'fine\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'more.txt'), 'still fine\n')
      writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'add clean text + exempt binary')
      const script = preludeScript(0, 'W=.\n') + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('no NUL bytes')
    })

    /**
     * A verification pass found that the ORIGINAL fix for this guard
     * (`NUL_LIST="/tmp/gate-nul-list-$H"`, a predictable path) introduced a
     * NEW vulnerability: `>` follows a pre-existing symlink at a guessable
     * name, so a local attacker (or another lane using the same handle) can
     * plant one and have this guard's `>` silently overwrite whatever it
     * points at. `mktemp` closes it — not by dodging one guessed name, but
     * by never writing to a name anyone could have guessed in the first
     * place.
     *
     * A SECOND verification pass found this fixture had the exact defect
     * shape it was written to demonstrate: `/tmp/gate-nul-list-t42` is
     * itself a single fixed path in a world-writable directory. Fixing
     * round 1's self-enrollment (the earlier KNOWN GAP needle) meant this
     * law is no longer excluded from gate.sh's own timing set — and the
     * timing set is precisely what gate.sh's load gate runs OUTSIDE the 4x
     * concurrent batches (:240-243 exclude it; :245 runs everything else 4x
     * concurrently). So this file's tests now run 4-at-once under load, and
     * four concurrent unlink/symlink dances on ONE global name are a race:
     * EXECUTED, four concurrent runs read 3 of 4 red on the exact test
     * below, a control law with no shared path read 0/4 red across the same
     * four rounds. A `t42`-only handle was never going to be safe here —
     * the fix is a name unique per OS process, not per test run.
     */
    const H = `t42-p${process.pid}`
    const OLD_STATIC_NUL_LIST_PATH = `/tmp/gate-nul-list-${H}`

    it('EXECUTED — the OLD static /tmp path IS followed by `>` through a pre-existing symlink, corrupting its target', () => {
      const dir = scratchDir('nul-symlink-old')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      const victim = join(dir, 'victim.txt')
      const victimContent = 'x'.repeat(480)
      writeFileSync(victim, victimContent)
      try {
        unlinkSync(OLD_STATIC_NUL_LIST_PATH)
      } catch {
        /* did not exist */
      }
      symlinkSync(victim, OLD_STATIC_NUL_LIST_PATH)
      try {
        execFileSync('bash', ['-c', `git -C "${dir}" diff -z main...HEAD --name-only >"${OLD_STATIC_NUL_LIST_PATH}"`])
        const after = readFileSync(victim, 'utf8')
        expect(after).not.toBe(victimContent)
        expect(after.length).toBeLessThan(victimContent.length)
      } finally {
        unlinkSync(OLD_STATIC_NUL_LIST_PATH)
      }
    })

    it('EXECUTED — the NEW (real, extracted, mktemp-based) form leaves a symlink at the OLD static name completely untouched', () => {
      const dir = scratchDir('nul-symlink-new')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      const victim = join(dir, 'victim.txt')
      const victimContent = 'x'.repeat(480)
      writeFileSync(victim, victimContent)
      try {
        unlinkSync(OLD_STATIC_NUL_LIST_PATH)
      } catch {
        /* did not exist */
      }
      symlinkSync(victim, OLD_STATIC_NUL_LIST_PATH)
      try {
        const script = preludeScript(0, `H=${H}\nW=.\n`) + NEW_BLOCK + '\necho DONE\n'
        const res = runFragment(script, dir)
        expect(res.status).toBe(0)
        expect(res.stdout).toContain('DONE')
        expect(readFileSync(victim, 'utf8')).toBe(victimContent)
      } finally {
        unlinkSync(OLD_STATIC_NUL_LIST_PATH)
      }
    })
  })

  describe(':56 git-dir probe — a failed probe holds; it no longer falls back to a path that cannot detect a rebase', () => {
    const NEW_BLOCK = sliceLines('GITDIR_LOG=$(mktemp "/tmp/gate-gitdir-$H.XXXXXX")', 'worktree is mid-rebase (conflict) — resolve on the branch first')

    it('the old blind fallback ( || echo "$W/.git" ) is gone from the file', () => {
      expect(SOURCE).not.toMatch(/rev-parse --absolute-git-dir 2>\/dev\/null \|\| echo "\$W\/\.git"/)
    })

    it('the probe writes stderr to an unpredictable mktemp path, not a guessable "/tmp/gate-gitdir-$H.log"', () => {
      expect(NEW_BLOCK).toContain('mktemp "/tmp/gate-gitdir-$H.XXXXXX"')
      expect(SOURCE).not.toContain('2>/tmp/gate-gitdir-$H.log')
    })

    it('the fix routes a probe failure through fail(), naming the log it wrote', () => {
      expect(NEW_BLOCK).toContain('fail "cannot resolve the real git dir')
    })

    function midRebaseWorktree(): { main: string; wt: string } {
      const main = scratchDir('rebase-main')
      initRepo(main)
      writeFileSync(join(main, 'f.txt'), 'a\n')
      git(main, 'add', '-A')
      git(main, 'commit', '-q', '-m', 'init')
      writeFileSync(join(main, 'f.txt'), 'a\nb\n')
      git(main, 'add', '-A')
      git(main, 'commit', '-q', '-m', 'main moves f.txt')
      git(main, 'checkout', '-q', '-b', 'feature', 'HEAD~1')
      writeFileSync(join(main, 'f.txt'), 'a\nc\n')
      git(main, 'add', '-A')
      git(main, 'commit', '-q', '-m', 'feature moves f.txt differently')
      const wt = join(main, '..', `${main.split('/').pop()}-wt`)
      git(main, 'worktree', 'add', '-q', '-b', 'feature-wt', wt, 'feature')
      SCRATCH_DIRS.push(wt)
      try {
        execFileSync('git', ['rebase', 'main'], { cwd: wt })
      } catch {
        /* expected: rebase conflicts, leaving the worktree mid-rebase */
      }
      return { main, wt }
    }

    it("EXECUTED — the OLD fallback ($W/.git) MISSES a real, live mid-rebase — the exact defect the PRD's evidence names", () => {
      const { wt } = midRebaseWorktree()
      const OLD_BLOCK = 'GD="$W/.git"\n' + '{ [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ]; } && fail "worktree is mid-rebase"\n' + 'echo "VERDICT: not mid-rebase"\n'
      const script = preludeScript(0, 'W=.\n') + OLD_BLOCK
      const res = runFragment(script, wt)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: not mid-rebase')
    })

    it('EXECUTED — the NEW (real, extracted) resolution DETECTS the same live mid-rebase', () => {
      const { wt } = midRebaseWorktree()
      const script = preludeScript(0, 'W=.\n') + NEW_BLOCK + '\necho "VERDICT: not mid-rebase"\n'
      const res = runFragment(script, wt)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('worktree is mid-rebase')
    })

    it('EXECUTED — the NEW form holds (rather than silently proceeding) when the probe itself cannot resolve a git dir', () => {
      const dir = scratchDir('gitdir-broken')
      initRepo(dir)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      // A worktree whose .git pointer file names a git-dir that does not exist.
      const worktreeDir = scratchDir('gitdir-broken-wt')
      writeFileSync(join(worktreeDir, '.git'), 'gitdir: /this/path/does/not/exist\n')
      const script = preludeScript(0, `W=${worktreeDir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('cannot resolve the real git dir')
    })
  })

  describe(':73 rebase-ancestry check — a corrupt ref is told apart from an honest "not an ancestor"', () => {
    /**
     * `git merge-base --is-ancestor` returns 1 for the ordinary "not an
     * ancestor" and 128 for a bad object (a missing/corrupt ref). The OLD
     * form discarded stderr and routed both through the same `|| fail`, so
     * an operator whose ref was corrupt was told "the rebase did not take"
     * — a verdict about the rebase this line never established. The NEW
     * form captures stderr and branches on the exit code instead.
     */
    const NEW_BLOCK = sliceLines('ANCESTOR_ERR=$(git -C "$W" merge-base --is-ancestor main HEAD 2>&1 >/dev/null)', 'a ref may be corrupt (see stderr above)', 1)

    it('the old undifferentiated form (stderr discarded, both exit codes routed through one fail) is gone from the file', () => {
      expect(SOURCE).not.toMatch(/merge-base --is-ancestor main HEAD 2>\/dev\/null \|\| fail/)
      expect(NEW_BLOCK).toContain('ANCESTOR_RC')
    })

    function repoOn(branch: string): string {
      const dir = scratchDir('ancestry')
      initRepo(dir)
      git(dir, 'checkout', '-q', '-b', branch)
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      return dir
    }

    it('EXECUTED — the honest case (branch not on top of main) still holds with the ORIGINAL message', () => {
      const dir = repoOn('main')
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'a.txt'), 'a\nfeature\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'feature work')
      // main moves ahead too, so feature is genuinely not an ancestor of it —
      // exit 1, the ordinary case — rather than the trivial "no divergence".
      git(dir, 'checkout', '-q', 'main')
      writeFileSync(join(dir, 'a.txt'), 'a\nmain\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'main moves too')
      git(dir, 'checkout', '-q', 'feature')
      const script = preludeScript(0, 'BRANCH=feature\nW=.\n') + NEW_BLOCK + '\necho "VERDICT: on top of main"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('branch feature is not on top of main (the rebase did not take)')
      expect(res.stdout + res.stderr).not.toContain('exited 128')
    })

    it('EXECUTED — a corrupt/missing ref (128, not the ordinary 1) is reported as its own thing, not as "the rebase did not take"', () => {
      // No branch named "main" exists at all here — the same shape a
      // corrupt or unpushed ref produces: --is-ancestor cannot resolve the
      // name and exits 128, distinct from the ordinary "not an ancestor" 1.
      const dir = repoOn('trunk')
      const script = preludeScript(0, 'BRANCH=trunk\nW=.\n') + NEW_BLOCK + '\necho "VERDICT: on top of main"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      const out = res.stdout + res.stderr
      expect(out).toContain('exited 128')
      expect(out).not.toContain('the rebase did not take')
      // stderr from the failed git call is surfaced, not swallowed.
      expect(out).toMatch(/Not a valid object name|fatal:/)
    })

    it('EXECUTED — the honest case still passes when the branch genuinely IS on top of main (no false hold)', () => {
      const dir = repoOn('main')
      const script = preludeScript(0, 'BRANCH=main\nW=.\n') + NEW_BLOCK + '\necho "VERDICT: on top of main"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: on top of main')
    })
  })

  describe(':190 timing-count ratchet — a corrupt or oversized count holds, it does not coerce to 0 or silently proceed', () => {
    const NEW_BLOCK = sliceLines('TIMINGCOUNT_LOG=$(mktemp "/tmp/gate-timingcount-$H.XXXXXX")', 'a timing test silently fell out (if this is deliberate, a human clears $COUNT_FILE)')

    it('the old silent coercion ( PREV=0 on empty/non-numeric ) is gone from the file', () => {
      expect(SOURCE).not.toMatch(/case "\$PREV" in \('' \| \*\[!0-9\]\*\) PREV=0/)
    })

    it('the fix holds on a non-numeric count instead of defaulting it to 0', () => {
      expect(NEW_BLOCK).toContain('not a whole number')
    })

    it('EXECUTED — the OLD form silently coerces a corrupt count to 0 and lets the ratchet pass', () => {
      const dir = scratchDir('timing-old')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), 'garbage-not-a-number\n')
      const OLD_BLOCK =
        'PREV=$(cat "$COUNT_FILE" 2>/dev/null)\n' + "case \"$PREV\" in ('' | *[!0-9]*) PREV=0 ;; esac\n" + '[ "$TCOUNT" -lt "$PREV" ] && fail "shrink"\n' + 'echo "VERDICT: ratchet passes, PREV=$PREV"\n'
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ratchet passes, PREV=0')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS on the same corrupt count', () => {
      const dir = scratchDir('timing-new')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), 'garbage-not-a-number\n')
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('not a whole number')
    })

    it('EXECUTED — the NEW form still holds on a REAL shrink with a well-formed count (not just on corruption)', () => {
      const dir = scratchDir('timing-shrink')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), '10\n')
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('fewer than the 10 last recorded')
    })

    it('EXECUTED — the NEW form is silent when the count is well-formed and has not shrunk', () => {
      const dir = scratchDir('timing-ok')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), '3\n')
      const script = preludeScript(0, `TCOUNT=5\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
    })

    /**
     * A verification pass found that the round-1 fix above rejects
     * non-digit corruption but nothing bounds the MAGNITUDE: a 20-digit,
     * all-digit value passes the `case` guard and then breaks the
     * comparison itself — bash's `[ -lt ]` errors "integer expected" (5.3+;
     * "integer expression expected" on 5.2 and earlier, which is why the
     * assertion below matches both) at
     * exit code 2 (EXECUTED, verified below), and a bare `&&` never
     * distinguishes that from ordinary "false" (exit 1), so the ratchet
     * silently proceeds instead of holding. Exactly prd-45's thesis,
     * reproduced inside the fix meant to close it.
     */
    it('EXECUTED — bash\'s own `[ -lt ]` errors (exit 2, not 0/1) on an all-digit but oversized value', () => {
      const res = runFragment(`#!/bin/bash\nset -uo pipefail\n[ 3 -lt 99999999999999999999 ]\necho "rc=$?"\n`, scratchDir('timing-oversized-probe'))
      expect(res.status).toBe(0) // the script's own last command is `echo`, which always succeeds...
      expect(res.stdout).toContain('rc=2') // ...but the comparison it captured errored at exit 2, not 0 (true) or 1 (false)
    })

    it('EXECUTED — the ROUND-1 fix (case guard only, no range check) silently PROCEEDS on an oversized count instead of holding', () => {
      const dir = scratchDir('timing-oversized-old')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), '99999999999999999999\n')
      const ROUND1_BLOCK =
        'PREV=$(cat "$COUNT_FILE" 2>/dev/null)\n' +
        'case "$PREV" in\n' +
        "  ('' | *[!0-9]*) fail \"not a whole number\" ;;\n" +
        'esac\n' +
        '[ "$TCOUNT" -lt "$PREV" ] && fail "shrink"\n' +
        'echo "VERDICT: ratchet passes"\n'
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + ROUND1_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: ratchet passes')
    })

    it('EXECUTED — the CURRENT (real, extracted) form HOLDS on the same oversized count, naming it rather than silently proceeding', () => {
      const dir = scratchDir('timing-oversized-new')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'timing-count'), '99999999999999999999\n')
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('too large to compare')
    })
  })

  /**
   * #48 — a rise in the timing-set count used to be invisible: only a DROP
   * (`:227`, unchanged above) ever reached fail(), and any count, including
   * a risen one, was written to the floor unconditionally (`:264`). #42's
   * own commit then enrolled ITSELF this way (its new law's tolerance needle
   * spelled the marker text as prose — see the `KNOWN GAP` entry above),
   * caught only by an external review seat. This law extracts and runs the
   * REAL rise-handling gate.sh now carries, not a re-typed stand-in.
   *
   * A rise is deliberately NOT a fail(): #42's own near-miss shows a
   * legitimate addition can raise the count, and hard-failing every rise is
   * the kind of check that gets suppressed within a week (the issue's own
   * words). So the fix REPORTS a rise — distinguishing it from a steady
   * count — right next to the write that turns it into the new floor
   * (`:266`), rather than failing the landing outright. RISE_TOLERANCE is
   * asserted to be a named, declared variable (ruling 3), not a magic number
   * folded into the comparison it feeds.
   */
  describe(':187-232 timing-count rise — a RISE is reported (never silently absorbed into the floor), distinct from a HOLD, and a DROP still fails', () => {
    const RATCHET_BLOCK = sliceLines('RISE_TOLERANCE=', "the file is .gitignore'd and per-machine, #48)", 1)
    const REPORT_LINE = extractLine('timing-count ratchet:$RISE_NOTE')
    const DISCOVERY_AND_COUNT_BLOCK = sliceLines('TIMING_FILES=()', 'TCOUNT=${#TIMING_FILES[@]}')

    /**
     * The four rise fixtures below (the plain rise, the canonical
     * no-leading-zero rise, and both near-miss reproductions) used to
     * hardcode a delta of 1 (or, for the plain rise, a delta of 2 that
     * happened to survive only tolerances of 0 and 1) and assume
     * RISE_TOLERANCE=0, so raising the tolerance turned at least one of
     * them red with a diff naming neither the tolerance nor the change —
     * the exact defect this issue exists to close. A verification pass
     * found the plain-rise fixture specifically: EXECUTED at
     * RISE_TOLERANCE=2 it reddened with "expected 'RISE_NOTE=[]' to
     * contain 'ROSE from 5 to 7'". They now parse the real value out of
     * SOURCE and derive RISE_DELTA (the smallest delta guaranteed to rise
     * whatever the tolerance is) from it, so a raised tolerance moves their
     * expected numbers instead of reddening them silently. The plain-rise
     * fixture additionally sweeps RISE_TOLERANCE 0/1/2 directly (not just
     * whatever value happens to be committed in gate.sh right now), via
     * `ratchetBlockWithTolerance` substituting the literal value inside the
     * real, extracted RATCHET_BLOCK text rather than a re-typed stand-in.
     */
    const RISE_TOLERANCE = (() => {
      const m = SOURCE.match(/^\s*RISE_TOLERANCE=(\d+)\s*$/m)
      if (!m) throw new Error(`cannot find a bare RISE_TOLERANCE=<n> assignment in ${GATE_PATH} — the rise fixtures below derive their expected delta from this value`)
      return Number(m[1])
    })()
    const RISE_DELTA = RISE_TOLERANCE + 1

    /** RATCHET_BLOCK with its own `RISE_TOLERANCE=<n>` line's value swapped for `n` — the real extracted block, still, just at a tolerance other than whatever is currently committed. Throws rather than silently no-op'ing if the real block's shape ever stops matching the substitution regex. */
    function ratchetBlockWithTolerance(n: number): string {
      const replaced = RATCHET_BLOCK.replace(/^(\s*RISE_TOLERANCE=)\d+\s*$/m, `$1${n}`)
      if (replaced === RATCHET_BLOCK && n !== RISE_TOLERANCE) {
        throw new Error('could not substitute RISE_TOLERANCE inside RATCHET_BLOCK — the sliced text no longer contains a bare RISE_TOLERANCE=<n> line')
      }
      return replaced
    }

    it('the tolerance is a named, declared variable — not a magic number folded into the -gt condition it feeds', () => {
      // Anchored on the ASSIGNMENT, not a pinned value: a verification pass
      // found `toContain('RISE_TOLERANCE=0')` reddened at COLLECTION the
      // moment a human raised the tolerance past 0, with a failure naming
      // neither the tolerance nor the variable. 'RISE_TOLERANCE=' no longer
      // breaks collection when the value changes (still matches exactly one
      // line — the comment above it says "RISE_TOLERANCE is", no `=`; the
      // comparison below reads `"$RISE_TOLERANCE"`, no `=` either).
      expect(SOURCE).toContain('RISE_TOLERANCE=')
      expect(RATCHET_BLOCK).toContain('"$RISE_TOLERANCE"')
    })

    it('EXECUTED — a genuine DROP still fails, unchanged: the rise logic added here does not touch #42\'s shrink check', () => {
      const dir = scratchDir('rise-drop')
      writeFileSync(join(dir, 'timing-count'), '10\n')
      const script = preludeScript(0, `TCOUNT=3\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('fewer than the 10 last recorded')
    })

    it('EXECUTED — a count that HOLDS STEADY sets no rise note and does not fail', () => {
      const dir = scratchDir('rise-steady')
      writeFileSync(join(dir, 'timing-count'), '5\n')
      const script = preludeScript(0, `TCOUNT=5\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('RISE_NOTE=[]')
    })

    it.each([0, 1, 2])('EXECUTED — a count that RISES is distinguished from a hold at RISE_TOLERANCE=%d: RISE_NOTE names old and new counts, and the gate does not fail', (tolerance) => {
      const dir = scratchDir(`rise-up-tol${tolerance}`)
      const prev = 5
      const tcount = prev + tolerance + 1 // smallest delta guaranteed to rise at THIS tolerance
      writeFileSync(join(dir, 'timing-count'), `${prev}\n`)
      const script = preludeScript(0, `TCOUNT=${tcount}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + ratchetBlockWithTolerance(tolerance) + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`ROSE from ${prev} to ${tcount}`)
    })

    it('EXECUTED — a FIRST RUN (no prior timing-count file) is reported as establishing the floor, not silently adopted', () => {
      const dir = scratchDir('rise-first')
      mkdirSync(dir, { recursive: true })
      const script = preludeScript(0, `TCOUNT=6\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ESTABLISHES it at 6')
    })

    /**
     * #42 hardened the ONE arithmetic consumer of $PREV that existed before
     * this issue — `[ "$TCOUNT" -lt "$PREV" ]` (the `test` builtin, which
     * reads a leading zero as plain decimal; EXECUTED below, unaffected).
     * `:187-232`'s rise check adds a SECOND consumer, `$((TCOUNT - PREV))`
     * (bash arithmetic expansion), which reads a leading zero as an OCTAL
     * prefix — a different rule, and the case guard above only rejected
     * non-digit corruption, not this. A verification pass found the case
     * guard alone lets a leading-zero PREV straight through to that second
     * consumer, with a failure mode `-lt` itself never has: '08' is not
     * even valid octal (bash errors "value too great for base" and the
     * REAL rise it hides is silently absorbed — no report, no fail()), and
     * '010' IS valid octal (8), so an honest hold at 10 misreports as a
     * rise from 8. The new leading-zero case arm (:216) holds on both
     * before the arithmetic ever runs.
     */
    it('EXECUTED — the OLD (case-guard-only) arithmetic silently ABSORBS a real rise spelled with a leading zero (08 -> 9)', () => {
      const dir = scratchDir('rise-octal-old-absorb')
      writeFileSync(join(dir, 'timing-count'), '08\n')
      const OLD_BLOCK =
        'exec 2>&1\n' + // merge stderr into the captured stdout, so the arithmetic error below is visible to the assertion
        'PREV=$(cat "$COUNT_FILE")\n' +
        "case \"$PREV\" in ('' | *[!0-9]*) fail \"not a whole number\" ;; esac\n" +
        '[ "$TCOUNT" -lt "$PREV" ]\n' +
        'CMP_RC=$?\n' +
        '[ "$CMP_RC" -gt 1 ] && fail "cannot compare"\n' +
        '[ "$CMP_RC" -eq 0 ] && fail "shrink"\n' +
        'RISE_NOTE=""\n' +
        '[ "$((TCOUNT - PREV))" -gt "$RISE_TOLERANCE" ] && RISE_NOTE=" ROSE from $PREV to $TCOUNT"\n' +
        'echo "VERDICT: RISE_NOTE=[$RISE_NOTE]"\n'
      const script = preludeScript(0, `TCOUNT=9\nRISE_TOLERANCE=0\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('value too great for base')
      expect(res.stdout).toContain('VERDICT: RISE_NOTE=[]')
    })

    it("EXECUTED — the OLD (case-guard-only) arithmetic FALSELY reports a rise on an honest hold spelled with a leading zero (010 == 10)", () => {
      const dir = scratchDir('rise-octal-old-false')
      writeFileSync(join(dir, 'timing-count'), '010\n')
      const OLD_BLOCK =
        'PREV=$(cat "$COUNT_FILE")\n' +
        "case \"$PREV\" in ('' | *[!0-9]*) fail \"not a whole number\" ;; esac\n" +
        '[ "$TCOUNT" -lt "$PREV" ]\n' +
        'CMP_RC=$?\n' +
        '[ "$CMP_RC" -gt 1 ] && fail "cannot compare"\n' +
        '[ "$CMP_RC" -eq 0 ] && fail "shrink"\n' +
        'RISE_NOTE=""\n' +
        '[ "$((TCOUNT - PREV))" -gt "$RISE_TOLERANCE" ] && RISE_NOTE=" ROSE from $PREV to $TCOUNT"\n' +
        'echo "VERDICT: RISE_NOTE=[$RISE_NOTE]"\n'
      const script = preludeScript(0, `TCOUNT=10\nRISE_TOLERANCE=0\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: RISE_NOTE=[ ROSE from 010 to 10]')
    })

    it("EXECUTED — the NEW (real, extracted) ratchet HOLDS on the absorbed-rise spelling (08), before the arithmetic ever runs", () => {
      const dir = scratchDir('rise-octal-new-absorb')
      writeFileSync(join(dir, 'timing-count'), '08\n')
      const script = preludeScript(0, `TCOUNT=9\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('non-canonical leading-zero')
    })

    it("EXECUTED — the NEW (real, extracted) ratchet HOLDS on the false-rise spelling (010), rather than misreporting a rise", () => {
      const dir = scratchDir('rise-octal-new-false')
      writeFileSync(join(dir, 'timing-count'), '010\n')
      const script = preludeScript(0, `TCOUNT=10\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('non-canonical leading-zero')
    })

    it('EXECUTED — the NEW ratchet still reports a CANONICAL rise correctly (no leading zero) — the guard does not overreach', () => {
      const dir = scratchDir('rise-octal-new-canonical')
      const prev = 8
      const tcount = prev + RISE_DELTA // smallest delta guaranteed to rise, whatever RISE_TOLERANCE is
      writeFileSync(join(dir, 'timing-count'), `${prev}\n`)
      const script = preludeScript(0, `TCOUNT=${tcount}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`ROSE from ${prev} to ${tcount}`)
    })

    it("EXECUTED — bash's `test` builtin (the comparison #42 hardened) reads a leading zero as DECIMAL, unlike arithmetic expansion — the two consumers disagree", () => {
      const res = runFragment(`#!/bin/bash\nset -uo pipefail\n[ 9 -lt 08 ]\necho "rc=$?"\n`, scratchDir('octal-test-builtin-probe'))
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('rc=1') // 9 is NOT less than 8 (decimal) — test builtin agrees with decimal, unlike $(( ))
    })

    it('EXECUTED — the report line (reused verbatim from gate.sh) prints only when a note is actually set', () => {
      const res1 = runFragment(preludeScript(0, 'RISE_NOTE=""\n') + REPORT_LINE + '\necho DONE\n', scratchDir('report-empty'))
      expect(res1.status).toBe(0)
      expect(res1.stdout).not.toContain('ratchet:')
      expect(res1.stdout).toContain('DONE')

      const res2 = runFragment(preludeScript(0, 'RISE_NOTE=" ROSE from 5 to 7"\n') + REPORT_LINE + '\necho DONE\n', scratchDir('report-set'))
      expect(res2.status).toBe(0)
      expect(res2.stdout).toContain('timing-count ratchet: ROSE from 5 to 7')
    })

    /**
     * The write and the claim about it used to be two separate statements
     * with no dependency between them: `:264` writes $COUNT_FILE and never
     * checks its own exit status; the report line right after it (`:266`,
     * printing RISE_NOTE's "becomes the new floor" / "ESTABLISHES it") ran
     * regardless. A verification pass (chmod 444 on the floor file) showed
     * the exact failure this shape produces: the write silently no-ops
     * (permission denied on stderr only), the floor stays at its old value,
     * and the SAME claim prints anyway — a verdict the gate did not earn,
     * prd-45's own thesis. The fix ties the report to the write with `||
     * fail()`, the same shape the sibling `:293 lane manifest prune` describe
     * below already holds `scripts/gate.sh` to.
     *
     * The two proofs below no longer make the floor unwritable with `chmod
     * 0444` (#74): `CAP_DAC_OVERRIDE` lets root ignore that bit, so as root
     * the write would silently succeed and both would go red for a reason
     * neither claims. Instead a plain FILE sits where the floor's parent
     * directory is expected, so the write fails with ENOTDIR — a structural
     * impossibility no privilege level bypasses. Verified both ways: as the
     * invoking user, and under `unshare -r` (mapped uid 0, on a machine with
     * `kernel.apparmor_restrict_unprivileged_userns=0`) — exit 1 either way.
     */
    const WRITE_BLOCK = sliceLines('mkdir -p "$root/.swarm" && printf', 'timing-count ratchet:$RISE_NOTE')

    it('EXECUTED — a WRITABLE floor: the write lands and the claimed report follows it', () => {
      const dir = scratchDir('write-ok')
      const script = preludeScript(0, `root=${dir}\nTCOUNT=7\nCOUNT_FILE=${join(dir, '.swarm', 'timing-count')}\nRISE_NOTE=" ROSE from 5 to 7"\n`) + WRITE_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('timing-count ratchet: ROSE from 5 to 7')
      expect(readFileSync(join(dir, '.swarm', 'timing-count'), 'utf8')).toBe('7\n')
    })

    it('EXECUTED — an UNWRITABLE floor HOLDS: fail() fires, the floor is never created, and the unearned claim is never printed', () => {
      const dir = scratchDir('write-readonly')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const obstruction = join(dir, '.swarm', 'timing-count')
      writeFileSync(obstruction, 'not a directory\n')
      const countFile = join(obstruction, 'floor')
      const script = preludeScript(0, `root=${dir}\nTCOUNT=7\nCOUNT_FILE=${countFile}\nRISE_NOTE=" ROSE from 5 to 7"\n`) + WRITE_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('cannot write the timing-count floor')
      expect(res.stdout + res.stderr).toContain('HOLDING')
      expect(res.stdout).not.toContain('ratchet:')
      expect(existsSync(countFile)).toBe(false)
    })

    it('EXECUTED — the OLD (unchecked) write silently prints the same claim even though the floor was never created — the exact defect this fix removes', () => {
      const dir = scratchDir('write-readonly-old')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const obstruction = join(dir, '.swarm', 'timing-count')
      writeFileSync(obstruction, 'not a directory\n')
      const countFile = join(obstruction, 'floor')
      const OLD_BLOCK = 'mkdir -p "$root/.swarm" && printf \'%s\\n\' "$TCOUNT" >"$COUNT_FILE"\n' + '[ -n "$RISE_NOTE" ] && echo "  timing-count ratchet:$RISE_NOTE"\n'
      const script = preludeScript(0, `root=${dir}\nTCOUNT=7\nCOUNT_FILE=${countFile}\nRISE_NOTE=" ROSE from 5 to 7"\n`) + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('timing-count ratchet: ROSE from 5 to 7')
      expect(existsSync(countFile)).toBe(false)
    })

    /**
     * The wave-1 near-miss, reproduced rather than described: two genuine
     * timing files carry the real marker, and a third carries the marker
     * text only as PROSE (explaining that it does NOT opt in) — exactly the
     * shape #42's own tolerance needle had. gate.sh's REAL discovery block
     * (`grep -rlF`, fixed-string) does not know the difference and enrolls
     * it anyway, so TCOUNT rises from an honest 2 to 3.
     */
    // Assembled, never written as one contiguous literal: this file lives
    // under `packages/server/src`, so the timing-opt-in marker written out
    // whole here would enrol THIS law in the timing set the same way #42's
    // tolerance needle did (see the KNOWN GAP entry above) — the earlier
    // "does NOT enroll this law file" test catches exactly that regression.
    const MARKER = '// @gate-' + 'timing'

    function waveOneNearMissFixture(): string {
      const dir = scratchDir('rise-repro')
      mkdirSync(join(dir, 'packages', 'fake', 'src'), { recursive: true })
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'a.test.ts'), `${MARKER}\nit("a", () => {})\n`)
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'b.test.ts'), `${MARKER}\nit("b", () => {})\n`)
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'c.test.ts'), `// this fixture does not carry the '${MARKER}' marker\nit('c', () => {})\n`)
      return dir
    }

    it('EXECUTED — the OLD (drop-only) ratchet silently absorbs the wave-1 near-miss: TCOUNT rises to 3 and nothing is reported', () => {
      const dir = waveOneNearMissFixture()
      writeFileSync(join(dir, 'timing-count'), '2\n')
      const OLD_BLOCK = 'PREV=$(cat "$COUNT_FILE")\n' + '[ "$TCOUNT" -lt "$PREV" ] && fail "shrink"\n' + 'echo "VERDICT: TCOUNT=$TCOUNT PREV=$PREV"\n'
      const script = preludeScript(0, `W=${dir}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + DISCOVERY_AND_COUNT_BLOCK + '\n' + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: TCOUNT=3 PREV=2')
      expect(res.stdout).not.toContain('ROSE')
    })

    it('EXECUTED — the NEW (real, extracted) ratchet catches the same near-miss: TCOUNT still rises to 3, but it is now named and reported', () => {
      const dir = waveOneNearMissFixture()
      const tcount = 3 // fixed by the fixture: three files match the fixed-string discovery
      const prev = tcount - RISE_DELTA // smallest PREV guaranteed to rise, whatever RISE_TOLERANCE is
      writeFileSync(join(dir, 'timing-count'), `${prev}\n`)
      const script = preludeScript(0, `W=${dir}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + DISCOVERY_AND_COUNT_BLOCK + '\n' + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`ROSE from ${prev} to ${tcount}`)
    })

    /**
     * A DIFFERENT spelling of the same accident: the set is DERIVED two
     * ways (marker comment OR `.bench.test.ts` name, :154), and the prose
     * near-miss above only exercises the marker path. A file picking up the
     * `.bench.test.ts` suffix by an ordinary rename or copy-paste — with no
     * marker anywhere in it — enrolls exactly the same way, through
     * `find … -name '*.bench.test.ts'` rather than `grep -rlF`. The ratchet
     * itself does not know or care which of the two discovery halves
     * produced the rise, so this proves the fix is not accidentally
     * marker-path-specific.
     */
    function benchFilenameNearMissFixture(): string {
      const dir = scratchDir('rise-repro-bench')
      mkdirSync(join(dir, 'packages', 'fake', 'src'), { recursive: true })
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'a.test.ts'), `${MARKER}\nit("a", () => {})\n`)
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'b.test.ts'), `${MARKER}\nit("b", () => {})\n`)
      writeFileSync(join(dir, 'packages', 'fake', 'src', 'reduce.bench.test.ts'), "it('not actually a benchmark, just misnamed', () => {})\n")
      return dir
    }

    it("EXECUTED — a bare RENAME into '*.bench.test.ts' (no marker at all) rises and reports the same way as the marker/prose near-miss", () => {
      const dir = benchFilenameNearMissFixture()
      const tcount = 3 // fixed by the fixture: two marker files plus one *.bench.test.ts
      const prev = tcount - RISE_DELTA // smallest PREV guaranteed to rise, whatever RISE_TOLERANCE is
      writeFileSync(join(dir, 'timing-count'), `${prev}\n`)
      const script = preludeScript(0, `W=${dir}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + DISCOVERY_AND_COUNT_BLOCK + '\n' + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`ROSE from ${prev} to ${tcount}`)
    })
  })

  describe(':293 lane manifest prune — a malformed or unwritable lanes.json holds, it does not print the success line', () => {
    const NEW_BLOCK = sliceLines('if [ -f "$root/.swarm/lanes.json" ]; then', 'fail "lane manifest prune failed', 2)

    it('the fix removes the try/catch{} that swallowed both JSON.parse and writeFileSync failures', () => {
      expect(NEW_BLOCK).not.toContain('catch {}')
      expect(NEW_BLOCK).toContain('const m = JSON.parse')
    })

    it('EXECUTED — the OLD form prints "lane manifest pruned" (exit 0) for BOTH a malformed and an unwritable lanes.json', () => {
      const OLD_SCRIPT =
        'if [ -f "$root/.swarm/lanes.json" ]; then\n' +
        '  H="$H" ROOT="$root" node -e \'\n' +
        '    const fs = require("fs");\n' +
        '    const p = process.env.ROOT + "/.swarm/lanes.json";\n' +
        '    try {\n' +
        '      const m = JSON.parse(fs.readFileSync(p, "utf8"));\n' +
        '      m.lanes = (m.lanes || []).filter(l => l.handle !== process.env.H);\n' +
        '      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\\n");\n' +
        '    } catch {}\n' +
        "  ' 2>/dev/null && echo \"  lane manifest pruned: $H\"\n" +
        'fi\n'

      const malformed = scratchDir('manifest-old-malformed')
      mkdirSync(join(malformed, '.swarm'), { recursive: true })
      writeFileSync(join(malformed, '.swarm', 'lanes.json'), '{ this is not json')
      let script = preludeScript(0, `root=${malformed}\n`) + OLD_SCRIPT
      let res = runFragment(script, malformed)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('lane manifest pruned')

      // This chmod does not need the #74 fix: the OLD script's `catch {}`
      // swallows a permission error the same as it swallows malformed JSON,
      // so it prints "pruned" (exit 0) whether or not the write actually
      // lands — the assertion below never checks the file's final content.
      // Confirmed unaffected under `unshare -r`: this case does not flip.
      const unwritable = scratchDir('manifest-old-unwritable')
      mkdirSync(join(unwritable, '.swarm'), { recursive: true })
      const lanesFile = join(unwritable, '.swarm', 'lanes.json')
      writeFileSync(lanesFile, '{"lanes":[{"handle":"t42"}]}')
      chmodSync(lanesFile, 0o444)
      script = preludeScript(0, `root=${unwritable}\n`) + OLD_SCRIPT
      res = runFragment(script, unwritable)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('lane manifest pruned')
    })

    it('EXECUTED — the NEW (real, extracted) form HOLDS on a malformed lanes.json', () => {
      const dir = scratchDir('manifest-new-malformed')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), '{ this is not json')
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('lane manifest prune failed')
    })

    // Unlike the timing-count floor above, lanes.json cannot be made
    // unwritable by an ENOTDIR obstruction: `[ -f ... ]` and `JSON.parse`
    // both need it to exist as a well-formed, readable regular file, and no
    // setup step open to an unprivileged test process holds a write off an
    // *existing* file against `CAP_DAC_OVERRIDE` (a directory's write bit is
    // the same bypassable check; `chattr +i` needs `CAP_LINUX_IMMUTABLE`
    // against the filesystem's owning namespace, not a user namespace's
    // mapped root — the setup itself would already fail as an unprivileged
    // user, let alone hold against one). So this proof skips itself as root,
    // per #74's done-when, rather than assert something false there.
    it.skipIf(RUNNING_AS_ROOT)('EXECUTED — the NEW form HOLDS on an unwritable lanes.json (skipped as root: chmod 0444 does not hold against CAP_DAC_OVERRIDE, and no reachable setup here holds an already-existing file unwritable against it)', () => {
      const dir = scratchDir('manifest-new-unwritable')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const lanesFile = join(dir, '.swarm', 'lanes.json')
      writeFileSync(lanesFile, '{"lanes":[{"handle":"t42"}]}')
      chmodSync(lanesFile, 0o444)
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('lane manifest prune failed')
      chmodSync(lanesFile, 0o644)
    })

    it('EXECUTED — the NEW form prunes and prints success on a well-formed, writable lanes.json — not vacuously always-holding', () => {
      const dir = scratchDir('manifest-new-ok')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: [{ handle: 't42' }, { handle: 'other' }] }))
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('lane manifest pruned: t42')
      const after = JSON.parse(execFileSync('cat', [join(dir, '.swarm', 'lanes.json')], { encoding: 'utf8' }))
      expect(after.lanes).toEqual([{ handle: 'other' }])
    })

    it('EXECUTED — the NEW form does nothing (no lanes.json present) — the outer guard is untouched by this fix', () => {
      const dir = scratchDir('manifest-new-absent')
      mkdirSync(dir, { recursive: true })
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
      expect(res.stdout).not.toContain('pruned')
    })

    /**
     * The shape half of the defect, distinct from the swallowed-catch half
     * above: a lanes.json that parses fine but is not shaped as
     * `{lanes: [...]}` used to write back unchanged (or gain an empty
     * `.lanes` it never had) and still print "pruned" — the file parsed
     * and was rewritten, which is not the fact the line claims. Each shape
     * below EXECUTED against the OLD (pre-#73) filter-only body first, to
     * show it really does print the false "pruned" line, then against the
     * real NEW_BLOCK to show it now holds.
     */
    const OLD_FILTER_ONLY = 'const m = JSON.parse(fs.readFileSync(p, "utf8"));\n    m.lanes = (m.lanes || []).filter(l => l.handle !== process.env.H);\n    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\\n");\n'

    function oldScriptFor(body: string): string {
      return (
        'if [ -f "$root/.swarm/lanes.json" ]; then\n' +
        '  H="$H" ROOT="$root" node -e \'\n' +
        '    const fs = require("fs");\n' +
        '    const p = process.env.ROOT + "/.swarm/lanes.json";\n' +
        `    ${body}` +
        "  ' 2>/dev/null && echo \"  lane manifest pruned: $H\"\n" +
        'fi\n'
      )
    }

    it('EXECUTED — a JSON-ARRAY lanes.json: the OLD filter-only body prints "pruned" though nothing shaped as {lanes:[...]} existed; the NEW form HOLDS', () => {
      const oldDir = scratchDir('manifest-shape-array-old')
      mkdirSync(join(oldDir, '.swarm'), { recursive: true })
      writeFileSync(join(oldDir, '.swarm', 'lanes.json'), JSON.stringify([{ handle: 't42' }]))
      const oldRes = runFragment(preludeScript(0, `root=${oldDir}\n`) + oldScriptFor(OLD_FILTER_ONLY), oldDir)
      expect(oldRes.status).toBe(0)
      expect(oldRes.stdout).toContain('lane manifest pruned')

      const dir = scratchDir('manifest-shape-array-new')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify([{ handle: 't42' }]))
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('lane manifest prune failed')
      // Pinned to the SPECIFIC thrown message, not just fail()'s generic
      // line: a verify pass found the shape guard's own message never
      // reached the operator (buried a few lines into node's stack trace,
      // past `tail -6`'s window) — PROVEN INERT by deleting the entire
      // guard and finding every shape test here still passed on the
      // generic fail() line alone. This assertion is what makes deleting
      // the guard fail this test instead of leaving it green.
      expect(res.stdout + res.stderr).toContain('Error: lanes.json is not shaped as {lanes: [...]}')
    })

    it('EXECUTED — an object with NO `.lanes` key: the OLD filter-only body prints "pruned" after silently CREATING an empty .lanes; the NEW form HOLDS instead of guessing', () => {
      const oldDir = scratchDir('manifest-shape-nokey-old')
      mkdirSync(join(oldDir, '.swarm'), { recursive: true })
      writeFileSync(join(oldDir, '.swarm', 'lanes.json'), JSON.stringify({ other: 1 }))
      const oldRes = runFragment(preludeScript(0, `root=${oldDir}\n`) + oldScriptFor(OLD_FILTER_ONLY), oldDir)
      expect(oldRes.status).toBe(0)
      expect(oldRes.stdout).toContain('lane manifest pruned')
      const oldAfter = JSON.parse(readFileSync(join(oldDir, '.swarm', 'lanes.json'), 'utf8'))
      expect(oldAfter.lanes).toEqual([]) // fabricated a key that was never there

      const dir = scratchDir('manifest-shape-nokey-new')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify({ other: 1 }))
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('lane manifest prune failed')
      expect(res.stdout + res.stderr).toContain('Error: lanes.json is not shaped as {lanes: [...]}')
      const after = JSON.parse(readFileSync(join(dir, '.swarm', 'lanes.json'), 'utf8'))
      expect(after).toEqual({ other: 1 }) // held before ever touching the file
    })

    it('EXECUTED — `.lanes` present but the WRONG TYPE (a string): the NEW form HOLDS rather than filtering a string as if it were an array', () => {
      const dir = scratchDir('manifest-shape-wrongtype')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: 'nope' }))
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('lane manifest prune failed')
      expect(res.stdout + res.stderr).toContain('Error: lanes.json is not shaped as {lanes: [...]}')
    })

    it("EXECUTED — `.lanes` an array of NON-OBJECT entries (strings, numbers): the NEW form HOLDS rather than silently filtering elements with no `.handle`", () => {
      const stringsDir = scratchDir('manifest-shape-elemstrings')
      mkdirSync(join(stringsDir, '.swarm'), { recursive: true })
      writeFileSync(join(stringsDir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: ['t42'] }))
      const stringsScript = preludeScript(1, `root=${stringsDir}\n`) + NEW_BLOCK + '\n'
      const stringsRes = runFragment(stringsScript, stringsDir)
      expect(stringsRes.status).toBe(1)
      expect(stringsRes.stdout + stringsRes.stderr).toContain('Error: lanes.json .lanes contains a non-object entry')
      const stringsAfter = JSON.parse(readFileSync(join(stringsDir, '.swarm', 'lanes.json'), 'utf8'))
      expect(stringsAfter).toEqual({ lanes: ['t42'] }) // held before ever touching the file

      const numsDir = scratchDir('manifest-shape-elemnums')
      mkdirSync(join(numsDir, '.swarm'), { recursive: true })
      writeFileSync(join(numsDir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: [1, 2] }))
      const numsScript = preludeScript(1, `root=${numsDir}\n`) + NEW_BLOCK + '\n'
      const numsRes = runFragment(numsScript, numsDir)
      expect(numsRes.status).toBe(1)
      expect(numsRes.stdout + numsRes.stderr).toContain('Error: lanes.json .lanes contains a non-object entry')
    })

    it('EXECUTED — a well-shaped manifest that legitimately has no entry for this handle succeeds QUIETLY: not a failure, and not printed as a prune that did not happen', () => {
      const dir = scratchDir('manifest-shape-noentry')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: [{ handle: 'other' }] }))
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
      expect(res.stdout).not.toContain('pruned')
      const after = JSON.parse(readFileSync(join(dir, '.swarm', 'lanes.json'), 'utf8'))
      expect(after.lanes).toEqual([{ handle: 'other' }])
    })

    /**
     * MUST-FIX 1 (verify pass): the ORIGINAL fix still wrote lanes.json
     * back unconditionally on every run, even a NOOP where nothing
     * changed. EXECUTED, control pair on a real read-only lanes.json:
     *   writable,  handle absent -> rc=0 "NOOP"   (correct)
     *   read-only, handle absent -> rc=1 EACCES   ("lane manifest prune
     *   failed") — a VALID manifest failing the exact case this issue's
     *   own criterion protects ("a manifest that legitimately has no
     *   entry for this handle still succeeds quietly; that is not an
     *   error"). The fix makes the write conditional on
     *   `after.length !== before`, so a NOOP never touches the file.
     */
    it.skipIf(RUNNING_AS_ROOT)('EXECUTED — a well-shaped, READ-ONLY manifest with no entry for this handle still succeeds quietly (skipped as root: chmod 0444 does not hold against CAP_DAC_OVERRIDE)', () => {
      const dir = scratchDir('manifest-readonly-noentry')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const lanesFile = join(dir, '.swarm', 'lanes.json')
      const before = JSON.stringify({ lanes: [{ handle: 'other' }] })
      writeFileSync(lanesFile, before)
      chmodSync(lanesFile, 0o444)
      const script = preludeScript(1, `root=${dir}\n`) + NEW_BLOCK + '\necho DONE\n'
      const res = runFragment(script, dir)
      chmodSync(lanesFile, 0o644)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('DONE')
      expect(res.stdout).not.toContain('pruned')
      expect(res.stdout + res.stderr).not.toContain('EACCES')
      expect(readFileSync(lanesFile, 'utf8')).toBe(before) // never written at all
    })

    /**
     * MUST-FIX 2 (verify pass): the ORIGINAL fix read the result with
     * `grep -qF PRUNED` — a SUBSTRING match. EXECUTED, controls against the
     * real bash logic (`case` on the file's exact content, mirroring what
     * the real NEW_BLOCK's `grep -qxF` line does):
     *   "PRUNED"     -> prints "pruned"   (correct)
     *   "NOOP"       -> quiet             (correct)
     *   "NOT_PRUNED" -> the OLD `-F` form PRINTS "pruned" (a false claim:
     *                   "PRUNED" is a substring of "NOT_PRUNED"); the NEW
     *                   `-x` (exact whole-line) form correctly HOLDS.
     * gate.sh runs `set -uo pipefail` with no `-e`, so node writing
     * anything other than exactly "PRUNED" or "NOOP" — corrupted output, a
     * truncated write — used to be indistinguishable from a genuine NOOP
     * once `-F`'s substring match was fooled. This is the same "verdict
     * outruns what was established" shape the rest of this issue closes.
     */
    it("EXECUTED — the PRUNED/NOOP protocol requires an EXACT match on BOTH arms: a corrupted result containing \"PRUNED\" or \"NOOP\" as a substring does not fail open", () => {
      const oldProtocolLine = 'grep -qF PRUNED "$MANIFEST_OUT_LOG" && echo "  lane manifest pruned: $H"'
      const newProtocolLines = sliceLines('if grep -qxF PRUNED "$MANIFEST_OUT_LOG"; then', 'echo "  lane manifest pruned: $H"')
      expect(SOURCE).not.toContain(oldProtocolLine) // the substring-matching form is gone
      expect(NEW_BLOCK).toContain('grep -qxF PRUNED')
      expect(newProtocolLines).toContain('grep -qxF PRUNED')
      // The NOOP arm is anchored too, and this is not symmetry for its own
      // sake: the harness below is a RETYPED copy of the protocol, so the
      // only thing tying it to the real file is an assertion like this one.
      // Reviewed 2026-08-31 by MUTATION — rewriting gate.sh's NOOP arm to
      // the substring form (`grep -qxF NOOP` -> `grep -qF NOOP`) left this
      // whole file green at 137/137, because nothing read the real NOOP
      // line and no fixture fed a NOOP-substring result through it. The
      // PRUNED arm was already anchored, which is why the same mutation
      // there DOES redden. Same defect, one arm quieter.
      expect(NEW_BLOCK).toContain('grep -qxF NOOP')

      function protocolResultFor(content: string): FragmentResult {
        const dir = scratchDir('manifest-protocol')
        const outLog = join(dir, 'out.log')
        mkdirSync(dir, { recursive: true })
        writeFileSync(outLog, content)
        const script =
          preludeScript(0, `MANIFEST_OUT_LOG=${outLog}\nH=t42\n`) +
          'if grep -qxF PRUNED "$MANIFEST_OUT_LOG"; then\n' +
          '  echo "  lane manifest pruned: $H"\n' +
          'elif grep -qxF NOOP "$MANIFEST_OUT_LOG"; then\n' +
          '  :\n' +
          'else\n' +
          '  fail "lane manifest prune produced an unrecognized result — refusing to guess whether $H was pruned"\n' +
          'fi\n' +
          'echo DONE\n'
        return runFragment(script, dir)
      }

      const pruned = protocolResultFor('PRUNED')
      expect(pruned.status).toBe(0)
      expect(pruned.stdout).toContain('lane manifest pruned: t42')

      const noop = protocolResultFor('NOOP')
      expect(noop.status).toBe(0)
      expect(noop.stdout).not.toContain('pruned')
      expect(noop.stdout).toContain('DONE')

      const corrupted = protocolResultFor('NOT_PRUNED')
      expect(corrupted.status).toBe(1)
      expect(corrupted.stdout + corrupted.stderr).toContain('unrecognized result')
      expect(corrupted.stdout).not.toContain('lane manifest pruned:') // the false success line, specifically

      // The sibling: a NOOP-substring corruption is the QUIET version of the
      // same failure. It prints no false line, so it is easy to miss — the
      // gate simply proceeds as though the manifest had been read and found
      // to need nothing, which is a verdict it never established.
      const corruptedNoop = protocolResultFor('NOT_NOOP')
      expect(corruptedNoop.status).toBe(1)
      expect(corruptedNoop.stdout + corruptedNoop.stderr).toContain('unrecognized result')
      expect(corruptedNoop.stdout).not.toContain('DONE') // it must HOLD, not proceed silently
    })

    /**
     * WORTH-DOING (verify pass): if MANIFEST_OUT_LOG's own mktemp fails,
     * MANIFEST_LOG — already created by the mktemp just before it — was
     * never removed before fail(). A fake `mktemp` on PATH ahead of the
     * real one lets the FIRST call (MANIFEST_LOG) succeed and the SECOND
     * (MANIFEST_OUT_LOG) fail, and logs the one real path it created, so
     * this checks the EXACT file rather than a racy /tmp glob (this file's
     * fixtures share H=t42, so many tests create `gate-manifest-t42.*`
     * paths; a glob-based "nothing leaked" check would be flaky under
     * concurrent test runs).
     */
    it('EXECUTED — an mktemp failure on MANIFEST_OUT_LOG does not leak MANIFEST_LOG', () => {
      const dir = scratchDir('manifest-mktemp-leak')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      writeFileSync(join(dir, '.swarm', 'lanes.json'), JSON.stringify({ lanes: [{ handle: 't42' }] }))
      const fakeBin = scratchDir('manifest-mktemp-fakebin')
      const counterFile = join(fakeBin, 'count')
      const pathLog = join(fakeBin, 'created-path')
      const mktempScript =
        '#!/bin/bash\n' +
        `n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)\n` +
        'n=$((n+1))\n' +
        `echo "$n" > ${JSON.stringify(counterFile)}\n` +
        'if [ "$n" -eq 2 ]; then echo "mktemp: fake failure" >&2; exit 1; fi\n' +
        'p=$(/usr/bin/mktemp "$@")\n' +
        `echo "$p" >> ${JSON.stringify(pathLog)}\n` +
        'echo "$p"\n'
      writeFileSync(join(fakeBin, 'mktemp'), mktempScript)
      chmodSync(join(fakeBin, 'mktemp'), 0o755)
      const script = preludeScript(1, `root=${dir}\nexport PATH=${JSON.stringify(fakeBin)}:$PATH\n`) + NEW_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain("cannot create a scratch file for the lane-manifest prune's result")
      const createdPaths = readFileSync(pathLog, 'utf8').trim().split('\n').filter(Boolean)
      expect(createdPaths.length).toBe(1) // only MANIFEST_LOG's mktemp succeeded
      expect(existsSync(createdPaths[0]!)).toBe(false) // and it was cleaned up before fail(), not leaked
    })
  })

  describe(':287 branch containment (ruling 2) — the postcondition proves the commit is IN main, not that a ref is gone', () => {
    const LANE_SHA_LINE = extractLine('LANE_SHA=$(git -C "$W" rev-parse HEAD)')
    const CONTAINMENT_LINE = extractLine('git merge-base --is-ancestor "$LANE_SHA" main || fail')

    it('the old ref-absence postcondition ( rev-parse --verify "refs/heads/$BRANCH" ) is gone from the file', () => {
      expect(SOURCE).not.toContain('rev-parse --verify "refs/heads/$BRANCH"')
    })

    it('the fix captures the lane tip BEFORE the merge touches the branch ref, then proves containment against the `main` REF — not $root\'s checked-out HEAD', () => {
      expect(LANE_SHA_LINE).toContain('git -C "$W" rev-parse HEAD')
      expect(CONTAINMENT_LINE).toContain('merge-base --is-ancestor')
      expect(CONTAINMENT_LINE).toContain('"$LANE_SHA" main')
      // A verification pass found the postcondition originally checked
      // HEAD, not main — indistinguishable from correct whenever $root
      // happens to be sitting on main, and silently wrong whenever it is
      // not, which AGENTS.md's own dispatch-preflight rationale says is
      // routine ("the main checkout is routinely parked on a feature or
      // audit branch"). This assertion is the regression guard for that.
      expect(CONTAINMENT_LINE).not.toContain('"$LANE_SHA" HEAD')
    })

    function unmergedFixture(): { root: string; laneSha: string } {
      const root = scratchDir('containment')
      initRepo(root)
      writeFileSync(join(root, 'a.txt'), 'a\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      git(root, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(root, 'b.txt'), 'b\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'feature-only commit, never merged')
      const laneSha = git(root, 'rev-parse', 'HEAD')
      git(root, 'checkout', '-q', 'main')
      const wt = scratchDir('containment-wt')
      rmSync(wt, { recursive: true, force: true })
      git(root, 'worktree', 'add', '-q', '--detach', wt, 'feature')
      return { root, laneSha }
    }

    it('EXECUTED — the OLD postcondition (branch-ref absence) reports "merge complete" in a detached worktree that was NEVER actually merged', () => {
      const { root } = unmergedFixture()
      const script = preludeScript(0, 'BRANCH=HEAD\n') + 'if git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then\n' + '  fail "branch still exists"\n' + 'fi\n' + 'echo "VERDICT: merge complete"\n'
      const res = runFragment(script, root)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: merge complete')
    })

    it('EXECUTED — the NEW (real, extracted) postcondition HOLDS on the same never-merged commit', () => {
      const { root, laneSha } = unmergedFixture()
      const script = preludeScript(1, `BRANCH=feature\nW=.\nLANE_SHA=${laneSha}\n`) + `cd "$root"\n` + CONTAINMENT_LINE + '\necho "VERDICT: merge complete"\n'
      const scriptWithRoot = script.replace('cd "$root"', `cd "${root}"`)
      const res = runFragment(scriptWithRoot, root)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('is not contained in main')
    })

    it('EXECUTED — the NEW postcondition passes after a REAL merge — not vacuously always-holding', () => {
      const { root, laneSha } = unmergedFixture()
      git(root, 'merge', '-q', '--no-edit', 'feature')
      const script = preludeScript(1, `BRANCH=feature\nLANE_SHA=${laneSha}\n`) + CONTAINMENT_LINE + '\necho "VERDICT: merge complete"\n'
      const res = runFragment(script, root)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: merge complete')
    })

    /**
     * A verification pass found that :287 checked HEAD, not main — and that
     * this describe block could not have caught it, because every fixture
     * above runs with $root checked out ON main, encoding the very premise
     * the defect depended on. This fixture instead parks $root on a branch
     * that descends from the (never-merged) lane commit — exactly what
     * AGENTS.md's dispatch-preflight rationale calls routine: "the main
     * checkout is routinely parked on a feature or audit branch."
     */
    function rootParkedOffMainFixture(): { root: string; laneSha: string } {
      const root = scratchDir('containment-parked')
      initRepo(root)
      writeFileSync(join(root, 'a.txt'), 'a\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      git(root, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(root, 'b.txt'), 'b\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'feature-only commit, never merged into main')
      const laneSha = git(root, 'rev-parse', 'HEAD')
      // audit-branch descends from feature, so HEAD here already contains
      // laneSha as an ancestor — while main (untouched) does not.
      git(root, 'checkout', '-q', '-b', 'audit-branch')
      return { root, laneSha }
    }

    it('EXECUTED — checking against HEAD (the exact defect this round fixed) falsely reports containment when $root is parked off main', () => {
      const { root, laneSha } = rootParkedOffMainFixture()
      const script = preludeScript(0, 'BRANCH=feature\n') + `git merge-base --is-ancestor ${laneSha} HEAD || fail "not contained in HEAD"\n` + 'echo "VERDICT: merge complete"\n'
      const res = runFragment(script, root)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('VERDICT: merge complete')
      const mainLog = git(root, 'log', '--oneline', 'main').split('\n')
      expect(mainLog).toHaveLength(1)
      expect(mainLog[0]).toContain('init')
    })

    it('EXECUTED — the NEW (real, extracted) postcondition correctly HOLDS in the same parked-root scenario, because it checks main, not HEAD', () => {
      const { root, laneSha } = rootParkedOffMainFixture()
      const script = preludeScript(1, `BRANCH=feature\nW=.\nLANE_SHA=${laneSha}\n`) + CONTAINMENT_LINE + '\necho "VERDICT: merge complete"\n'
      const res = runFragment(script, root)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('is not contained in main')
    })
  })

  it('bash -n scripts/gate.sh passes and the header still describes what the script does', () => {
    execFileSync('bash', ['-n'], { input: SOURCE, encoding: 'utf8' })
    expect(SOURCE).toContain('a landing gate that BLOCKS')
  })

  /**
   * prd17 w5 (#273) — the gate derives its own verdict and prints it as one
   * v1 beacon line (ADR-0036) on its own final line. `emit_gate_verdict` and
   * its two callers (`fail()`, and the clean end of the script) are extracted
   * WHOLE — from the real `MERGED=0` through the real `GATE_TEE_PID=$!` — and
   * run against real scratch files, the same "reuse, never reimplement"
   * discipline as every other describe block in this file.
   */
  describe('prd17 w5 (#273) — the gate prints one v1 verdict beacon line, held correct on both sides of the merge', () => {
    const VERDICT_MACHINERY = sliceLines('MERGED=0', 'GATE_TEE_PID=$!')

    it('the vocabulary is declared once, and every fail() call site names one of its members', () => {
      const vocabLine = extractLine('GATE_VERDICT_VOCAB=')
      const vocabMatch = vocabLine.match(/GATE_VERDICT_VOCAB="([^"]+)"/)
      expect(vocabMatch, 'GATE_VERDICT_VOCAB must be a plain space-separated quoted string').not.toBeNull()
      const vocab = new Set(vocabMatch![1]!.split(/\s+/).filter(Boolean))
      expect(vocab.size).toBeGreaterThan(0)
      expect(vocab.has('clean'), 'the clean end of the script names this category — it must be declared').toBe(true)

      /**
       * ENUMERATE FIRST, CLASSIFY SECOND (review of #273, finding 3).
       *
       * The previous version built `failCallSites` with a regex that ALREADY
       * required a category, then checked the resulting list for sites with no
       * category. A site lacking one never entered the list, so
       * `expect(untagged).toEqual([])` could not fail — the shape AGENTS.md
       * names as the second-worst defect here, a test that cannot fail for the
       * reason it claims. A review seat proved it: dropping ` suite-red` from a
       * real call site left the file 190 green, and so did spelling it
       * `suite_red`, while the runtime emitted `"reason":"suite_red"`.
       *
       * The site detector is therefore deliberately loose — anything that looks
       * like a `fail` invocation — and the category is extracted afterwards, so
       * every form lands in exactly one bucket instead of vanishing. The
       * grammar it must cover, each row a spelling the seat found invisible:
       *
       * | form                          | before | now              |
       * |-------------------------------|--------|------------------|
       * | `fail "m" cat`                | seen   | tagged           |
       * | `\|\| fail "m" cat` / `&& …`   | seen   | tagged           |
       * | `fail "m" cat; }` (rescue)    | seen   | tagged           |
       * | `fail "m" bogus` (undeclared) | caught | caught           |
       * | `fail "m"` (no category)      | INVISIBLE | untagged      |
       * | `fail "m" cat  # why`         | INVISIBLE | tagged        |
       * | `fail "m" suite_red`          | INVISIBLE | undeclared    |
       * | `fail 'm' cat`                | INVISIBLE | tagged        |
       * | `fail "m" "$CAT"` (dynamic)   | INVISIBLE | dynamic       |
       *
       * A dynamic category is its own bucket rather than an error: it defeats
       * the vocabulary by construction, since nothing static can tell what it
       * resolves to. There are none today and the assertion says so.
       */
      const failCallSites = LINES.filter((l) => isFailCallSite(l))
      expect(failCallSites.length, 'no real fail() call sites matched — the site detector drifted from the real spelling').toBeGreaterThan(30)

      const untagged: string[] = []
      const badCategory: string[] = []
      const dynamicCategory: string[] = []
      for (const line of failCallSites) {
        const bucket = classifyFailSite(line)
        if (bucket === 'untagged') {
          untagged.push(line.trim())
        } else if (bucket === 'dynamic') {
          dynamicCategory.push(line.trim())
        } else if (!vocab.has(bucket)) {
          badCategory.push(`${bucket}: ${line.trim()}`)
        }
      }
      expect(untagged, 'fail() call site(s) with no category argument — the record would read "uncategorized"').toEqual([])
      expect(dynamicCategory, 'fail() call site(s) whose category is computed — the vocabulary cannot check it').toEqual([])
      expect(badCategory, 'fail() call site(s) naming a category outside GATE_VERDICT_VOCAB').toEqual([])
    })

    /**
     * THE DECOY — the classifier above is itself a grep-as-law, so it gets the
     * treatment this file gives every other one: fed each spelling the seat
     * found invisible, and required to bucket it correctly. Without this, the
     * classifier could drift back to the shape it just replaced and its own
     * "no site is untagged" assertion would go quiet again.
     */
    it('the fail-site classifier sees every spelling, including the five that used to vanish', () => {
      // THE LIVE functions, not a retyped copy (review of #273, round 2). The
      // first version declared its own local `classify` with the regexes typed
      // out again, so it exercised a duplicate: reverting the real detector to
      // the exact pre-fix regex AND re-introducing the original defect in
      // gate.sh left this file 200 green, while its own comment claimed it
      // prevented precisely that. This file's stated discipline is "reuse,
      // never reimplement" — `FAIL_BLOCK`, `SHELL_OPTS` and `sliceLines` all
      // derive from the real source — and the decoy was the one place breaking
      // it.
      const classify = (line: string) => (isFailCallSite(line) ? classifyFailSite(line) : 'not-a-site')
      expect(classify('  fail "boom" suite-red')).toBe('suite-red')
      expect(classify('  cmd || fail "boom" suite-red')).toBe('suite-red')
      expect(classify('  { cat log; fail "boom" suite-red; }')).toBe('suite-red')
      expect(classify('  fail "boom"')).toBe('untagged')
      expect(classify('  fail "boom" suite-red  # why')).toBe('suite-red')
      expect(classify("  fail 'boom' suite-red")).toBe('suite-red')
      expect(classify('  fail "boom" suite_red')).toBe('suite_red')
      expect(classify('  fail "boom" "$CAT"')).toBe('dynamic')
      expect(classify('  echo "no fail here"')).toBe('not-a-site')
    })

    it('every category is a short slug, never prose, and fits the v1 line\'s own 64-char cap', () => {
      const vocabLine = extractLine('GATE_VERDICT_VOCAB=')
      const vocab = vocabLine.match(/GATE_VERDICT_VOCAB="([^"]+)"/)![1]!.split(/\s+/).filter(Boolean)
      for (const word of vocab) {
        expect(word.length, `"${word}" is too long for a category`).toBeLessThanOrEqual(64)
        expect(word).toMatch(/^[a-z][a-z0-9-]*$/)
      }
    })

    /** H unique per test — GATE_OUTFILE and the tee pipe are named from it, and tests run concurrently. */
    function runVerdict(setup: string): FragmentResult & { dir: string; h: string } {
      const dir = scratchDir('verdict')
      const h = `verdict-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const script = `#!/bin/bash\n${SHELL_OPTS}\nH=${h}\n${VERDICT_MACHINERY}\n${setup}\n`
      const res = runFragment(script, dir)
      return { ...res, dir, h }
    }

    /** The exact bytes fail() itself prints before calling emit_gate_verdict — independently re-derived so the digest assertions below cannot be satisfied by a hardcoded or empty capture. */
    function expectedPreVerdictOutput(handle: string, message: string, merged: 0 | 1): string {
      const secondLine =
        merged === 0
          ? `>>> HOLDING ${handle} — not merged`
          : '>>> MERGED to local main, NOT pushed — fix forward on main immediately, then push'
      return `GATE FAILED: ${message}\n${secondLine}\n`
    }

    function lastLine(stdout: string): string {
      const lines = stdout.split('\n').filter((l) => l.length > 0)
      return lines[lines.length - 1] ?? ''
    }

    it('EXECUTED — a pre-merge fail() prints exactly one v1 beacon line as its FINAL line, held true, reason the declared category', () => {
      const { stdout, h } = runVerdict('fail "boom" suite-red')
      const line = lastLine(stdout)
      const parsed = JSON.parse(line)
      expect(parsed).toMatchObject({ v: 1, writer: 'gate', kind: 'gate.verdict', lane: h, held: true, reason: 'suite-red' })
      expect(typeof parsed.at).toBe('number')
      expect(parsed.outputDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(parsed.loadBatches).toBeUndefined()
    })

    it('EXECUTED — held is FALSE on the post-merge failure path (MERGED=1) — the flip this issue exists to prove, not just the pre-merge default', () => {
      const { stdout } = runVerdict('MERGED=1\nfail "build broke" build-broken')
      const parsed = JSON.parse(lastLine(stdout))
      expect(parsed.held).toBe(false)
      expect(parsed.reason).toBe('build-broken')
    })

    /**
     * THE BOUNDARY ITSELF, not the emitter's reading of it (review of #273).
     *
     * The test above proves `emit_gate_verdict` honours `MERGED` — but it sets
     * `MERGED=1` in its OWN harness snippet, so it never exercises the script's
     * `MERGED=1` line. Deleting that line left the whole suite green at
     * 190/191 while every post-merge failure began reporting `held: true` —
     * the exact inversion this issue's Definition of done forbids ("a verdict
     * reporting `held: true` for a post-merge failure would say the opposite
     * of what happened"). EXECUTED, before this test existed.
     *
     * So the invariant is positional and is asserted as such: the assignment
     * exists exactly once, it sits AFTER the containment check that is the last
     * pre-merge `fail`, and it sits BEFORE both post-merge checks. Moving it to
     * either side, or deleting it, reddens here.
     *
     * Anchored on text rather than line numbers, per this file's own rule — a
     * reworded anchor throws at collection, loudly, instead of passing
     * vacuously.
     */
    it('MUTATION — the MERGED=1 boundary sits between the merge and the post-merge checks, and deleting it reddens', () => {
      const boundary = uniqueCodeLineIndex('MERGED=1')
      const lastPreMerge = uniqueCodeLineIndex('is not contained in main — the merge did not complete')
      const install = uniqueCodeLineIndex('npm install after merge broke')
      const build = uniqueCodeLineIndex('if npm run build >')

      expect(lastPreMerge, 'the containment check must precede the boundary').toBeLessThan(boundary)
      expect(boundary, 'npm install runs AFTER the merge — it holds the push, not the merge').toBeLessThan(install)
      expect(boundary, 'npm run build runs AFTER the merge — it holds the push, not the merge').toBeLessThan(build)
    })

    /**
     * The pair above and below are what bind the boundary to the verdict: this
     * one proves the emitter reads `MERGED`, the one above proves the script
     * sets it in the right place. Neither alone is sufficient, which is how the
     * gap arrived — the emitter was tested with an injected value and the line
     * that produces that value was tested by nothing.
     */
    it('EXECUTED — the clean end of the script emits held:false, reason:clean, with real output captured beforehand', () => {
      const { stdout, h } = runVerdict('echo "  build OK"\nMERGED=1\nemit_gate_verdict clean')
      const parsed = JSON.parse(lastLine(stdout))
      expect(parsed).toMatchObject({ v: 1, writer: 'gate', kind: 'gate.verdict', lane: h, held: false, reason: 'clean' })
    })

    /**
     * THE PUSH OUTCOME REACHES THE RECORD (review of #273, finding 1).
     *
     * Before this, a landing whose push FAILED emitted `reason: "clean"` —
     * byte-identical to a pushed landing in every categorical field of the
     * verdict, separable only by an opaque digest. A review seat found it and
     * this is the guard. Both are `held: false`, correctly: the merge is real
     * and local `main` carries it either way. What differs is whether anything
     * reached `origin`, and AGENTS.md's own "a green gate on a branch whose
     * base is not `main`" section exists because a record that reads as done
     * while nothing was pushed is the expensive failure here.
     *
     * `push_or_warn` lives outside `VERDICT_MACHINERY`'s slice, so it is
     * extracted from the real script by its own anchors and run against a
     * shadowed `git` — the alternative, restating it in a fixture, is the
     * defect this very issue's `MERGED=1` gap turned out to be.
     */
    describe('the push outcome is a category, not a footnote', () => {
      // Ends on the comment that follows the CALL, because `push_or_warn`
      // itself appears four times in the script and `uniqueLineIndex` refuses
      // an ambiguous anchor — loudly, at collection, which is the behaviour
      // this file wants. The slice therefore covers the flag, the function and
      // its invocation, all from the real script.
      const PUSH_MACHINERY = sliceLines('PUSHED=1', '# The verdict distinguishes the two clean landings')

      function runPush(gitExit: number) {
        const dir = scratchDir('push')
        const h = `push-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        // A `git` earlier on PATH than the real one, so nothing here can reach
        // a real remote no matter how the script changes.
        const bin = join(dir, 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'git'), `#!/bin/bash\necho "fake git: $*"\nexit ${gitExit}\n`)
        chmodSync(join(bin, 'git'), 0o755)
        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nexport PATH="${bin}:$PATH"\nH=${h}\n` +
          `${VERDICT_MACHINERY}\nMERGED=1\n${PUSH_MACHINERY}\n` +
          `if [ "$PUSHED" = 1 ]; then emit_gate_verdict clean; else emit_gate_verdict push-failed; fi\n`
        return { ...runFragment(script, dir), h }
      }

      it('EXECUTED — a FAILED push is recorded as push-failed, still held:false because the merge is real', () => {
        const { stdout } = runPush(128)
        const parsed = JSON.parse(lastLine(stdout))
        expect(parsed.reason).toBe('push-failed')
        expect(parsed.held).toBe(false)
        expect(stdout).toContain('push FAILED')
      })

      it('EXECUTED — a successful push is recorded as clean, and the two are distinguishable', () => {
        const ok = JSON.parse(lastLine(runPush(0).stdout))
        const bad = JSON.parse(lastLine(runPush(128).stdout))
        expect(ok.reason).toBe('clean')
        // The whole finding: before the fix these two were equal.
        expect(ok.reason).not.toBe(bad.reason)
      })

      /**
       * The behavioural pair above proves the emitter and `push_or_warn` agree.
       * This binds the SCRIPT to calling them that way — the seam that the
       * `MERGED=1` gap showed is exactly what goes untested when a fixture
       * supplies what the script should provide.
       */
      it('the script itself branches on PUSHED and names both categories', () => {
        const branch = uniqueCodeLineIndex('if [ "$PUSHED" = 1 ]; then')
        const cleanEmit = uniqueCodeLineIndex('  emit_gate_verdict clean')
        const failedEmit = uniqueCodeLineIndex('  emit_gate_verdict push-failed')
        // `push_or_warn` appears 4 times (comment, definition, call, and this
        // file's own tolerance row), so the CALL is anchored by the comment
        // that sits immediately above the branch instead.
        const pushDone = uniqueLineIndex('# The verdict distinguishes the two clean landings')
        expect(pushDone, 'the verdict must follow the push, never precede it').toBeLessThan(branch)
        expect(branch).toBeLessThan(cleanEmit)
        expect(cleanEmit).toBeLessThan(failedEmit)
      })
    })

    it('EXECUTED — loadBatches rides the line only when the run had any', () => {
      const withLoad = JSON.parse(lastLine(runVerdict('LOAD=3\nfail "flaky" load-flake').stdout))
      expect(withLoad.loadBatches).toBe(3)
      const withoutLoad = JSON.parse(lastLine(runVerdict('fail "flaky" load-flake').stdout))
      expect(withoutLoad.loadBatches).toBeUndefined()
    })

    it('MUTATION — outputDigest is bound to the run\'s ACTUAL captured output, not a placeholder: pointing it at the empty string would pass a shape-only check and must fail this one', () => {
      const { stdout, h } = runVerdict('fail "boom" suite-red')
      const parsed = JSON.parse(lastLine(stdout))
      const expected = createHash('sha256').update(expectedPreVerdictOutput(h, 'boom', 0), 'utf8').digest('hex')
      expect(parsed.outputDigest).toBe(expected)
      // The mutation this guards against: emptyDigest below is what a
      // `GATE_DIGEST=""` placeholder (or a digest of "" via a broken capture)
      // would produce — a schema-shape check alone cannot tell the two apart.
      const emptyDigest = createHash('sha256').update('', 'utf8').digest('hex')
      expect(parsed.outputDigest).not.toBe(emptyDigest)
    })

    it('EXECUTED — a different message/category changes the digest: it is a real hash of real content, not a fixed constant', () => {
      const a = JSON.parse(lastLine(runVerdict('fail "first failure" suite-red').stdout))
      const b = JSON.parse(lastLine(runVerdict('fail "a completely different failure" typecheck-red').stdout))
      expect(a.outputDigest).not.toBe(b.outputDigest)
    })

    /**
     * THE EMITTER'S OWN FAILURES ARE NOT SWALLOWED (review of #273, finding 4).
     *
     * Three ways the verdict used to be lost or corrupted, each EXECUTED by a
     * review seat before these guards existed:
     *
     *  - the digest command failing emitted `"outputDigest":""`. No closed v1
     *    field rejects that, so the line looked fine — but `gate.ts`'s
     *    `sha256Hex` is /^[0-9a-f]{64}$/, so #274 would refuse it downstream,
     *    and lenient parsing degrades a refused event to an UNKNOWN one rather
     *    than erroring. The verdict would vanish quietly.
     *  - `LOAD=abc` (never validated, and `$3` is operator input) made
     *    `int(load)` raise, `2>/dev/null` swallowed it, and NO LINE was emitted
     *    at all — the record of the landing lost because an argument was
     *    mistyped.
     *  - python3 failing emitted nothing, which is worst precisely when the run
     *    has already gone wrong.
     */
    describe('the emitter degrades honestly rather than silently', () => {
      it('EXECUTED — an uncomputable digest OMITS the key rather than emitting an invalid empty one', () => {
        const { stdout } = runVerdict('GATE_OUTFILE=/nonexistent/path/that/cannot/be/read\nfail "boom" suite-red')
        const parsed = JSON.parse(lastLine(stdout))
        expect(parsed.outputDigest, 'an empty digest is refused downstream — omit instead').toBeUndefined()
        expect(parsed).toMatchObject({ v: 1, writer: 'gate', kind: 'gate.verdict', reason: 'suite-red' })
      })

      /**
       * There is deliberately NO hand-built fallback, and this pins its absence
       * (review of #273, round 2). One was written and reverted: it branched on
       * python's EXIT STATUS rather than on whether it produced output, so a
       * python that printed its line then exited non-zero emitted TWO verdict
       * events for one landing — and it interpolated the handle into JSON
       * unescaped, so a branch named `quote"handle` produced unparseable JSON on
       * exactly the path meant to rescue the record. Both found by review seats.
       *
       * A fallback for a missing python3 guards a state the script refuses to
       * run in: `command -v python3 … || fail` aborts the gate long before the
       * emitter. (An earlier version of this said "four other places"; two of
       * those four are inside `emit_gate_verdict` itself, so it is one other
       * invocation plus that presence check — corrected in round 2.)
       * Speculative robustness in the LANDING tool bought nothing and cost two
       * defects.
       */
      it('emits at most ONE line, and no shell-built fallback can add a second', () => {
        const machinery = VERDICT_MACHINERY
        expect(machinery, 'a shell-built JSON line is how the double-emit and the unescaped handle arrived').not.toContain(
          '"writer":"gate","kind":"gate.verdict"',
        )
        expect(machinery, 'branching the emit on python\'s exit status is what emitted twice').not.toMatch(/\|\|\s*printf/)
      })

      it('EXECUTED — exactly one beacon line per run, counted rather than sampled', () => {
        const { stdout } = runVerdict('fail "boom" suite-red')
        const beacons = stdout.split('\n').filter((l) => l.includes('"kind":"gate.verdict"'))
        expect(beacons, 'lastLine() cannot see a second line — count them').toHaveLength(1)
      })

      it('EXECUTED — the captured-output scratch file is removed after the verdict (finding 5)', () => {
        const { stdout, dir } = runVerdict('echo "$GATE_OUTFILE" >&3\nfail "boom" suite-red')
        const outfile = stdout.split('\n').find((l) => l.includes('/gate-output-'))?.trim()
        expect(outfile, 'the fixture must actually name the scratch file, or this asserts nothing').toBeTruthy()
        expect(existsSync(outfile!), `${outfile} should have been removed after the emit`).toBe(false)
        expect(dir).toBeTruthy()
      })

      /**
       * Finding 6 is latent — no orphan holding fd 1 is reachable in today's
       * script — so this pins the BOUND rather than provoking the hang, which
       * would cost the suite ten seconds to prove one `if`. A landing may fail;
       * it may not hang.
       */
      /**
       * A TIMEOUT MAKES THE DIGEST UNCOMPUTABLE, NOT PARTIAL (review of #273,
       * round 2). The first bounded wait let the digest be taken anyway and
       * warned on stderr, which emitted a normal valid 64-hex `outputDigest`
       * over a capture still being written — a seat captured `EARLY`, had an
       * inherited-stdout child write `LATE` at 11s, and the beacon carried
       * sha256("EARLY\\n") with nothing downstream able to tell. A digest that
       * silently covers less than it claims is worse than no digest, because
       * only one of the two is detectable.
       */
      // 20s, because it waits out the REAL 10s ceiling. The alternative — an env
      // knob so the test could use a short one — is a tuning dial on the landing
      // tool whose mis-set value would silently drop the digest from every
      // landing. This issue has already paid twice for speculative additions to
      // this file; a slow test is the cheaper side of that trade.
      it('EXECUTED — a drain that times out omits the digest rather than binding a partial one', { timeout: 20_000 }, () => {
        const { stdout, stderr } = runVerdict(
          // a child that inherits stdout and outlives the foreground command is
          // exactly what makes the tee pipe stay open past the timeout.
          'sleep 12 & GATE_TEE_PID=$!\nfail "boom" suite-red',
        )
        const parsed = JSON.parse(lastLine(stdout))
        expect(parsed.outputDigest, 'a partial capture must not be reported as a digest').toBeUndefined()
        expect(parsed.reason).toBe('suite-red')
        expect(stderr + stdout, 'the timeout must be said out loud').toContain('did not drain')
      })

      it('the drain wait is bounded, not a bare wait that could block forever', () => {
        const machinery = VERDICT_MACHINERY
        expect(machinery, 'a bare `wait` on the tee pid is unbounded').not.toMatch(/^\s*wait "\$\{GATE_TEE_PID:-\}"/m)
        expect(machinery).toContain('kill -0 "$GATE_TEE_PID"')
        // The ceiling must be WALL CLOCK. A loop counter is not a bound: the
        // first version counted 100 iterations of `sleep 0.1`, called it ten
        // seconds, and on a loaded macOS runner ran past twelve — letting a
        // still-writing capture read as drained (review of #273, round 3).
        expect(machinery, 'the ceiling must be a deadline, not a loop count').toMatch(/SECONDS \+ 10/)
        expect(machinery, 'a loop counter lengthens under load — that is not a bound').not.toMatch(/_waited/)
      })
    })

    it('EXECUTED — the printed line survives the REAL collector parser (parseBeaconLine) and the closed v1 schema (beaconReceivedPayloadSchema), extra keys intact in the raw text', () => {
      const { stdout, h } = runVerdict('fail "boom" suite-red')
      const line = lastLine(stdout)
      const parsedLine = parseBeaconLine(line)
      expect(parsedLine.kind).toBe('beacon')
      if (parsedLine.kind !== 'beacon') throw new Error('unreachable')
      expect(parsedLine.payload.writer).toBe('gate')
      expect(parsedLine.payload.kind).toBe('gate.verdict')
      expect(parsedLine.payload.lane).toBe(h)
      // The collector attaches digest/file/offset once it tails a real
      // directory (ADR-0036) — supplied here as placeholders so the CLOSED
      // v1 fields validate; this issue prints the line, #274 writes it.
      const received = { ...parsedLine.payload, digest: '0'.repeat(64), file: 'gate.jsonl', offset: 0 }
      const result = beaconReceivedPayloadSchema.safeParse(received)
      expect(result.success, result.success ? '' : JSON.stringify(result.error?.issues)).toBe(true)
      // Extra keys (held/reason/outputDigest) are stripped by the closed
      // schema above (ADR-0036: "extra keys are ignored") but must still be
      // present in the RAW line the collector's digest actually covers.
      const raw = JSON.parse(line)
      expect(raw.held).toBe(true)
      expect(raw.reason).toBe('suite-red')
      expect(typeof raw.outputDigest).toBe('string')
    })

    /**
     * prd17 w5 (#274) — the SAME verdict line also has to reach `gate.jsonl`
     * in the beacon directory (ADR-0036), not only stdout. Every fixture
     * above runs `VERDICT_MACHINERY` with no `root` set at all, so every one
     * of them takes the "could not resolve the beacon directory" branch —
     * none of them ever reaches the write. That gap is the reason this
     * describe block exists: it is the only place in this file that sets
     * `root` to something real (`REPO_ROOT`, so that
     * `$root/node_modules/.bin/tsx` exists and can evaluate
     * `beaconDirFor()` from `packages/server/src/collectors/beacon/
     * paths.ts`) and points `RHIZOMORPH_DATA_DIR` at a scratch directory, so
     * the write lands somewhere disposable rather than a developer's real
     * `~/.local/share/rhizomorph`.
     *
     * `beaconDirFor` is imported directly (the real function, not a
     * restatement of its hash-and-join) to compute the expected path in
     * each assertion below — the same "reuse, never reimplement" rule this
     * file holds every other fixture to.
     */
    describe('prd17 w5 (#274) — the same verdict line also reaches gate.jsonl in the beacon directory', () => {
      /** `root=$REPO_ROOT` (so `$root/node_modules/.bin/tsx` resolves, and with it the real module) and `RHIZOMORPH_DATA_DIR` pointed at a scratch dir (so the write never touches a real machine's data root) — both absent from `runVerdict` above by design. */
      function runVerdictWithBeacon(setup: string, dataRoot: string): FragmentResult & { h: string } {
        const h = `verdict-beacon-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nH=${h}\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${dataRoot}"\n` +
          `${VERDICT_MACHINERY}\n${setup}\n`
        // cwd is REPO_ROOT for tidiness only — it is NOT what makes the
        // resolution work, and this comment used to say it was (review of
        // #274, round 3). That justification described the mechanism the
        // round-2 repair removed: `npx --no-install tsx` resolved its binary
        // by walking UP from cwd through node_modules, so a scratch cwd
        // broke it. The machinery now invokes `$root/node_modules/.bin/tsx`
        // by absolute path, and cwd never participates. EXECUTED from a
        // scratch directory with no node_modules above it: the same beacon
        // directory, rc=0, identical to the CONTROL run from REPO_ROOT.
        // What the fixture actually needs is `root`, set above.
        const res = runFragment(script, REPO_ROOT)
        return { ...res, h }
      }

      it('EXECUTED — a fresh data root (no beacons/ directory yet) gets one created, and gate.jsonl holds byte-for-byte the same line just printed', () => {
        const dataRoot = scratchDir('beacon-fresh')
        const beaconDir = beaconDirFor(REPO_ROOT, dataRoot)
        expect(existsSync(beaconDir), 'test setup: the directory must be genuinely absent for this to be the fresh-install case ADR-0036 names').toBe(false)

        const { stdout, status } = runVerdictWithBeacon('echo "  build OK"\nMERGED=1\nemit_gate_verdict clean', dataRoot)
        expect(status).toBe(0)
        const printed = lastLine(stdout)
        expect(JSON.parse(printed)).toMatchObject({ v: 1, writer: 'gate', kind: 'gate.verdict', held: false, reason: 'clean' })

        const beaconFile = join(beaconDir, 'gate.jsonl')
        expect(existsSync(beaconFile), 'gate.jsonl must exist after a landing — the directory-creation step must have run').toBe(true)
        // Byte-for-byte, not "parses to the same object": the whole design
        // decision (captured once into `verdict_line`, never re-derived by a
        // second python3 call) is that stdout and the beacon file carry the
        // IDENTICAL bytes, not merely equivalent JSON.
        expect(readFileSync(beaconFile, 'utf8')).toBe(`${printed}\n`)
      })

      it('EXECUTED — a held (pre-merge fail) verdict reaches gate.jsonl too, not only a clean landing', () => {
        const dataRoot = scratchDir('beacon-held')
        const beaconDir = beaconDirFor(REPO_ROOT, dataRoot)
        const { stdout } = runVerdictWithBeacon('fail "boom" suite-red', dataRoot)
        const printed = lastLine(stdout)
        expect(JSON.parse(printed)).toMatchObject({ held: true, reason: 'suite-red' })
        expect(readFileSync(join(beaconDir, 'gate.jsonl'), 'utf8')).toBe(`${printed}\n`)
      })

      it('EXECUTED — a second landing appends a second line rather than rewriting the first', () => {
        const dataRoot = scratchDir('beacon-append')
        const first = lastLine(runVerdictWithBeacon('fail "first" suite-red', dataRoot).stdout)
        const second = lastLine(runVerdictWithBeacon('fail "second" typecheck-red', dataRoot).stdout)
        const contents = readFileSync(join(beaconDirFor(REPO_ROOT, dataRoot), 'gate.jsonl'), 'utf8')
        expect(contents).toBe(`${first}\n${second}\n`)
      })

      /**
       * Review of #274, round 2 (MEASURED): `npx --no-install tsx` does NOT
       * fail fast when the package is unresolvable — it falls back to a
       * REGISTRY LOOKUP first, measured at 70s against a connection-refused
       * registry and still running past five minutes against a
       * black-holed one. Reachable twice in this script: root's own
       * `node_modules` may not exist yet on a fresh checkout (root's
       * install runs AFTER the merge), and `install-broken` correlates with
       * exactly the offline operator `push_or_warn`'s own exemption exists
       * for. The fix is invoking the resolved binary directly, which never
       * touches npm's resolver at all — proven structurally rather than by
       * actually waiting out a black-holed registry in the suite, and
       * proven as a PROPERTY (one permitted executable) rather than as a
       * banned token, because `npx` is only one spelling of the defect.
       */
      it('the ONLY program this machinery invokes is the resolved tsx binary — a launcher of any spelling fails here', () => {
        // CODE lines only — this very test, and the fix's own commit
        // message, both say "npx" in prose explaining why it must not be
        // used; the claim is about what RUNS, not what is discussed.
        const code = VERDICT_MACHINERY.split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n')

        // AN ALLOW-LIST OF ONE, not a deny-list of spellings (review of
        // #274, round 3). This assertion used to be `.not.toMatch(/\bnpx\b/)`,
        // which pins a TOKEN rather than the property that was measured:
        // "does not go through npm's own resolver". `npx` IS a wrapper over
        // `npm exec`, so `npm exec --offline --yes -- tsx` slips that regex
        // and hangs identically — MEASURED against a connection-refused
        // registry from a directory with no node_modules, both `npx
        // --no-install tsx` and `npm exec -- tsx` were still running at 45s
        // where the resolved binary took 307ms, and the old assertion
        // stayed GREEN through that mutation (211 passed, control and
        // mutant alike). Naming the one acceptable executable closes the
        // class instead: every launcher spelling, enumerated or not, puts a
        // different word in this position.
        // A COMMAND pin, not a SUFFIX pin (round 3 re-review, finding 4). An
        // earlier draft captured only the token adjacent to `-e`, which
        // catches a launcher that REPLACES the binary and misses one that
        // PREFIXES it: `npx --no-install "$root/node_modules/.bin/tsx" -e`
        // passed. Measured, that prefixed form does not actually reach the
        // registry (0.40s rc=0 against a refused registry, against 0.30s for
        // the bare binary), so the exposure was nil and the CLAIM was the
        // defect — but a pin whose stated property is "the only program this
        // machinery invokes" must hold the whole command word, so it now
        // anchors at the start of the invocation line.
        //
        // A LOGICAL line, not a physical one (review of #310, EXECUTED). That
        // anchor is still a position pin, and a `\\` continuation moves the
        // command word onto a DIFFERENT physical line from the `-e` it is
        // anchored to — so a launcher prefixing the binary from the line above
        // slips it exactly as the suffix pin was slipped:
        //   beacon_dir=$(REPO_PATH=... MODULE_PATH=... npx --no-install \\
        //     "$root/node_modules/.bin/tsx" -e '
        // PROBE: that mutation, applied to the real committed scripts/gate.sh
        // with the line count left unchanged so the producer-citation law
        // could not mask it, left this whole file GREEN — 215/215.
        //
        // This is the THIRD spelling of one defect: round 3 pinned the token
        // adjacent to `-e`, round 4 pinned the start of its physical line, and
        // each fix left one position a launcher can still occupy. So the pin
        // stops asking WHERE the program sits. Continuations are joined first,
        // then the command substitution's opener and every leading `VAR=value`
        // environment assignment — which are not a command word — are
        // stripped, and what remains BEGINS with the program that actually
        // runs, wherever the author chooses to break the line.
        const invocation = VERDICT_MACHINERY.split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n')
          .replace(/\\\n\s*/g, ' ')
          .split('\n')
          .filter((l) => /\s-e\b/.test(l))
        expect(
          invocation.map((l) => l.trim()),
          'the pin is vacuous if the invocation cannot be found at all — renaming or reshaping it must fail here rather than pass silently',
        ).toHaveLength(1)
        // `\w+=$(` is the command substitution's own opener, not an argument.
        const command = invocation[0]!
          .trim()
          .replace(/^\w+=\$\(\s*/, '')
          .replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
        expect(
          command,
          'a plain `npx tsx` was MEASURED to hang past five minutes against a black-holed registry when tsx is unresolvable locally, and `npm exec -- tsx` does the same. The resolved binary never reaches the npm resolver, and it is the only thing that may run here — as the whole command, on whatever physical line it is written, not merely as the word before `-e`.',
        ).toMatch(/^"\$root\/node_modules\/\.bin\/tsx" -e\b/)
        expect(
          code,
          'the binary must be existence-checked before being invoked, or a missing one fails as "command not found" instead of the reported warning',
        ).toMatch(/-x\s+"\$\{root:-\}\/node_modules\/\.bin\/tsx"/)
      })

      /**
       * Review of #274, round 3 (EXECUTED). The comment above the python3
       * block claims check, repair and write are "one critical section".
       * They were not: Python's buffered writer flushes at close(), which
       * the `with` block runs AFTER `fcntl.flock(f, LOCK_UN)`, so the bytes
       * left the buffer outside the lock the comment says they are inside.
       * Instrumented at the unlock point, bytes-on-disk was 0 as committed
       * and 31 with an explicit flush; widening the unlock-to-close window
       * to 300ms gave two concurrent writers a spurious blank line, which
       * `parse-beacon-line` refuses and the collector reports as a
       * malformed line.
       *
       * This is pinned STRUCTURALLY, by order. The behavioural form needs
       * the unlock point instrumented from inside the interpreter — which
       * is how the review measured it, and is not something the suite can
       * observe from outside a one-shot `python3 -c`. What the suite CAN
       * guarantee is that nobody removes the flush or moves it after the
       * unlock, which is the only way the defect returns.
       */
      it('the beacon append flushes INSIDE the lock — write, then flush, then unlock, in that order', () => {
        // Matched as STATEMENTS, anchored at the start of each line, never as
        // substrings (round 3 re-review, finding 3). The earlier draft
        // searched the comment-filtered text with `indexOf`, and that filter
        // is line-leading only — but these tokens live inside an embedded
        // Python script, where a TRAILING `#` comment is ordinary. PROBE:
        // deleting the real `f.flush()` and leaving
        // `f.write(line.encode() + b"\\n")  # close() covers this` passed
        // GREEN with the flush genuinely gone from the executed python.
        // CONTROL: the same deletion without the comment reddened. Anchoring
        // at `^` means a mention can never stand in for a statement.
        const py = VERDICT_MACHINERY.split('\n').map((l) => l.trim())
        const write = py.findIndex((l) => /^f\.write\(line\.encode\(\)/.test(l))
        const flush = py.findIndex((l) => /^f\.flush\(\)\s*(#.*)?$/.test(l))
        const unlock = py.findIndex((l) => /^fcntl\.flock\(f, fcntl\.LOCK_UN\)/.test(l))

        expect(write, 'the append itself must be findable as a statement, or this test pins nothing').toBeGreaterThan(-1)
        expect(flush, 'without an explicit flush STATEMENT the bytes reach the file at close(), after the unlock — a comment naming f.flush() is not one').toBeGreaterThan(-1)
        expect(unlock, 'the unlock must be findable as a statement, or the ordering claim below is vacuous').toBeGreaterThan(-1)

        expect(flush, 'the flush must come AFTER the append — flushing first flushes nothing').toBeGreaterThan(write)
        expect(flush, 'the flush must come BEFORE the unlock, or the write is outside the critical section the comment claims it is inside').toBeLessThan(unlock)
      })

      /**
       * Review of #274, round 3. A citation by OFFSET rots by construction:
       * this script carried "this function's own comment 110 lines up",
       * which was 133 lines up by the time anyone counted it, and would
       * have been wrong again after the very edit that fixed it. AGENTS.md
       * already states the rule for CI citations — "cite by job and step
       * name, never by line number" — and records that the same class of
       * pointer rotted twice there, once drifting BACK into correctness,
       * which is the worse failure because spot-checking it says "fine".
       *
       * Scoped to gate.sh as a whole rather than to the machinery slice:
       * the defect is a property of prose in this file, and the slice
       * boundaries are not where a future author will happen to write one.
       *
       * WHAT THIS LAW DOES NOT COVER, stated because an unbounded claim over
       * a bounded check is the defect this file exists to catch (round 3
       * re-review, findings 2 and 5). The first draft of this test was named
       * "cites another line by OFFSET" while checking one spelling of it. A
       * PROBE appended eight forms and the law stayed green on every one:
       * `gate.sh:156`, `line 156`, `lines 156-165`, `110 lines further up`,
       * `12 lines prior`, `a dozen lines above`, `three lines below`,
       * `~24 lines back`. CONTROL: the certified `N lines up` spelling
       * reddens and names the line and its text, so the harness is sound.
       *
       * Two of those forms are LIVE in this file today, and both predate
       * this branch (byte-identical at `d804b5a`): absolute `:NNN` citations
       * at `:354` (`:41`), `:359` (`:116`), `:440` (`:142`), `:465` (`:96`)
       * and `:472` (`:74-80`) — every one now landing on an unrelated
       * comment line — and a spelled-out offset, "eighteen lines further
       * down", at `:440`. They are recorded rather than swept in here: this
       * commit is answering a review of #274, and re-deriving five
       * pre-existing citations is its own change with its own reasoning.
       * Filed as #306; do not widen this regex without fixing them in the
       * same edit, because a law that ships red is a law that gets skipped.
       *
       * So the name and the message below say the one form this actually
       * holds. A bounded true claim beats an unbounded one that needs a
       * round per counter-example.
       */
      it('no COMMENT in scripts/gate.sh cites another line in the `N lines up/down` form — that one spelling, checked', () => {
        // Comment lines only. The earlier draft scanned every line while its
        // own name said "comment", so a CODE line containing the phrase
        // reddened it (PROBE: `echo "… 3 lines below the threshold"`). It
        // failed closed, but on the wrong subject.
        const offsets = LINES.map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => line.trim().startsWith('#'))
          .filter(({ line }) => /\b\d+\s+lines?\s+(up|down|above|below|earlier|later|further|back|prior)\b/i.test(line))
        expect(
          offsets.map(({ n, line }) => `${n}: ${line.trim()}`),
          'quote the sentence being cited instead — it is greppable and survives the file moving, which an offset is not',
        ).toEqual([])
      })

      /**
       * Review of #274, round 2 (MEASURED): `import()` takes a MODULE
       * SPECIFIER, which Node parses as a URL, not a filesystem path — a
       * repo path containing a tab, LF, CR, `#` or `?` resolved to the
       * wrong module or ERR_MODULE_NOT_FOUND, and one containing `%` threw
       * a URIError. Every one of them took the "could not resolve" branch
       * and wrote nothing, silently. `#` is exercised here (the character
       * this filesystem can hold in a plain directory name without any
       * escaping tricks): a symlink whose OWN name carries the special
       * character, pointing at the real repo, stands in for "the checkout
       * lives at a path like this" without needing a second copy of
       * packages/server on disk.
       */
      it('EXECUTED — a repo path containing `#` still resolves the beacon directory (pathToFileURL, not a bare-path import)', () => {
        const linkParent = scratchDir('beacon-hash-path')
        const specialRoot = join(linkParent, 'repo#with#hash')
        symlinkSync(REPO_ROOT, specialRoot, 'dir')
        const dataRoot = scratchDir('beacon-hash-dataroot')
        const h = `verdict-hash-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nH=${h}\nroot="${specialRoot}"\nexport RHIZOMORPH_DATA_DIR="${dataRoot}"\n` +
          `${VERDICT_MACHINERY}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        // cwd stays REPO_ROOT — again for tidiness, not for resolution (see
        // the note in runVerdictWithBeacon). `root` is the symlink whose own
        // name carries the special character, and it is what both
        // `$root/node_modules/.bin/tsx` and MODULE_PATH are built from.
        const res = runFragment(script, REPO_ROOT)
        expect(res.status).toBe(0)
        const printed = lastLine(res.stdout)
        const beaconDir = beaconDirFor(specialRoot, dataRoot)
        const beaconFile = join(beaconDir, 'gate.jsonl')
        expect(
          existsSync(beaconFile),
          'a bare (non-URL-encoded) path import takes the "could not resolve" branch on this path and writes nothing — this must exist',
        ).toBe(true)
        expect(readFileSync(beaconFile, 'utf8')).toBe(`${printed}\n`)
      })

      /**
       * Review of #274, round 2 (EXECUTED): a full-disk or otherwise
       * interrupted append can leave a PARTIAL line with no trailing
       * newline. A plain `>>` on the NEXT ordinary landing concatenates
       * directly onto that prefix — one unparseable "line" that costs the
       * collector BOTH verdicts, the failed one and the good one right
       * after it. The fix repairs the missing newline before appending its
       * own line, so the leftover partial content is isolated onto its own
       * (still genuinely malformed, but no longer contagious) line.
       */
      it('EXECUTED — a landing after an interrupted (no-trailing-newline) previous write gets its own line, not fused onto the leftover partial one', () => {
        const dataRoot = scratchDir('beacon-torn-write')
        const beaconDir = beaconDirFor(REPO_ROOT, dataRoot)
        mkdirSync(beaconDir, { recursive: true })
        // No trailing newline — simulates a write interrupted mid-append.
        writeFileSync(join(beaconDir, 'gate.jsonl'), '{"v":1,"partial":true')

        const { stdout } = runVerdictWithBeacon('echo "  build OK"\nMERGED=1\nemit_gate_verdict clean', dataRoot)
        const printed = lastLine(stdout)
        const contents = readFileSync(join(beaconDir, 'gate.jsonl'), 'utf8')
        const lines = contents.split('\n').filter((l) => l.length > 0)
        expect(lines, "the leftover partial line and this landing's own line must both survive, on separate lines").toEqual(['{"v":1,"partial":true', printed])
        // The leftover line legitimately does not parse (it is genuinely
        // truncated JSON) — the point is that it no longer poisons the one
        // after it.
        expect(() => JSON.parse(lines[1]!)).not.toThrow()
      })

      it("MUTATION — removing the trailing-newline repair fuses a leftover partial write onto the next landing's line", () => {
        const repairCondition = 'if f.read(1) != b"\\n":'
        expect(VERDICT_MACHINERY, 'the real repair condition must still be present for this mutation to say anything').toContain(repairCondition)
        // `if False:` keeps the body (still indented beneath it) syntactically
        // valid while making sure it never runs — the newline repair simply
        // never happens.
        const noRepair = VERDICT_MACHINERY.replace(repairCondition, 'if False:')
        expect(noRepair).not.toBe(VERDICT_MACHINERY)

        const dataRoot = scratchDir('beacon-torn-write-mutation')
        const beaconDir = beaconDirFor(REPO_ROOT, dataRoot)
        mkdirSync(beaconDir, { recursive: true })
        writeFileSync(join(beaconDir, 'gate.jsonl'), '{"v":1,"partial":true')

        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nH=torn-mutant\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${dataRoot}"\n` +
          `${noRepair}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        const res = runFragment(script, REPO_ROOT)
        expect(res.status).toBe(0)

        const contents = readFileSync(join(beaconDir, 'gate.jsonl'), 'utf8')
        const lines = contents.split('\n').filter((l) => l.length > 0)
        // The control (the EXECUTED test above, unmutated) produces TWO
        // separately parseable lines. Under this mutation the partial
        // content and the new verdict fuse into ONE — the exact corruption
        // the review measured, costing the collector both.
        expect(lines).toHaveLength(1)
        expect(() => JSON.parse(lines[0]!)).toThrow()
      })

      /**
       * MUTATION 1 (the issue's own words): "make the write a no-op and
       * assert only that the gate still exits 0. That passes." Proven here
       * against the REAL extracted machinery with one line mutated, so the
       * fixture is exercising the actual defect shape rather than an
       * imagined one — and the test above it is what the mutation reddens.
       */
      it('MUTATION — a no-op write still exits 0; only reading gate.jsonl back catches it', () => {
        const appendStatement = 'f.write(line.encode() + b"\\n")'
        expect(VERDICT_MACHINERY, 'the real write statement must still be present for this mutation to say anything').toContain(appendStatement)
        // `pass`, a python no-op with the same indentation the statement it
        // replaces already had — the write simply never happens, and the
        // surrounding lock/flush/close still run normally.
        const noop = VERDICT_MACHINERY.replace(appendStatement, 'pass')
        expect(noop).not.toBe(VERDICT_MACHINERY)

        const dataRoot = scratchDir('beacon-noop-mutation')
        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nH=noop-mutant\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${dataRoot}"\n` +
          `${noop}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        const res = runFragment(script, REPO_ROOT)
        // The weak assertion — exactly what the issue warns is insufficient.
        expect(res.status, 'a no-op write must not be fatal — this alone is not proof the write happened').toBe(0)
        // The assertion that actually catches it: `open(path, "a+b")` alone
        // already creates an empty file, so EXISTENCE is not enough either
        // (that would just be a second exit-status-shaped check) — only
        // reading the CONTENT back and finding it empty (never mind
        // matching the printed line) proves nothing was appended.
        const beaconFile = join(beaconDirFor(REPO_ROOT, dataRoot), 'gate.jsonl')
        expect(existsSync(beaconFile), 'a no-op write still leaves an empty file behind — that is not the same claim as "nothing happened"').toBe(true)
        expect(readFileSync(beaconFile, 'utf8'), 'the mutation deleted the write — exit-status-only (or existence-only) coverage is blind to this').toBe('')
      })

      /**
       * MUTATION 2 (the issue's own words): "delete the directory-creation
       * step. On a machine that has run the instrument before, the directory
       * already exists and every test stays green — so the test has to run
       * against a data root that does not have one yet." Both halves proven
       * here: the SAME mutation is invisible on a warm data root and fatal
       * to the write on a genuinely fresh one.
       */
      it('MUTATION — deleting mkdir passes on a machine that already has the directory, and only reddens against a genuinely fresh data root', () => {
        const mkdirStatement = 'os.makedirs(beacon_dir, exist_ok=True)'
        expect(VERDICT_MACHINERY, 'the real makedirs statement must still be present for this mutation to say anything').toContain(mkdirStatement)
        // `pass` models "directory creation removed but nothing complains" —
        // `open(path, "a+b")` still succeeds as long as the directory it
        // sits in already exists.
        const noMkdir = VERDICT_MACHINERY.replace(mkdirStatement, 'pass')
        expect(noMkdir).not.toBe(VERDICT_MACHINERY)

        // Warm: the directory already exists (a machine that ran the
        // instrument before) — the mutation is INVISIBLE here, which is
        // exactly the trap the issue names.
        const warmDataRoot = scratchDir('beacon-mkdir-mutation-warm')
        const warmBeaconDir = beaconDirFor(REPO_ROOT, warmDataRoot)
        mkdirSync(warmBeaconDir, { recursive: true })
        const warmScript =
          `#!/bin/bash\n${SHELL_OPTS}\nH=mkdir-mutant-warm\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${warmDataRoot}"\n` +
          `${noMkdir}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        const warmRes = runFragment(warmScript, REPO_ROOT)
        expect(warmRes.status).toBe(0)
        expect(existsSync(join(warmBeaconDir, 'gate.jsonl')), 'on a warm machine the mutation is invisible — this is the trap the issue names, not a bug in this test').toBe(true)

        // Fresh: no pre-existing directory. The SAME mutation now leaves the
        // write with nowhere to append to.
        const freshDataRoot = scratchDir('beacon-mkdir-mutation-fresh')
        const freshBeaconDir = beaconDirFor(REPO_ROOT, freshDataRoot)
        expect(existsSync(freshBeaconDir)).toBe(false)
        const freshScript =
          `#!/bin/bash\n${SHELL_OPTS}\nH=mkdir-mutant-fresh\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${freshDataRoot}"\n` +
          `${noMkdir}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        const freshRes = runFragment(freshScript, REPO_ROOT)
        expect(freshRes.status, 'the write staying non-fatal is correct even under this mutation — the DoD asks for that much').toBe(0)
        expect(existsSync(join(freshBeaconDir, 'gate.jsonl')), 'without directory creation, a genuinely fresh data root must show the beacon missing').toBe(false)
      })

      /**
       * A third mutation, not named by the issue but the direct converse of
       * the "same bytes, never re-derived" design decision this file's own
       * comments make: if the append line diverged from the printed line —
       * a stray extra call, a re-serialised copy, a differently-escaped
       * `$verdict_line` — nothing above catches it unless the comparison is
       * BYTE-FOR-BYTE. Proven by planting exactly that divergence.
       */
      it('MUTATION — an append that writes something OTHER than the printed line reddens the byte-for-byte check', () => {
        const appendStatement = 'f.write(line.encode() + b"\\n")'
        expect(VERDICT_MACHINERY).toContain(appendStatement)
        // Double-quote delimited, internal quotes escaped — NOT a single-
        // quoted python literal. The whole python script is itself embedded
        // in one bash single-quoted string (`python3 -c '...'`), and bash
        // single quotes cannot be escaped or nested: a bare `'` inside this
        // replacement would close that string early and corrupt the
        // surrounding shell syntax (EXECUTED: the first version of this
        // mutation did exactly that and left gate.sh unable to even create
        // the directory).
        const diverged = VERDICT_MACHINERY.replace(
          appendStatement,
          String.raw`f.write(b"{\"v\":1,\"writer\":\"gate\",\"kind\":\"gate.verdict\",\"mutated\":true}\n")`,
        )
        expect(diverged).not.toBe(VERDICT_MACHINERY)

        const dataRoot = scratchDir('beacon-divergent-mutation')
        const script =
          `#!/bin/bash\n${SHELL_OPTS}\nH=divergent-mutant\nroot="${REPO_ROOT}"\nexport RHIZOMORPH_DATA_DIR="${dataRoot}"\n` +
          `${diverged}\necho "  build OK"\nMERGED=1\nemit_gate_verdict clean\n`
        const res = runFragment(script, REPO_ROOT)
        expect(res.status).toBe(0)
        const printed = lastLine(res.stdout)
        const written = readFileSync(join(beaconDirFor(REPO_ROOT, dataRoot), 'gate.jsonl'), 'utf8')
        // A schema-shape or "it parses" check would pass here too — `written`
        // is valid, v1-shaped JSON. Only the exact-bytes comparison the real
        // test above makes tells them apart.
        expect(written).not.toBe(`${printed}\n`)
      })
    })
  })

  /**
   * prd17 w7 (#293) — `$3` (LOAD) is OPERATOR INPUT and, before this, reached
   * no check of its own: a bare typo (`abc`) already aborted loudly (bash's
   * own `set -u` unbound-variable trap on the load gate's `$((LOAD*4))`), but
   * `3.0`, `3x`, `-1`, `007`/`010` and a transposed fence argument
   * (`gate.sh 273 3 '^scripts/'`) are all ARITHMETIC-SYNTAX-SAFE or
   * schema-unsafe in ways that stay silent until `emit_gate_verdict`'s own
   * `int(load)` — many lines and a full suite run later — raises under its
   * `2>/dev/null` and the landing emits NO VERDICT LINE AT ALL. Reviewed and
   * reverted once already at the emitter itself (round 2 of #273's review):
   * that fix guarded the one input (`abc`) that never reaches it while
   * regressing one that does (`+3` was recorded as no load at all). Fixed
   * instead where `$3` is FIRST used, right after `GATE_OUTFILE`/the tee are
   * wired up so a refusal can still emit a verdict.
   *
   * The input class, extracted before the fix rather than restated after it:
   *
   * | spelling                  | example     | int() | schema (`nonnegative`) | arithmetic below (`$((LOAD*4))`) | verdict |
   * |----------------------------|-------------|-------|--------------------------|-----------------------------------|---------|
   * | default / bare zero        | `0`         | ok    | n/a (omitted, `!= "0"`)  | ok                                 | accept |
   * | bare positive               | `3`         | ok    | ok                       | ok                                 | accept |
   * | `+`-prefixed                | `+3`        | ok    | ok                       | ok                                 | accept, canonicalised to `3` |
   * | non-numeric                 | `abc`       | raises| —                        | ALREADY aborts loudly (unbound var)| refuse (now earlier, WITH a verdict) |
   * | transposed fence argument   | `^scripts/` | raises| —                        | non-fatal SYNTAX error, swallowed  | refuse |
   * | decimal                     | `3.0`       | raises| —                        | non-fatal SYNTAX error, swallowed  | refuse |
   * | trailing garbage            | `3x`        | raises| —                        | non-fatal SYNTAX error, swallowed  | refuse |
   * | negative                    | `-1`        | ok    | REFUSED                  | ok (but the schema already refuses)| refuse |
   * | leading zero                | `007`,`010` | ok    | ok (would be `7`/`10`)   | reads as OCTAL — same bug class as this file's own `$PREV` ratchet | refuse |
   * | oversized                   | `99999999999999999999` | ok | ok (huge, but valid) | SILENTLY OVERFLOWS (rc=0, wrong number) — and `seq 1 "$LOAD"` must materialise the whole list before the loop starts: a landing may fail, it may not hang | refuse (bounded at 64, by STRING LENGTH first — comparing this numeral with `[ -gt ]` directly errors "integer expected" on bash 5.3+, "integer expression expected" on 5.2 and earlier) |
   * | omitted / explicit empty   | (no `$3`), `''` | n/a (never reached) | n/a | n/a | `${3:-0}` — gate.sh's own argv line — defaults BOTH to `"0"` before this validation ever runs. Not a "refuse" case at all: review found a prior version of this test asserted `''` reaches `load-invalid`, which required bypassing `${3:-0}` in the test harness — a claim the real script never makes |
   *
   * What mutation would this test survive? Validating only `abc` — the one
   * spelling that already failed loudly — while leaving every other row
   * falling through silently, INCLUDING the oversized row (a magnitude bound
   * is a different property from a syntax bound, and neither implies the
   * other). Each row below is exercised, through the REAL `H=$1; FENCE=$2;
   * LOAD=${3:-0}` argv line — not a harness that assigns `LOAD` directly and
   * so never actually exercises that line's own defaulting behaviour.
   */
  describe('prd17 w7 (#293) — $3 (load-batches) is validated once, before anything else runs, never at the emitter', () => {
    const VERDICT_MACHINERY = sliceLines('MERGED=0', 'GATE_TEE_PID=$!')
    const LOAD_VALIDATION = sliceLines('LOAD_RAW=$LOAD', 'from the numeric value int() sees.')
    /** The REAL argv line, extracted rather than re-typed — see the harness below for why this matters (review finding: a prior harness bypassed it entirely). */
    const ARGV_LOAD_LINE = extractLine('H=$1; FENCE=$2; LOAD=${3:-0}')

    /** The REAL extraction, from the current source — not a retyped copy. If this ever needs re-anchoring, the extraction failing loudly (see sliceLines) is itself proof the law is reading the live script. */
    it('the extraction actually found the validation, not an empty slice', () => {
      expect(LOAD_VALIDATION).toContain('case "$LOAD_DIGITS" in')
      expect(LOAD_VALIDATION).toContain('load-invalid')
    })

    /**
     * Runs the REAL argv-parsing line via actual positional parameters,
     * never a direct `LOAD=` assignment (review finding, both seats: the
     * prior harness set `LOAD` directly, bypassing `${3:-0}` — bash's own
     * rule that a MISSING $3 and an EXPLICIT EMPTY $3 both default to "0",
     * unconditionally, before this validation ever runs. A harness that
     * skips this line can assert behaviour for `LOAD=''` that the real
     * script can never produce, which is exactly what the previous version
     * of this test did — a claim untethered from the code it names).
     *
     * `loadArg === undefined` omits $3 entirely (two positional params, not
     * three); `''` passes it explicitly empty; anything else passes it
     * verbatim. All three go through the SAME real line as production.
     */
    function runLoadValidation(loadArg: string | undefined): FragmentResult & { dir: string; h: string } {
      const dir = scratchDir('load-validate')
      const h = `load-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const argv = loadArg === undefined ? [`'${h}'`, `'^fence$'`] : [`'${h}'`, `'^fence$'`, `'${loadArg}'`]
      const script = `#!/bin/bash\n${SHELL_OPTS}\nset -- ${argv.join(' ')}\n${ARGV_LOAD_LINE}\n${VERDICT_MACHINERY}\n${LOAD_VALIDATION}\necho "LOAD_AFTER=$LOAD"\n`
      const res = runFragment(script, dir)
      return { ...res, dir, h }
    }

    it('EXECUTED — the accepted spellings pass through, canonicalised to the string int() would parse', () => {
      expect(runLoadValidation('0').stdout).toContain('LOAD_AFTER=0')
      expect(runLoadValidation('3').stdout).toContain('LOAD_AFTER=3')
      expect(runLoadValidation('+3').stdout, "int('+3') == 3, the same count as '3' — every downstream comparison ($((LOAD*4)), seq, != \"0\") must see the same string").toContain('LOAD_AFTER=3')
      expect(runLoadValidation('64').stdout, 'the 64-batch ceiling is INCLUSIVE — 64 itself must still be accepted, not just values below it').toContain('LOAD_AFTER=64')
    })

    /**
     * REVIEW FINDING (both seats): `./scripts/gate.sh <handle> '^$' ''`
     * produces a normal `setup` verdict, never `load-invalid`, because
     * `${3:-0}` zeroes an explicit empty argument before validation runs —
     * and an OMITTED argument takes the identical path. This is not a defect
     * in the validation; it is `${3:-0}`'s own, pre-existing, unconditional
     * rule (bash's `:-` triggers on unset OR empty). Documented directly
     * rather than asserted the other way, which is what the earlier version
     * of this test did by never exercising this line at all.
     */
    it('EXECUTED — an omitted $3 and an explicit empty one both default to 0 via the REAL ${3:-0} line, identically', () => {
      expect(runLoadValidation(undefined).stdout, 'omitted $3 (only two positional params)').toContain('LOAD_AFTER=0')
      expect(runLoadValidation('').stdout, 'explicit empty $3 — must behave IDENTICALLY to omitted, per bash\'s own `:-` rule').toContain('LOAD_AFTER=0')
    })

    /**
     * EVERY OTHER ROW OF THE TABLE ABOVE, refused with a verdict rather than
     * falling through. `held` must be `true` (this refusal is pre-merge).
     * Includes the oversized rows (review finding: a magnitude bound is a
     * different property from a syntax bound — a fix for one does not imply
     * the other, and both must be exercised).
     *
     * The `loadBatches` field is checked against the REAL, imported
     * `gateVerdictPayloadSchema`'s own sub-schema for it — not the whole
     * envelope: the shell emitter's other field names (`lane`, `outputDigest`)
     * do not yet match the schema's (`handle`, `digest`) at all, a
     * pre-existing gap this issue does not touch (the issue's own text: the
     * schema "refuses the emitted shape today anyway... the blast radius
     * until #274 is a record with no consumer"). What #293 owns is narrower
     * and exactly what the sibling case names: `loadBatches` itself must
     * round-trip, which for a refused LOAD means being ABSENT, not `-1` or
     * any other out-of-band sentinel.
     */
    it('EXECUTED — every other spelling in the table above is refused, loudly, with a verdict whose loadBatches field is schema-valid', () => {
      for (const bad of ['-1', '3.0', '3x', '^scripts/', 'abc', '007', '010', '65', '100', '99999999999999999999']) {
        const { stdout, status } = runLoadValidation(bad)
        expect(status, `'${bad}' must hold the gate`).toBe(1)
        expect(stdout, `'${bad}' must print GATE FAILED`).toContain('GATE FAILED:')
        const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'))
        expect(lines, `'${bad}' must emit exactly one verdict line, not zero and not two`).toHaveLength(1)
        const parsed = JSON.parse(lines[0]!)
        expect(parsed.reason, `'${bad}' must be categorised as load-invalid, not lost or miscategorised`).toBe('load-invalid')
        expect(parsed.held, 'this refusal happens before the merge').toBe(true)
        const result = gateVerdictPayloadSchema.shape.loadBatches.safeParse(parsed.loadBatches)
        expect(result.success, `'${bad}'\'s loadBatches must satisfy the REAL schema field: ${result.success ? '' : JSON.stringify(result.error?.issues)}`).toBe(true)
        expect(parsed.loadBatches, 'a refused LOAD is reset before the emitter runs — it must never itself appear as a loadBatches count').toBeUndefined()
      }
    })

    /**
     * MUTATION — proves the length-first bound is load-bearing, not the
     * arithmetic comparison alone: an oversized numeral run directly through
     * `[ -gt 64 ]` (skipping the string-length guard) errors "integer
     * expected" in bash itself — a DIFFERENT failure mode than the intended
     * `load-invalid` refusal, and one that would surface as a raw shell
     * error rather than a categorised verdict if the length guard were ever
     * removed.
     */
    it('EXECUTED — a bare arithmetic comparison on the oversized value errors in bash itself, which is exactly what the length-first guard avoids', () => {
      const res = spawnSync('bash', ['-c', 'set -uo pipefail; LOAD_DIGITS=99999999999999999999; [ "$LOAD_DIGITS" -gt 64 ]'], { encoding: 'utf8' })
      expect(res.status, 'the bare comparison does not cleanly return 0 or 1').not.toBe(0)
      expect(res.status).not.toBe(1)
      // The WORDING of this diagnostic is bash's, not ours, and it changed:
      // bash <= 5.2 says "integer expression expected", bash >= 5.3 says
      // "integer expected". Pinned to the 5.3 spelling this assertion passed
      // on the author's box and failed on all three CI legs — the first time
      // it had ever run anywhere else, because the lane branch had no PR.
      // Matched loosely enough to span both, and no looser: the negative
      // control (a stderr with neither phrase) still fails.
      expect(res.stderr, 'bash itself refuses to compare a numeral this large').toMatch(
        /integer (expression )?expected/,
      )
    })

    /**
     * THE DEFECT ITSELF, proven by REMOVING the fix: the real emitter
     * (VERDICT_MACHINERY, unmodified) called directly with an unvalidated bad
     * LOAD past the merge — the issue's own scenario, "a landing that merged
     * and pushed". `int(load)` raises inside python3, `2>/dev/null` swallows
     * the traceback, and NOTHING downstream can tell a verdict ever went
     * missing: the script's own exit status stays 0.
     */
    it('MUTATION — without this validation, a landing past the merge with a bad LOAD loses its verdict entirely, silently', () => {
      const dir = scratchDir('load-validate-mutation')
      const h = `load-mutant-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const script = `#!/bin/bash\n${SHELL_OPTS}\nH=${h}\n${VERDICT_MACHINERY}\nMERGED=1\necho "  build OK"\nLOAD='3.0'\nemit_gate_verdict clean\necho "REACHED_END"\n`
      const res = runFragment(script, dir)
      expect(res.status, 'emit_gate_verdict never calls fail() on its own — the script exits 0, which is exactly why this is dangerous').toBe(0)
      expect(res.stdout).toContain('REACHED_END')
      const beacons = res.stdout.split('\n').filter((l) => l.trim().startsWith('{'))
      expect(beacons, 'int(load) raising inside python3 on an unvalidated bad LOAD leaves NO verdict line at all — the defect this issue closes').toHaveLength(0)
    })

    it('load-invalid is a declared category, not a fresh spelling nobody reviewed', () => {
      const vocabLine = extractLine('GATE_VERDICT_VOCAB=')
      expect(vocabLine).toContain('load-invalid')
    })
  })
})
