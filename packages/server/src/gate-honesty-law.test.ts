import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

function preludeScript(mergedValue: 0 | 1, extraAssignments: string): string {
  return `#!/bin/bash\nset -uo pipefail\nH=t42\nMERGED=${mergedValue}\n${FAIL_BLOCK}\n${extraAssignments}\n`
}

interface FragmentResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs an assembled bash script and returns its outcome without throwing — a fail()'s exit 1 is an expected result here, not a test-harness error. Syntax-checks first, so a broken extraction fails with a clear parse error instead of a confusing runtime one. */
function runFragment(script: string, cwd: string): FragmentResult {
  execFileSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  try {
    const stdout = execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' })
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
   * Ruling 3: tolerances are DECLARED DATA, not exceptions buried in a
   * regex. This sweep covers exactly THREE idioms — `|| true`, a bare
   * `|| echo`, and a stderr-to-/dev/null redirect — and every CODE line
   * containing one of those three (comments excluded; this file's own doc
   * comments quote these idioms as prose, matching `no-personal-paths-law`'s
   * pattern of excluding its own rigged examples from its general sweep)
   * must be accounted for by an entry here.
   *
   * This is NOT a claim of completeness over every way a shell line can
   * swallow a failure. EXECUTED: `|| :`, `2>&-`, `>/dev/null 2>&1`,
   * `|| exit 0`, `; true`, a `set +e`/`set -e` pair, `if cmd; then :; fi`,
   * a backgrounded `cmd &`, and `|| { :; }` all pass this sweep silently —
   * `|| :` in particular is four characters from `|| true` with identical
   * semantics. Catching the general shape needs a structural rule (does a
   * `$(...)` assignment's very next line check its status?), not a longer
   * string list; that redesign is prd-46 #70's filed subject, not this
   * law's. What this sweep buys is narrower and still real: the three
   * idioms enumerated below cannot recur UNDECLARED in this file without
   * turning it red.
   *
   * The first version of this law swept only `|| true` and `|| echo` and
   * missed `2>/dev/null` entirely: it appeared 7 times in gate.sh, 5 of
   * them undeclared — including the timing-file discovery's own producer
   * (see the KNOWN GAP entry below), the same producer-swallowed-by-a-
   * process-substitution shape the NUL guard itself needed fixing for.
   * This law exists to hold the line on that shape, and it was live in the
   * file it governs while the law read green. An idiom with zero coverage
   * is worse than a regex that misses an edge case: it is "a tolerance
   * nobody can enumerate" (the issue's own words) by construction, and a
   * TENTH guard added later with `2>/dev/null` on its producer would have
   * passed in silence.
   *
   * A DECLARED entry is not a claim that the line is safe — it is a claim
   * that a human looked at it and can say why. `KNOWN GAP` marks the one
   * entry here that is NOT safe: :166-167's producer failure is real,
   * named in #42's own commit body as a ninth instance of the class this
   * issue fixes, and deliberately left for prd-45's stated successor
   * (ruling 1: "a fix that closes the enumerated set and not the class
   * earns this PRD a successor"). Declaring it here does not close it —
   * it means the NEXT unenumerated occurrence still reddens this law,
   * which is the property that matters.
   */
  const DECLARED_TOLERANCES = [
    { idiom: '|| true', needle: 'checkout -- package-lock.json 2>/dev/null || true', count: 2, reason: 'clean(): best-effort lockfile checkout; nothing to clean is not a check failure' },
    { idiom: '|| echo', needle: 'workmux rebase "$H" >/dev/null 2>&1 || echo', count: 1, reason: "workmux's exit code is not the check — ancestry is asserted separately right after" },
    { idiom: '|| echo', needle: 'git push origin main 2>&1 | tail -1 || echo', count: 1, reason: 'push_or_warn(): the one documented non-fatal check in the file (prd-39 ruling 1)' },
    { idiom: '2>/dev/null', needle: 'workmux path "$H" 2>/dev/null | tail -1', count: 1, reason: 'resolves $W; the very next line ([ -d "${W:-}" ] on :24) checks the result and falls back to a constructed path — the verdict is the existence check, not this redirect' },
    { idiom: '2>/dev/null', needle: 'checkout -- package-lock.json 2>/dev/null || true', count: 2, reason: 'the same two clean() lines declared above under `|| true` — they carry both idioms on one line' },
    { idiom: '2>/dev/null', needle: 'rev-parse --abbrev-ref HEAD 2>/dev/null) || fail', count: 1, reason: "stderr text is discarded, but the command's own exit code is still routed through fail() via ||" },
    { idiom: '2>/dev/null', needle: 'merge-base --is-ancestor main HEAD 2>/dev/null || fail', count: 1, reason: 'same — stderr discarded, exit code still routed through fail()' },
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
      idiom: '2>/dev/null',
      needle: "include='*.test.tsx' packages 2>/dev/null",
      count: 1,
      reason:
        "KNOWN GAP, dated 2026-08-25, not fixed by #42 — this producer's own exit status is never checked before its output feeds the process substitution at :166-167 (the same producer-swallowed-by-a-process-substitution shape the NUL guard itself needed fixing for). Named in #42's commit body as a real ninth instance, deliberately deferred to prd-45's stated successor rather than fixed under this issue's fence.",
    },
    { idiom: '2>/dev/null', needle: "find packages -name '*.bench.test.ts' 2>/dev/null", count: 1, reason: 'the second half of the same undeclared producer pair above; same deferral' },
  ] as const

  const DECLARED_IDIOMS = ['|| true', '|| echo', '2>/dev/null'] as const

  function codeLines(): string[] {
    return LINES.filter((l) => !l.trim().startsWith('#'))
  }

  it('every declared tolerance is present exactly where declared', () => {
    for (const t of DECLARED_TOLERANCES) {
      const hits = codeLines().filter((l) => l.includes(t.needle))
      expect(hits.length, `expected ${t.count} occurrence(s) of ${JSON.stringify(t.needle)} (${t.reason}), found ${hits.length}`).toBe(t.count)
    }
  })

  it.each(DECLARED_IDIOMS)('no OTHER code line swallows a failure via "%s" — every occurrence is one of the entries declared above', (idiom) => {
    const allLines = codeLines().filter((l) => l.includes(idiom))
    const declaredForIdiom = DECLARED_TOLERANCES.filter((t) => t.idiom === idiom)
    const undeclared = allLines.filter((line) => !declaredForIdiom.some((t) => line.includes(t.needle)))
    expect(undeclared, `undeclared "${idiom}" occurrence(s) in ${GATE_PATH} — a new one must be added to DECLARED_TOLERANCES with a reason, not silently allowed`).toEqual([])
  })

  it('the idiom sweep itself is not vacuous — a line rigged with each idiom is actually caught', () => {
    for (const idiom of DECLARED_IDIOMS) {
      const declaredForIdiom = DECLARED_TOLERANCES.filter((t) => t.idiom === idiom)
      const rigged = `some_new_guard_command ${idiom}`
      expect(declaredForIdiom.some((t) => rigged.includes(t.needle))).toBe(false)
    }
  })

  /**
   * This sweep's doc comment above says, in words, that coverage stops at
   * three idioms. This test says the same thing in a way that cannot rot
   * silently: if `DECLARED_IDIOMS` is ever widened, or one of these
   * examples is genuinely swept some other way, this test starts failing
   * and forces the comment to be looked at again — rather than the comment
   * quietly becoming aspirational the way the ORIGINAL "every idiom" claim
   * did.
   */
  it('EXECUTED — the sweep is INTENTIONALLY narrow: equally-real failure-swallowing idioms pass it silently (the general fix is prd-46 #70, not this law)', () => {
    const uncoveredIdioms = ['|| :', '2>&-', '>/dev/null 2>&1', '|| exit 0', '; true', 'cmd &']
    for (const idiom of uncoveredIdioms) {
      const rigged = `some_new_guard_command ${idiom}`
      const caught = DECLARED_IDIOMS.some((known) => rigged.includes(known))
      expect(caught, `"${idiom}" was unexpectedly caught by a declared idiom substring — narrow the uncoveredIdioms list or update the doc comment`).toBe(false)
    }
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

  describe(':74 fence regex — an invalid FENCE holds, it does not print "fence OK"', () => {
    const NEW_BLOCK = sliceLines('DIFF_FILES=$(git -C "$W" diff main...HEAD --name-only)', 'fence OK: $(printf')

    it('the old masking form ( grep -vE "$FENCE" || true ) is gone from the file', () => {
      expect(SOURCE).not.toContain('grep -vE "$FENCE" || true')
    })

    it('the fix checks the producer (git diff) and the grep exit code separately', () => {
      expect(NEW_BLOCK).toContain('DIFF_RC=$?')
      expect(NEW_BLOCK).toMatch(/GREP_RC=\$\?/)
      expect(NEW_BLOCK).toContain('-gt 1')
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
     * comparison itself — bash's `[ -lt ]` errors "integer expected" at
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

    it('the tolerance is a named, declared variable — not a magic number folded into the -gt condition it feeds', () => {
      // Anchored on the ASSIGNMENT, not a pinned value: a verification pass
      // found `toContain('RISE_TOLERANCE=0')` reddened at COLLECTION the
      // moment a human raised the tolerance past 0, with a failure naming
      // neither the tolerance nor the variable. 'RISE_TOLERANCE=' no longer
      // breaks collection when the value changes (still matches exactly one
      // line — the comment above it says "RISE_TOLERANCE is", no `=`; the
      // comparison below reads `"$RISE_TOLERANCE"`, no `=` either). That is
      // ALL this fixes: three fixtures a few tests below (the plain rise,
      // and both near-miss reproductions) still hardcode a delta of 1 and
      // assume a tolerance of 0, so raising RISE_TOLERANCE still turns them
      // red — at RUNTIME now, with a real assertion diff, rather than at
      // collection with an opaque "found 0" error. Updating those fixtures
      // for a non-zero tolerance is tracked separately, not done here.
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

    it('EXECUTED — a count that RISES is distinguished from a hold: RISE_NOTE names old and new counts, and the gate does not fail', () => {
      const dir = scratchDir('rise-up')
      writeFileSync(join(dir, 'timing-count'), '5\n')
      const script = preludeScript(0, `TCOUNT=7\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ROSE from 5 to 7')
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

    it('EXECUTED — the NEW ratchet still reports a CANONICAL rise correctly (8 -> 9, no leading zero) — the guard does not overreach', () => {
      const dir = scratchDir('rise-octal-new-canonical')
      writeFileSync(join(dir, 'timing-count'), '8\n')
      const script = preludeScript(0, `TCOUNT=9\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ROSE from 8 to 9')
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

    it('EXECUTED — a READ-ONLY floor HOLDS: fail() fires, the floor does not advance, and the unearned claim is never printed', () => {
      const dir = scratchDir('write-readonly')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const countFile = join(dir, '.swarm', 'timing-count')
      writeFileSync(countFile, '5\n')
      chmodSync(countFile, 0o444)
      const script = preludeScript(0, `root=${dir}\nTCOUNT=7\nCOUNT_FILE=${countFile}\nRISE_NOTE=" ROSE from 5 to 7"\n`) + WRITE_BLOCK + '\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(1)
      expect(res.stdout + res.stderr).toContain('cannot write the timing-count floor')
      expect(res.stdout + res.stderr).toContain('HOLDING')
      expect(res.stdout).not.toContain('ratchet:')
      expect(readFileSync(countFile, 'utf8')).toBe('5\n')
    })

    it('EXECUTED — the OLD (unchecked) write silently prints the same claim on the same read-only floor — the exact defect this fix removes', () => {
      const dir = scratchDir('write-readonly-old')
      mkdirSync(join(dir, '.swarm'), { recursive: true })
      const countFile = join(dir, '.swarm', 'timing-count')
      writeFileSync(countFile, '5\n')
      chmodSync(countFile, 0o444)
      const OLD_BLOCK = 'mkdir -p "$root/.swarm" && printf \'%s\\n\' "$TCOUNT" >"$COUNT_FILE"\n' + '[ -n "$RISE_NOTE" ] && echo "  timing-count ratchet:$RISE_NOTE"\n'
      const script = preludeScript(0, `root=${dir}\nTCOUNT=7\nCOUNT_FILE=${countFile}\nRISE_NOTE=" ROSE from 5 to 7"\n`) + OLD_BLOCK
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('timing-count ratchet: ROSE from 5 to 7')
      expect(readFileSync(countFile, 'utf8')).toBe('5\n')
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
      writeFileSync(join(dir, 'timing-count'), '2\n')
      const script = preludeScript(0, `W=${dir}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + DISCOVERY_AND_COUNT_BLOCK + '\n' + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ROSE from 2 to 3')
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
      writeFileSync(join(dir, 'timing-count'), '2\n')
      const script = preludeScript(0, `W=${dir}\nCOUNT_FILE=${join(dir, 'timing-count')}\n`) + DISCOVERY_AND_COUNT_BLOCK + '\n' + RATCHET_BLOCK + '\necho "RISE_NOTE=[$RISE_NOTE]"\n'
      const res = runFragment(script, dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('ROSE from 2 to 3')
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

    it('EXECUTED — the NEW form HOLDS on an unwritable lanes.json', () => {
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
})
