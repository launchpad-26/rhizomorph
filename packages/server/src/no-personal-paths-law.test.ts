import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #649's law — no tracked file names a real contributor's home directory,
 * OS username or machine.
 *
 * rhizomorph is public. `main` carried four real contributors' usernames and
 * one real machine name across docs, a source doc comment and a dozen test
 * files — none of it the operator's, all of it load-bearing on nobody, since
 * every path here is either prose or a hard-coded test string. This law
 * makes the absence structural instead of relying on a human sweep, the same
 * move `fixture-hygiene-law.test.ts` makes for OTel identity fields and
 * `eras.test.ts` makes for the operator's own username inside era recording.
 *
 * Lives under `packages/server/` for `runbook-delivery-law.test.ts`'s own
 * reason: the root vitest config globs `packages/*`, so a root-level test
 * would never run and would be its own vacuous law.
 *
 * Grep-law style: real tracked-file text via `git ls-files`, no mocks. Half
 * the tests below exist to prove the detectors bite and the allowlist is
 * actually checked, not just declared — a law asserting absence is exactly
 * the shape that passes vacuously when its own probe is broken.
 *
 * `git ls-files` reads the INDEX, not the working tree — an edit that is not
 * `git add`ed yet either does not exist here (a rename) or is read stale (a
 * content change), so stage before running this.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

function isTracked(relPath: string): boolean {
  const out = execFileSync('git', ['ls-files', '--', relPath], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.trim().length > 0
}

/** This law's own path — its doc comments and rigged examples deliberately contain trigger strings for the tests below, so the general sweep must not check itself. */
const OWN_PATH = 'packages/server/src/no-personal-paths-law.test.ts'

/** Binary extensions checked into the repo (screenshots) — not text, and decoding one as utf8 can produce garbage that coincidentally matches a pattern (seen: a PNG's raw bytes decoding to a false-positive machine name). */
const BINARY_EXTENSIONS = ['.png']

/** Tracked files the two sweeps below actually read: not pending-fixture-redaction, not this law's own file, not a binary asset. */
function scannableTrackedFiles(): string[] {
  return trackedFiles().filter(
    (file) => !EXCLUDED_PATHS.includes(file) && file !== OWN_PATH && !BINARY_EXTENSIONS.some((ext) => file.endsWith(ext)),
  )
}

/**
 * Four real captured session/tmux fixtures, plus the tests that assert
 * byte-for-byte against their real `cwd`/`filePath`/`currentPath`/`title`
 * fields. A capture is redacted for identity at authoring time (#649's
 * ruling, recorded on the issue before dispatch) — these four predate that
 * discipline and are excluded here BY NAME, with a reason, rather than
 * silently passed over: a sweep that is quietly narrower than its title is
 * the defect this repo names second. They land in a follow-up PR that
 * redacts the fixtures and their asserting tests together; renaming one side
 * here without the other would just break the test against real bytes that
 * still exist in the tree.
 */
const EXCLUDED_PENDING_FIXTURE_REDACTION: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'packages/server/src/collectors/sessionlog/fixtures/conductor-root.jsonl',
    reason: 'real captured session transcript, predates per-capture redaction',
  },
  {
    path: 'packages/server/src/collectors/sessionlog/fixtures/worker-2-core.jsonl',
    reason: 'real captured session transcript, predates per-capture redaction',
  },
  {
    path: 'packages/server/src/collectors/sessionlog/fixtures/worker-4-tmux-collector.jsonl',
    reason: 'real captured session transcript, predates per-capture redaction',
  },
  {
    path: 'packages/server/src/collectors/tmux/fixtures/list-panes.real.txt',
    reason: 'real captured `tmux list-panes` output, predates per-capture redaction',
  },
  {
    path: 'packages/server/src/collectors/sessionlog/collector.test.ts',
    reason: "asserts verbatim against the sessionlog fixtures' real cwd/filePath fields",
  },
  {
    path: 'packages/server/src/collectors/sessionlog/parse-session-line.test.ts',
    reason: "asserts verbatim against the sessionlog fixtures' real cwd/filePath fields",
  },
  {
    path: 'packages/server/src/collectors/tmux/list-panes.test.ts',
    reason: "asserts verbatim against list-panes.real.txt's real currentPath/title fields",
  },
]
const EXCLUDED_PATHS = EXCLUDED_PENDING_FIXTURE_REDACTION.map((entry) => entry.path)

/** Obviously-synthetic names seen in tracked files today — anything else is a live-looking name. */
const ALLOWED_SYNTHETIC_NAMES: readonly string[] = [
  'alice',
  'dev',
  'fixture',
  'j',
  'jane.doe',
  'lane-user',
  'me',
  'nobody-has-any-of-these-dirs',
  'operator',
  'runner',
  'someone',
  'u',
  'x',
  'you',
]

const HOME_PATH_PATTERNS: RegExp[] = [
  /\/home\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /\/Users\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /[Cc]:\\+Users\\+([A-Za-z][A-Za-z0-9._-]*)/g,
]

/** Every `/home/<name>`, `/Users/<name>` or `C:\Users\<name>` name found in `contents`. */
function extractHomePathNames(contents: string): string[] {
  const names: string[] = []
  for (const pattern of HOME_PATH_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      if (match[1]) names.push(match[1])
    }
  }
  return names
}

/**
 * Windows machine-name shapes: the two common auto-generated forms
 * (`DESKTOP-XXXXXXX`, `LAPTOP-XXXXXXX`) and a CamelCase name ending in `PC`
 * (the shape #649 actually found, `<name>PC`). The CamelCase pattern
 * requires a lowercase second character so it does not fire on an all-caps
 * acronym like `ENOSPC` or `IPC` — those have no case transition to a real
 * name.
 */
