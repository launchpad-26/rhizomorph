import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * prd-54 wave 3's law (#394) — `scripts/dev/*.test.sh` runs in the vitest suite instead of
 * only when somebody remembers to invoke it by hand.
 *
 * Finding 1 on PR #380 is the proof this is not hypothetical: `scripts/dev/lane-guard.test.sh`
 * failed 2 of 18 on any clean checkout (`git init --bare` leaves `HEAD` at `refs/heads/master`,
 * so the fixture origin never got a `main`), and one of the two then passed on EMPTY OUTPUT —
 * that file's own stated purpose inverted. It was red for everyone but its author, and no
 * mechanism existed by which anybody would learn that. `windows-suite-law.test.ts` explains its
 * own existence with the identical rule: "a vitest law rather than a shell test because
 * `scripts/dev/*.test.sh` are hand-run only — nothing in `package.json`, `scripts/gate.sh` or CI
 * invokes them." Ruling 1 put `.swarm/coupling.txt`'s checks in vitest for the same reason
 * (`coupling-registry-law.test.ts`, wave 2, #367); this law is that ruling applied to the shell
 * tests a port cannot reach — they assert exit codes, git-fixture shapes and script stdout, which
 * is what shell is for, so they are executed here rather than re-implemented.
 *
 * Lives under `packages/server/` for the reason every sibling law here already gives: the root
 * vitest config globs `packages/*`, so a root-level test would never run.
 *
 * ## The list is derived, never hardcoded
 *
 * `SHELL_TESTS` comes from `git ls-files 'scripts/dev/*.test.sh'` — a hardcoded list is the rot
 * class this PRD names in its own body (the set held five scripts when #394 was filed, seven a
 * week later, eight today); a renamed or newly-added file must not silently drop out, and a glob
 * matching zero files must fail loudly rather than pass having checked nothing. Both properties
 * are proven below, not merely asserted: `discoverShellTests` is exercised against a pattern that
 * matches nothing, and the count check is a real assertion against the live glob, not a rigged one.
 * A property worth stating plainly rather than leaving implicit: `git ls-files` sees only TRACKED
 * files, so an untracked script dropped into `scripts/dev/` never runs here — not a skip this law
 * grants, just the boundary discovery draws by construction.
 *
 * ## Measured, on `origin/main` at `219b5b56` (2026-09-16), re-derive rather than trust this line
 *
 * `git ls-files 'scripts/dev/*.test.sh'` names eight files today: `await-merge.test.sh`,
 * `coupling.test.sh`, `fence-lint.test.sh`, `gh-retry.test.sh`, `issues.test.sh`,
 * `lane-guard.test.sh`, `prd-milestones.test.sh`, `prd-reconcile.test.sh`. Run individually on
 * this Linux checkout: all eight exit 0, for a combined 412 passed, 0 failed, in ~30.5s wall-clock
 * (await-merge.test.sh ~5.9s, coupling.test.sh ~1.8s, fence-lint.test.sh ~13.3s — the slowest —
 * gh-retry.test.sh ~0.6s, issues.test.sh ~3.2s, lane-guard.test.sh ~0.7s, prd-milestones.test.sh
 * ~0.1s, prd-reconcile.test.sh ~4.8s). Nothing here is fixed or excluded because nothing measured
 * red on this platform — this sweep is Linux-only, stated plainly rather than generalised, which
 * is exactly why the macOS finding just below was invisible here rather than excluded.
 *
 * ## macOS: gh-retry.test.sh's three assertions used STRING equality against a padded count —
 *    found on PR #575 review, cause class BSD/GNU COREUTILS, fixed
 *
 * PR #575 review (ciaran-slow, macOS darwin 25.6.0, node 22.23.2, commit-by-commit) ran
 * `VITEST_MAX_WORKERS=6 npm test` there and got one failing file, `gh-retry.test.sh`: 36
 * passed, 16 failed. `git diff` against `main` showed the script byte-identical — this law did
 * not introduce the defect, it surfaced one already there with no prior mechanism to see it,
 * the exact class #380's Finding 1 names. Cause: BSD `wc` right-pads its count (`       2`), GNU
 * `wc` does not (`2`); three assertion sites compared that value by STRING equality (`is()`'s
 * `[ "$2" = "$3" ]`) rather than the numeric comparison the file's own `n=$(wc -l ...)` /
 * `[ "$n" -eq 1 ]` already uses correctly a few lines above the first of them — left untouched
 * on purpose, since it already tolerates the padding. Fixed by piping each of the three (the
 * `calls()` helper, and the two raw `wc -c` byte-fidelity checks) through `tr -d ' '`.
 *
 * Verified on this Linux checkout by simulating BSD's padded `wc` with a PATH-shadowing shim
 * (GNU `wc` does not reproduce the padding natively, so this session cannot put a real macOS box
 * on the file): before the fix, under the shim, 36 passed / 16 failed, matching the review's own
 * count exactly; after, 52 passed / 0 failed, matching it too. That is evidence the FIX is right,
 * not a claim of having reproduced the failure on real Darwin — no native Windows or native Linux
 * run beyond this session's own has measured this exact file either, and restating platform scope
 * should say so rather than imply broader coverage than one macOS box plus one simulated Linux run.
 *
 * A separate cause class from the Windows position below: BSD/GNU coreutils divergence is a
 * macOS/BSD-userland fact about `wc`'s formatting, unrelated to `mktemp`, temp directories, or
 * anything the Windows paragraph's `temp-dir` candidate names.
 *
 * `gh-retry.test.sh:286`'s fixed-`/tmp`-path finding (flaky under concurrent runs, declared
 * separately) is UNTOUCHED by this fix and remains open — a different line, a different cause,
 * left for the operator to place.
 *
 * ## The summary line is anchored, and a duplicate is rejected — defense in depth, not a live hole
 *
 * Round 1 review (Codex, xhigh) found and reproduced live: the first version of
 * `parseSummary` scanned `stdout` from the end and returned the first line matching
 * `/(\d+) passed, (\d+) failed/` anywhere in it. Making `coupling.test.sh` print its
 * truthful `11 passed, 1 failed`, then append a fake `999 passed, 0 failed` and force its
 * own exit to 0, made that reading accept the fake line — it was nearest the end.
 *
 * **That takes two independent faults at once, and no script in this tree supplies
 * either.** All eight gate their own process exit on their own fail count — six end in
 * `[ "$fail" -eq 0 ] || exit 1`, and `await-merge.test.sh` / `lane-guard.test.sh` end in
 * `[ "$FAIL" -eq 0 ]` as their last statement, which propagates the same way. So a script
 * exiting 0 while its own tally is nonzero (fault one) does not happen anywhere today, and
 * the decoy line (fault two) only matters once fault one already has. The per-file
 * exit-code check ( `expect(r.status).toBe(0)`, further up) already catches every real
 * failure this tree can produce; the anchoring below is the BACKSTOP for the one case that
 * check cannot reach on its own, not the primary defence, and its absence would not have
 * been a live false-green.
 *
 * The fix — kept because it costs nothing on the real fleet, proven below — is
 * `SUMMARY_LINE_RE` anchored to the WHOLE line (`^...$`, checked per line rather than as a
 * substring search) plus a count, not a scan direction: exactly one line in `stdout` may
 * match, in either of today's two live shapes — bare `56 passed, 0 failed` (six of the
 * eight scripts) or `<script>.test.sh: 56 passed, 0 failed` (`await-merge.test.sh`,
 * `lane-guard.test.sh`). Zero matches means the script did not run to completion; more
 * than one is rejected outright as ambiguous, never resolved to whichever is first or last
 * — reversing the scan direction would have "fixed" the reproduced case while remaining
 * exploitable the other way, trading a two-fault hole for a different two-fault hole
 * rather than closing one. Both live shapes, the exact reproduced decoy, a CRLF-terminated
 * summary (parses — `.trimEnd()` strips the trailing `\r` before the match) and an
 * ANSI-coloured one (does NOT parse — the escape codes break the anchor, and correctly so:
 * no real script emits color) are all permanent regression tests below (`the runner`
 * describe). The control this fix had to clear before it was worth keeping — that the anchor
 * does not redden a single one of the eight real scripts — is the per-row `candidates.length`
 * assertion inside "proves it ran everything" below, over each script's actual captured
 * output from the SAME run the per-file exit-code tests already paid for; it is not a
 * separate re-execution, so the anchor's cost is the regex change alone, not a second pass
 * over the fleet.
 *
 * ## The timing hazard — `// @gate-timing` (see the marker further down)
 *
 * `await-merge.test.sh` carries real wall-clock assertions (`took_under 15`, `took_under 20`,
 * `took_under 10`) proving `--interval`'s clamp — there is no other channel to prove it, since an
 * unclamped sleep exits with byte-identical output, just later. `scripts/gate.sh`'s load probe
 * runs the suite four times at once with a bounded worker pool, which is exactly the condition
 * under which a wall-clock assertion measures CPU contention instead of the code. Rather than
 * split the clock-based cases out of a shell script that #394's own Out of scope forbids editing,
 * this whole law opts into the gate's timing set: `// @gate-timing` puts every test in this file
 * into the pass the gate runs serially, once, alone — the only condition under which
 * `await-merge.test.sh`'s own assertions mean anything, and also the only one available without
 * touching the shell file. The cost this adds to that serial pass is the measured ~30.5s above.
 *
 * ### The marker covers the GATE's probe and nothing else — found by rebasing, round 4
 *
 * Stated plainly because the paragraph above reads as though the marker closed the hazard, and
 * it closed half of it. `// @gate-timing` is read by `scripts/gate.sh`; an ordinary
 * `VITEST_MAX_WORKERS=6 npm test` knows nothing about it and still runs this file alongside 537
 * others. Rebasing this branch onto current `main` went red there — `await-merge.test.sh`'s
 * "polled gh 1 time(s), wanted >= 2", plus the aggregate check downstream of it — while the file
 * ran 20/20 green alone. Load average was 5.54.
 *
 * The mechanism is reproducible rather than inferred: `await-merge.sh` re-reads its deadline
 * AFTER the poll returns, so at the clamp case's original `--timeout 1` the entire margin was one
 * `gh` poll completing inside one second. With a stub that sleeps 1.2s, `--timeout 1` polls once
 * and fails; `--timeout 5` polls twice and passes. That case now runs at `--timeout 5` (fence
 * widened to `scripts/dev/await-merge.test.sh`, recorded on #394 before the change), which buys
 * margin without removing the clock dependency — a poll slower than ~5s fails it again, and
 * `took_under 15` still separates clamped (~5s) from unclamped (~30s).
 *
 * ## The Windows position — asserted, not filed blind
 *
 * KelliherL's comment on #394 measured all six then-existing scripts red on native Windows / Git
 * Bash, with environmental causes named per sample (`mktemp -d` behaving differently; an exit
 * code of 3 arriving as 1, exit-status truncation) — not logic bugs in the scripts. That
 * measurement was taken running the standalone `.sh` files directly, not through this law, and
 * covers six of today's eight; `fence-lint.test.sh` and `gh-retry.test.sh` were added since and
 * have no Windows measurement at all. This session has no native Windows environment, so a
 * `.windows-known-failures` entry — which prd-25 ruling 3 requires a named CAUSE CLASS and
 * evidence for — is not filed here: writing one now would be asserting a class this session did
 * not measure for this exact file (subprocess-wrapped, not standalone), for two of the eight
 * scripts covered by no measurement in either shape. The stronger reason, confirmed on round-1
 * review: `windows-suite-law.test.ts` itself asserts every `.windows-known-failures` entry's
 * `measured:` sha resolves to a real commit and carries a non-empty evidence note — an entry
 * filed from this session would fail that law's own honesty check, since there is no real
 * measurement behind it. Nor is the omission silent: an unlisted red is reported as `UNEXPECTED
 * FAILURE` by `scripts/windows-triage.sh`, so a native Windows run that reddens this file will
 * say so loudly, not pass by omission.
 *
 * `.github/workflows/windows-suite.yml` has run on no push since GitHub Actions was retired for
 * cost (2026-09-12), so this call currently reddens no live job. The expected next step, when a
 * native Windows run of THIS file happens (`scripts/ci-local.sh` does not reach it — it witnesses
 * the operator's own platform, not Windows; only `scripts/windows-triage.sh`, run by hand on a
 * Windows box, does): if it reddens for the same environmental reasons KelliherL measured, add a
 * `.windows-known-failures` entry naming `packages/server/src/shell-suite-law.test.ts` under a
 * real cause class (`temp-dir` is the leading candidate, going by the dominant failure named
 * above) with THAT run's evidence — not this comment's prior citation of somebody else's run of
 * different files. That "expected next step" lives only in this paragraph today, in no tracked
 * issue — recorded here as a gap, not a thing this session can close alone.
 *
 * ## No skip mechanism
 *
 * Discovery flows straight into execution below with no filtering step in between — every file
 * `SHELL_TESTS` names gets its own `it()`, unconditionally. This law does not invent a per-script
 * skip convention, because none of the eight scripts it runs today need one; a skip mechanism
 * nothing exercises would be exactly the kind of unproven assumption this PRD's own history
 * warns about. If a future script genuinely cannot run under a caller's environment, that
 * exclusion belongs where `.windows-known-failures` already puts the ones this repo has actually
 * measured — visible, evidenced and checked — not silently absorbed into a filter here.
 *
 * ## Collection must not throw
 *
 * `REPO_ROOT` and `SHELL_TESTS` run at module scope, same as every sibling law's own
 * `execFileSync('git', ...)` calls — `git ls-files` against a glob cannot throw for having no
 * matches, it returns empty stdout, which is exactly the shape the "not vacuous" test below
 * exercises. Every shell test's actual EXECUTION happens inside its own `it()` body, so one
 * script hanging or crashing fails that one test rather than taking the rest of the file's
 * assertions out of service (`gate-honesty-law.test.ts`'s module-scope anchor lookups are the
 * failure mode this avoids).
 */

// @gate-timing — see "The timing hazard" above: this file wraps await-merge.test.sh's real
// wall-clock assertions, so it must run in the gate's serial timing pass, never under the 4x
// load probe.

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const SHELL_TEST_GLOB = 'scripts/dev/*.test.sh'
// A HANG guard, not a performance assertion — nothing here asserts a script is fast, so
// raising this weakens no property (contrast `await-merge.test.sh`'s own `took_under`, which
// IS the assertion and must never be widened). Measured on macOS during the review of #575:
// the two slowest scripts run 15.0s (`fence-lint.test.sh`) and 15.4s (`prd-reconcile.test.sh`)
// on an idle box, and 28.6s / 27.0s under a 6-way CPU load — but a full `VITEST_MAX_WORKERS=6
// npm test` on an 8 GB box with an `npm install` competing took `fence-lint.test.sh` past
// 60_000 ms, killing it by SIGTERM: `status` null, reported as "did not run to completion".
// One occurrence in two full-suite runs, so a thin margin rather than a reproducible failure.
// 180s keeps ~12x headroom over the idle measurement while still bounding a genuinely hung
// script inside a single test.
const SHELL_TEST_TIMEOUT_MS = 180_000

function discoverShellTests(pattern: string): string[] {
  return execFileSync('git', ['ls-files', pattern], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
    .sort()
}

const SHELL_TESTS = discoverShellTests(SHELL_TEST_GLOB)

interface BashRunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/** Runs one bash script to completion, real stdout/stderr and exit status attached — never throws on a non-zero exit. */
function runBashScript(absPath: string): BashRunResult {
  const start = Date.now()
  const result = spawnSync('bash', [absPath], { cwd: REPO_ROOT, encoding: 'utf8', timeout: SHELL_TEST_TIMEOUT_MS })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - start,
  }
}

interface ShellRunResult extends BashRunResult {
  readonly file: string
}

function runShellTest(relPath: string): ShellRunResult {
  return { file: relPath, ...runBashScript(path.join(REPO_ROOT, relPath)) }
}

/**
 * Both live summary shapes today's eight scripts use, anchored to the WHOLE line, not a
 * substring: bare `56 passed, 0 failed` (six scripts) and `<script>.test.sh: 56 passed, 0
 * failed` (`await-merge.test.sh`, `lane-guard.test.sh`). A prose line that merely MENTIONS
 * the shape cannot match, because there is nothing else on the line for it to share with.
 */
const SUMMARY_LINE_RE = /^(?:\S+:\s*)?(\d+) passed, (\d+) failed$/

/**
 * Every line in `stdout` that is, on its own, a complete summary line — never a scan that
 * stops at the first (or last) match. `parseSummary` below requires there be EXACTLY one:
 * a script that prints its real summary and then a second summary-shaped line (a
 * per-section subtotal, a wrapper's own echoed tally, or an injected one) must not have
 * either line silently win over the other — reviewed and reproduced live: appending a
 * fake `999 passed, 0 failed` after `coupling.test.sh`'s truthful `11 passed, 1 failed`
 * and exiting 0 made the previous "scan backward, take the first match" reading accept the
 * fake line, because it was the one nearest the end. Scanning from either end is the same
 * defect with the direction flipped; only counting candidates catches both.
 */
function summaryCandidates(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => SUMMARY_LINE_RE.test(line))
}

