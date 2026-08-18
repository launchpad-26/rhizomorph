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

/**
 * Tracked files the sweeps below actually read: every one of them except this
 * law's own file and the binary assets.
 *
 * There is deliberately no third category. This law shipped with an
 * `EXCLUDED_PENDING_FIXTURE_REDACTION` list of seven — four real captures and
 * the three tests asserting byte-for-byte against them — whose own comment
 * promised "a follow-up PR that redacts the fixtures and their asserting tests
 * together". This is that PR, so the list is gone rather than emptied: an
 * exclusion array left standing at length zero keeps the honesty test that
 * guards it ("every excluded file actually trips the detector") passing
 * vacuously, and re-adding a name to it later costs one line and no argument.
 */
function scannableTrackedFiles(): string[] {
  return trackedFiles().filter((file) => file !== OWN_PATH && !BINARY_EXTENSIONS.some((ext) => file.endsWith(ext)))
}

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

/**
 * Home-directory shapes, in BOTH slash directions.
 *
 * The backslash half is not symmetry for its own sake. #651, the PR that added
 * this law, removed a real contributor's name twice from
 * `docs/research/2026-08-05-agnostic-adapters-spike.md`, written as
 * `\\wsl.localhost\Ubuntu\home\<name>\worktrees-challenge` — a UNC path to a
 * WSL filesystem, so its `home` segment is backslash-delimited. A sweep that
 * reads `/home/<name>` and not `\home\<name>` cannot stop that exact line
 * coming back — and it did not: two notes from the same session kept the same
 * sentence until review widened this pattern and found them. That is the
 * handles-one-case, misses-the-identical-sibling shape `AGENTS.md` names
 * first, occurring inside the law written to make it structural.
 *
 * The `\Users\<name>` pattern carries no drive prefix on purpose. It was
 * `[Cc]:`, which left `D:\Users\<name>` — the same disclosure on a second
 * disk — undetected, and nothing about the `C:` spelling is what made this a
 * finding. Matching the `\Users\` segment alone covers every drive letter and
 * a UNC share equally.
 */
const HOME_PATH_PATTERNS: RegExp[] = [
  /\/home\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /\/Users\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /\\+home\\+([A-Za-z][A-Za-z0-9._-]*)/g,
  /\\+Users\\+([A-Za-z][A-Za-z0-9._-]*)/g,
]

/**
 * Trailing punctuation is not part of a username. A path ending a prose
 * sentence — "transcripts live under `/home/operator`." — otherwise captures
 * `operator.`, which is not the allowlisted `operator`, so the law would fail
 * on the very placeholder it exists to bless, naming a violation nobody
 * committed. Only TRAILING `.` and `-` are trimmed: interior dots are real
 * (`jane.doe`) and so are interior hyphens (`lane-user`).
 */
function normalizeName(raw: string): string {
  return raw.replace(/[.-]+$/, '')
}

/** Every `/home/<name>`, `/Users/<name>`, `\home\<name>` or `\Users\<name>` name found in `contents`. */
function extractHomePathNames(contents: string): string[] {
  const names: string[] = []
  for (const pattern of HOME_PATH_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      if (!match[1]) continue
      const name = normalizeName(match[1])
      if (name.length > 0) names.push(name)
    }
  }
  return names
}

/**
 * Slug encodings of a home path — the form Claude Code writes under
 * `~/.claude/projects/`, where every separator collapses to a hyphen:
 * `/home/<name>/fork-probe` becomes `-home-<name>-fork-probe`, and
 * `C:\Users\<name>\repo` becomes `C--Users-<name>-repo`.
 *
 * This is the gap that let one occurrence outlive the sweep in #651. The
 * patterns above read `/home/<name>` and `\home\<name>`; neither can match a
 * form with no separators left in it, so a slug naming a real contributor sat
 * in a research note while the law written for exactly that name passed
 * green. `AGENTS.md` states the rule this closes — a path and its slug
 * encoding are ONE edit — and a law that reads only one of the two cannot
 * hold it.
 *
 * The lookbehind is what keeps this off English prose. A slug is a whole
 * token, so its `-home-` follows a quote, a `/`, or nothing at all; the
 * hyphenated compounds already in the tree (`real-home-directory`,
 * `spine-reversed-so-home-is-first`) each follow a letter, and are not slugs.
 */
const HOME_SLUG_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])-home-([A-Za-z][A-Za-z0-9._-]*)/g,
  /(?<![A-Za-z0-9])-Users-([A-Za-z][A-Za-z0-9._-]*)/g,
]

/**
 * A slug carries no boundary marking where the username ends: the hyphen is
 * both the separator AND a legal character inside a name, and the encoder
 * folds a dot to a hyphen too, so `lane-user`, `lane/user` and `jane.doe` all
 * arrive looking alike. Guessing the boundary would report
 * `-home-jane-doe-project` as the un-allowlisted name `jane`. Instead the
 * longest allowlisted prefix wins, matched with dots folded to hyphens, and
 * the allowlisted spelling is what comes back so the caller's plain
 * `includes` check still recognises it. Only when no allowlisted name fits is
 * the first segment reported as the violation.
 */