const MACHINE_NAME_PATTERNS: RegExp[] = [/\bDESKTOP-[A-Z0-9]+\b/g, /\bLAPTOP-[A-Z0-9]+\b/g, /\b[A-Z][a-z][A-Za-z0-9]*PC\b/g]

function findMachineNames(contents: string): string[] {
  const hits: string[] = []
  for (const pattern of MACHINE_NAME_PATTERNS) {
    for (const match of contents.matchAll(pattern)) hits.push(match[0])
  }
  return hits
}

describe('no personal paths law: no tracked file names a real home directory, username or machine', () => {
  it('the tracked-file sweep is non-empty — the checks below would pass vacuously otherwise', () => {
    expect(trackedFiles().length).toBeGreaterThan(500)
  })

  it('every excluded path is still tracked — a stale entry here would silently widen the sweep', () => {
    for (const { path } of EXCLUDED_PENDING_FIXTURE_REDACTION) {
      expect(isTracked(path), `${path} is not tracked — remove it from the exclusion list`).toBe(true)
    }
  })

  it('the exclusion list is pinned — a silent addition is exactly how a narrowed sweep hides', () => {
    expect(EXCLUDED_PATHS).toEqual([
      'packages/server/src/collectors/sessionlog/fixtures/conductor-root.jsonl',
      'packages/server/src/collectors/sessionlog/fixtures/worker-2-core.jsonl',
      'packages/server/src/collectors/sessionlog/fixtures/worker-4-tmux-collector.jsonl',
      'packages/server/src/collectors/tmux/fixtures/list-panes.real.txt',
      'packages/server/src/collectors/sessionlog/collector.test.ts',
      'packages/server/src/collectors/sessionlog/parse-session-line.test.ts',
      'packages/server/src/collectors/tmux/list-panes.test.ts',
    ])
    for (const { reason } of EXCLUDED_PENDING_FIXTURE_REDACTION) {
      expect(reason.length).toBeGreaterThan(0)
    }
  })

  it('every excluded file actually trips the detector today — the exclusion is doing real work, not vacuous', () => {
    const filesThatTrip = new Set<string>()
    for (const path of EXCLUDED_PATHS) {
      const contents = readFileSync(`${REPO_ROOT}/${path}`, 'utf8')
      const liveNames = extractHomePathNames(contents).filter((name) => !ALLOWED_SYNTHETIC_NAMES.includes(name))
      if (liveNames.length > 0 || findMachineNames(contents).length > 0) filesThatTrip.add(path)
    }
    expect(filesThatTrip.size).toBe(EXCLUDED_PATHS.length)
  })

  it('the allowlist is pinned — a silent addition here is exactly how a real name gets waved through', () => {
    expect(ALLOWED_SYNTHETIC_NAMES).toEqual([
      'alice',
      'dev',
      'fixture',
      'j',
      'jane.doe',
      'lane-user',
      'me',
      'nobody-has-any-of-these-dirs',
      'operator',
      'runner',
      'someone',
      'u',
      'x',
      'you',
    ])
  })

  it('the home-path detector fires on a realistic name that is NOT allowlisted — proving it bites', () => {
    const contents = 'see /home/notallowedname/project or C:\\Users\\notallowedname\\thing'
    const names = extractHomePathNames(contents)
    expect(names).toContain('notallowedname')
    expect(names.some((name) => !ALLOWED_SYNTHETIC_NAMES.includes(name))).toBe(true)
  })

  it('the home-path detector does NOT fire on the allowlisted names themselves — not vacuously true', () => {
    const contents = ALLOWED_SYNTHETIC_NAMES.map((name) => `/home/${name}/project`).join('\n')
    const names = extractHomePathNames(contents)
    expect(names.length).toBe(ALLOWED_SYNTHETIC_NAMES.length)
    for (const name of names) expect(ALLOWED_SYNTHETIC_NAMES).toContain(name)
  })

  it('the machine-name detector fires on DESKTOP-*, LAPTOP-* and a CamelCase+PC hostname', () => {
    expect(findMachineNames('built on DESKTOP-AB12CD3 last night')).toEqual(['DESKTOP-AB12CD3'])
    expect(findMachineNames('captured from LAPTOP-9XQZ21')).toEqual(['LAPTOP-9XQZ21'])
    expect(findMachineNames('tmux title: WorkstationPC')).toEqual(['WorkstationPC'])
  })

  it('the machine-name detector does NOT fire on look-alike all-caps acronyms — proving it is not just "*PC"', () => {
    expect(findMachineNames('threw ENOSPC on write')).toEqual([])
    expect(findMachineNames('sent over IPC')).toEqual([])
    expect(findMachineNames('the gRPC client')).toEqual([])
  })

  it('no non-excluded tracked file contains a home/Users path outside the synthetic allowlist', () => {
    const violations: string[] = []
    for (const file of scannableTrackedFiles()) {
      const contents = readFileSync(`${REPO_ROOT}/${file}`, 'utf8')
      for (const name of extractHomePathNames(contents)) {
        if (!ALLOWED_SYNTHETIC_NAMES.includes(name)) violations.push(`${file}: /home or /Users or C:\\Users name "${name}"`)
      }
    }
    expect(violations).toEqual([])
  })

  it('no non-excluded tracked file names a machine', () => {
    const violations: string[] = []
    for (const file of scannableTrackedFiles()) {
      const contents = readFileSync(`${REPO_ROOT}/${file}`, 'utf8')
      for (const hit of findMachineNames(contents)) {
        violations.push(`${file}: machine name "${hit}"`)
      }
    }
    expect(violations).toEqual([])
  })
})