/** `undefined` for zero candidates (did not run to completion) OR more than one (ambiguous) — the caller tells those two apart via `summaryCandidates` directly, since they are different failures with different messages. */
function parseSummary(stdout: string): { passed: number; failed: number } | undefined {
  const candidates = summaryCandidates(stdout)
  if (candidates.length !== 1) return undefined
  const m = SUMMARY_LINE_RE.exec(candidates[0]!)!
  return { passed: Number(m[1]), failed: Number(m[2]) }
}

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}

describe('the runner: a non-zero exit is a failure with its output attached, zero is a pass', () => {
  it('a script that fails is reported failing, with its stdout and stderr both surfaced', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shell-suite-law-'))
    try {
      const scriptPath = path.join(dir, 'synthetic-fail.sh')
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "out-marker"\necho "err-marker" >&2\nexit 1\n')
      const r = runBashScript(scriptPath)
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('out-marker')
      expect(r.stderr).toContain('err-marker')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a script that passes is reported passing, and its own summary line is read correctly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shell-suite-law-'))
    try {
      const scriptPath = path.join(dir, 'synthetic-pass.sh')
      writeFileSync(scriptPath, '#!/usr/bin/env bash\necho "1 passed, 0 failed"\nexit 0\n')
      const r = runBashScript(scriptPath)
      expect(r.status).toBe(0)
      expect(parseSummary(r.stdout)).toEqual({ passed: 1, failed: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the OTHER live shape parses too — a script-name prefix (await-merge.test.sh's and lane-guard.test.sh's own convention)", () => {
    expect(parseSummary('await-merge.test.sh: 56 passed, 0 failed\n')).toEqual({ passed: 56, failed: 0 })
  })

  it(
    'a real failing summary followed by a second, fake summary-shaped line is REJECTED, not silently resolved to whichever is last — the exact shape review found live: coupling.test.sh made to print a truthful "11 passed, 1 failed" and then an injected "999 passed, 0 failed", exit 0',
    () => {
      const stdout = '11 passed, 1 failed\n999 passed, 0 failed\n'
      expect(summaryCandidates(stdout)).toEqual(['11 passed, 1 failed', '999 passed, 0 failed'])
      expect(parseSummary(stdout), 'two summary-shaped lines must not resolve to either one').toBeUndefined()
    },
  )

  it('a summary-shaped fragment embedded in a longer prose line is not a candidate — anchored to the WHOLE line, not a substring', () => {
    const stdout = 'note: previously read 5 passed, 2 failed before the rerun\n7 passed, 0 failed\n'
    expect(summaryCandidates(stdout)).toEqual(['7 passed, 0 failed'])
    expect(parseSummary(stdout)).toEqual({ passed: 7, failed: 0 })
  })

  // The prose-fragment case above and the ANSI case below are each blocked by EITHER anchor
  // alone, so together they only catch a full reversion to an unanchored substring search —
  // a "simplification" dropping just one of `^`/`$` would leave both green (found on round 2
  // review). These two cases are chosen so each is blocked by exactly one anchor, proven by
  // mutation: dropping `^` alone turns the first green, dropping `$` alone turns the second
  // green, and dropping either leaves the OTHER case still red.
  it('leading text before a valid-looking `<name>: N passed, M failed` tail must not let the match start mid-line — needs the `^` anchor specifically', () => {
    const stdout = 'Result: fence-lint: 47 passed, 0 failed\n'
    expect(summaryCandidates(stdout)).toEqual([])
    expect(parseSummary(stdout)).toBeUndefined()
  })

  it('trailing text after an otherwise-valid count must not be silently ignored — needs the `$` anchor specifically', () => {
    const stdout = '11 passed, 0 failed (cached)\n'
    expect(summaryCandidates(stdout)).toEqual([])
    expect(parseSummary(stdout)).toBeUndefined()
  })

  it('a CRLF-terminated summary line still parses — trimEnd strips the trailing \\r before the anchor is checked', () => {
    expect(parseSummary('11 passed, 0 failed\r\n')).toEqual({ passed: 11, failed: 0 })
  })

  it('an ANSI-coloured summary line does NOT parse — ok, since no real script emits color, and failing loudly beats guessing through escape codes', () => {
    const stdout = '\x1b[32m11 passed, 0 failed\x1b[0m\n'
    expect(summaryCandidates(stdout)).toEqual([])
    expect(parseSummary(stdout)).toBeUndefined()
  })
})

describe('shell suite law: every scripts/dev/*.test.sh runs in the vitest suite (prd-54 wave 3, #394)', () => {
  it('a pattern matching nothing discovers nothing — proves the count check below is not vacuous', () => {
    expect(discoverShellTests('scripts/dev/this-pattern-matches-nothing-*.test.sh')).toEqual([])
  })

  // A floor of "more than zero" constrains SHELL_TESTS from below and nothing constrains it
  // from above, so every check downstream of discovery — the per-file `it()`s, `results.size`,
  // the totals — agrees with whatever discovery returned rather than with the tree. Mutation
  // (review of #575): `.slice(1)` on the REGISTRATION loop reddens (`results.size` 7 vs 8), but
  // `.slice(1)` on `discoverShellTests` itself goes green at 19 tests instead of 20 — a script
  // drops out of the suite entirely and nothing says so, which is the #209 "fell out of the
  // pass silently" class this law exists to close, reappearing one level up. So the pathspec is
  // cross-checked against a SECOND, independent derivation: list everything tracked under
  // scripts/dev/ and filter by suffix in JS. Two mechanisms that can only agree by both being
  // right.
  it('the glob agrees with an independent listing of scripts/dev/ — discovery itself cannot quietly shrink', () => {
    const independently = execFileSync('git', ['ls-files', 'scripts/dev/'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.endsWith('.test.sh'))
      .sort()
    expect(
      SHELL_TESTS,
      `git ls-files '${SHELL_TEST_GLOB}' and an independent suffix filter over scripts/dev/ disagree — the glob constant has been narrowed, or discovery is dropping entries`,
    ).toEqual(independently)
  })

  it(`discovers at least one shell test under '${SHELL_TEST_GLOB}'`, () => {
    expect(
      SHELL_TESTS.length,
      `git ls-files '${SHELL_TEST_GLOB}' matched zero files — either the directory moved or every shell test was deleted, and a law that discovers nothing passes having checked nothing`,
    ).toBeGreaterThan(0)
  })

  const results = new Map<string, ShellRunResult>()

  for (const relPath of SHELL_TESTS) {
    it(
      `${relPath} exits clean, with its own stdout and stderr attached on failure`,
      { timeout: SHELL_TEST_TIMEOUT_MS + 5_000 },
      () => {
        const r = runShellTest(relPath)
        results.set(relPath, r)
        const detail = [
          `${relPath} exited ${r.status}${r.signal ? ` (signal ${r.signal})` : ''} after ${r.durationMs}ms`,
          '--- stdout ---',
          r.stdout,
          '--- stderr ---',
          r.stderr,
        ].join('\n')
        expect(r.status, detail).toBe(0)
      },
    )
  }

  it('proves it ran everything: a per-file pass/fail count, and the totals are not zero', () => {
    expect(
      results.size,
      'not every discovered shell test recorded a result — one of the tests above did not run to completion',
    ).toBe(SHELL_TESTS.length)

    const table = SHELL_TESTS.map((file) => {
      const r = results.get(file)!
      const candidates = summaryCandidates(r.stdout)
      return { file, status: r.status, durationMs: r.durationMs, candidates, summary: parseSummary(r.stdout) }
    })
    // Verbose-only: vitest's default reporter (what `npm test`, the gate and CI all invoke)
    // prints console.log output on a FAILING test, never on a passing one, so this table is
    // visible only under `--reporter=verbose` or similar — a green run does not show it to
    // anyone. That is fine, because it is a look-at-me convenience, not the guard: every
    // property it displays is independently re-asserted below via `expect()`, whose custom
    // messages DO print under the default reporter when they fail (confirmed by review).
    console.log('shell-suite law — per-file breakdown:\n' + JSON.stringify(table, null, 2))

    for (const row of table) {
      expect(
        row.candidates.length,
        row.candidates.length === 0
          ? `${row.file} printed no "<N> passed, <M> failed" summary line — it did not run to completion`
          : `${row.file} printed ${row.candidates.length} summary-shaped lines, not one — ambiguous, and refused rather than trusting whichever is last: ${JSON.stringify(row.candidates)}`,
      ).toBe(1)
      expect(
        row.summary,
        `${row.file}: exactly one summary-shaped line was found but parseSummary still returned undefined — the two functions have drifted apart`,
      ).toBeDefined()
      expect(
        row.summary!.passed + row.summary!.failed,
        `${row.file} claims zero assertions — a script that runs but checks nothing is not a test`,
      ).toBeGreaterThan(0)
    }

    const totals = {
      scripts: table.length,
      passed: sum(table.map((t) => t.summary?.passed ?? 0)),
      failed: sum(table.map((t) => t.summary?.failed ?? 0)),
      wallClockMs: sum(table.map((t) => t.durationMs)),
    }
    console.log('shell-suite law — totals:', JSON.stringify(totals)) // verbose-only, see the note above

    expect(totals.passed, 'zero assertions passed across the whole set — the runner or the scripts are broken').toBeGreaterThan(0)
    expect(
      totals.failed,
      'a script reported internal failures in its own summary line despite the per-file exit-code check above passing — the exact "passed on empty output" shape Finding 1 on #380 found once already',
    ).toBe(0)
  })
})