function slugName(tail: string): string {
  const segments = tail.split('-')
  for (let take = segments.length; take > 0; take -= 1) {
    const candidate = segments.slice(0, take).join('-')
    const allowed = ALLOWED_SYNTHETIC_NAMES.find((name) => name.replace(/\./g, '-') === candidate)
    if (allowed !== undefined) return allowed
  }
  return segments[0] ?? ''
}

/** Every `-home-<name>-…` or `-Users-<name>-…` name found in `contents` — the same disclosure as above, slug-encoded. */
function extractHomeSlugNames(contents: string): string[] {
  const names: string[] = []
  for (const pattern of HOME_SLUG_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      if (!match[1]) continue
      const name = slugName(normalizeName(match[1]))
      if (name.length > 0) names.push(name)
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

  it('the four formerly-excluded captures are still tracked, and are now clean — the sweep widened onto real files, it did not lose them', () => {
    const redacted = [
      'packages/server/src/collectors/sessionlog/fixtures/conductor-root.jsonl',
      'packages/server/src/collectors/sessionlog/fixtures/worker-2-core.jsonl',
      'packages/server/src/collectors/sessionlog/fixtures/worker-4-tmux-collector.jsonl',
      'packages/server/src/collectors/tmux/fixtures/list-panes.real.txt',
      'packages/server/src/collectors/sessionlog/collector.test.ts',
      'packages/server/src/collectors/sessionlog/parse-session-line.test.ts',
      'packages/server/src/collectors/tmux/list-panes.test.ts',
    ]
    // Dropping the exclusion list could pass for two opposite reasons: the
    // files were redacted, or they stopped being scanned. This names all
    // seven and asserts both halves, so only the first reading is available.
    for (const path of redacted) {
      expect(isTracked(path), `${path} is not tracked — the sweep cannot have cleaned it`).toBe(true)
      expect(scannableTrackedFiles(), `${path} is no longer swept`).toContain(path)
      const contents = readFileSync(`${REPO_ROOT}/${path}`, 'utf8')
      const live = [...extractHomePathNames(contents), ...extractHomeSlugNames(contents)].filter(
        (name) => !ALLOWED_SYNTHETIC_NAMES.includes(name),
      )
      expect(live, `${path} still names ${live.join(', ')}`).toEqual([])
      expect(findMachineNames(contents)).toEqual([])
    }
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

  it('the home-path detector fires on the BACKSLASH home shapes — the sibling a forward-slash-only sweep misses', () => {
    const wsl = String.raw`\\wsl.localhost\Ubuntu\home\notallowedname\worktrees-challenge`
    const secondDrive = String.raw`D:\Users\notallowedname\project`
    expect(extractHomePathNames(wsl)).toContain('notallowedname')
    expect(extractHomePathNames(secondDrive)).toContain('notallowedname')
  })

  it('the slug detector fires on the encoded form the path detectors structurally cannot see', () => {
    const slug = '~/.claude/projects/-home-notallowedname-fork-probe-wsA'
    // The point of the whole addition: the same disclosure, in the encoding
    // that survived a sweep. If this first expectation ever goes green, the
    // slug reader has become redundant rather than load-bearing.
    expect(extractHomePathNames(slug)).toEqual([])
    expect(extractHomeSlugNames(slug)).toContain('notallowedname')
    expect(extractHomeSlugNames('reverseProjectSlug("-Users-notallowedname-repo")')).toContain('notallowedname')
  })

  it('the slug detector does NOT fire on hyphenated English — the two compounds already in the tree', () => {
    expect(extractHomeSlugNames('a blanket regex replaced any other real-home-directory occurrence')).toEqual([])
    expect(extractHomeSlugNames('the same spine-reversed-so-home-is-first geometry')).toEqual([])
  })

  it('a slug resolves the longest allowlisted name, not the first hyphen — dots encode as hyphens too', () => {
    // `jane.doe` and `lane-user` are both allowlisted and both ambiguous once
    // encoded; cutting at the first hyphen would report `jane` and `lane`,
    // failing this law on the very placeholders it blesses.
    expect(extractHomeSlugNames("worktreePathToProjectSlug('/home/jane.doe/project') === '-home-jane-doe-project'")).toEqual([
      'jane.doe',
    ])
    expect(extractHomeSlugNames('-home-lane-user-repo')).toEqual(['lane-user'])
    expect(extractHomeSlugNames('-Users-dev-TailR-Nutrition-tailr-codebase')).toEqual(['dev'])
  })

  it('a path ending a sentence does not capture the full stop — an allowlisted name stays allowlisted', () => {
    const names = extractHomePathNames('transcripts live under /home/operator.')
    expect(names).toEqual(['operator'])
    expect(names.every((name) => ALLOWED_SYNTHETIC_NAMES.includes(name))).toBe(true)
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

  it('no tracked file contains a home/Users path outside the synthetic allowlist, written either way round', () => {
    const violations: string[] = []
    for (const file of scannableTrackedFiles()) {
      const contents = readFileSync(`${REPO_ROOT}/${file}`, 'utf8')
      for (const name of extractHomePathNames(contents)) {
        if (!ALLOWED_SYNTHETIC_NAMES.includes(name)) violations.push(`${file}: home-directory name "${name}"`)
      }
      for (const name of extractHomeSlugNames(contents)) {
        if (!ALLOWED_SYNTHETIC_NAMES.includes(name)) violations.push(`${file}: home-directory name "${name}", slug-encoded`)
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
