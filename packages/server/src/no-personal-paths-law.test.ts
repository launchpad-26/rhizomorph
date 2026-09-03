import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { FIXTURE_REPO_PATH } from '@rhizomorph/core'
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

/**
 * Binary extensions checked into the repo — not text, and decoding one as
 * utf8 can produce garbage that coincidentally matches a pattern (seen: a
 * PNG's raw bytes decoding to a false-positive machine name). This is why
 * none of these stay out of the TEXT sweep below no matter what they are; it
 * is a separate question from whether one of them is EXEMPT, which prd-43
 * ruling 4 answers "no" for a documented screenshot — see the
 * screenshot-binding law further down, which reads these same files by their
 * bytes and their sidecar manifest instead of as decoded text.
 *
 * Widened from `['.png']` alone (#22, third re-review) to every opaque
 * binary image format this repo's own screenshot classifier recognizes —
 * SAME list, not a parallel one: this constant IS what `isTrackedScreenshot`
 * checks against, below. A prior round widened the CASE a `.png` could take
 * (`.PNG`); this widens the FORMAT — a same-directory `.jpg`, `.gif` or
 * `.webp` can carry the identical pixel-drawn leak a `.png` can, and a pixel
 * leak is exactly as invisible to grep regardless of container format. The
 * repo tracks zero non-PNG images today (pinned by a test below), so this
 * costs nothing to widen and closes the format axis before it is ever used
 * rather than after.
 */
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

/**
 * Case-insensitive extension match. A filesystem does not care whether a
 * screenshot is named `.png` or `.PNG`, and neither check below may either:
 * review of #22 found an uppercase-extension screenshot with no sidecar
 * passing 22/22, because both `BINARY_EXTENSIONS`' text-sweep exclusion and the
 * binding law's own classification used a bare, case-sensitive `.endsWith`.
 * That combination is not two redundant checks tiling the same gap — it is
 * the SAME gap twice: an uppercase PNG fails to match either one, so it is
 * simultaneously "not binary" (wrongly pulled into the text sweep, which
 * cannot read a leak drawn into pixels) and "not a screenshot" (never bound
 * to a manifest at all). Renaming a leaked capture's extension defeated the
 * whole law.
 */
function hasExtension(file: string, ext: string): boolean {
  return file.toLowerCase().endsWith(ext.toLowerCase())
}

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
  return trackedFiles().filter((file) => file !== OWN_PATH && !BINARY_EXTENSIONS.some((ext) => hasExtension(file, ext)))
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

/**
 * SCREENSHOT BINDING — prd-43 ruling 4, widened by `94b2950`, NARROWED by
 * review of #22 after both verification seats forged a passing pair by hand.
 *
 * What this law proves: a tracked screenshot cannot ship with zero manifest,
 * and a manifest cannot be silently re-paired with different image bytes —
 * the digest is recomputed from the actual PNG bytes and compared, not read
 * off the sidecar's own word. That closes the failure #22 was FILED for (a
 * stale manifest surviving a re-capture, or a screenshot added with no
 * manifest at all).
 *
 * What this law does NOT prove, despite ruling 4's own wording ("a valid pair
 * IS the provenance claim") and this file's own first draft repeating it: that
 * the pixels are clean, or that `scripts/dev/visit.mjs --capture` was the tool
 * that produced the pair. A SHA-256 is a public, unkeyed function — anyone
 * with the PNG bytes computes the same digest `visit.mjs` would, by hand,
 * with `sha256sum`. Two independent review seats did exactly that: a real
 * 1×1 PNG carrying a real contributor's home directory in a tEXt chunk,
 * paired with its own correctly-computed digest and a `syntheticRoot` of
 * `/repo/rhizomorph`, passes every check below. Closing
 * that gap for real needs an attestation only the capture tool can make —
 * concretely, asymmetric signing, where `visit.mjs` holds a private key that
 * never enters this repository and the law verifies against a public key that
 * does. This repo has no key-custody story (no secret store, no rotation
 * policy, no ADR saying who holds it or how a fork or a new contributor's
 * machine gets one) — building the signing half without that story would
 * hand this law a checked-in secret in every way that matters except the
 * name, so it is not attempted here. Closing the gap is future work behind an
 * ADR; what changed today is that the law stops CLAIMING to have closed it.
 *
 * What actually stands between a screenshot and a leaked path, until that ADR
 * exists, is the same thing every other change in this repo relies on: a
 * human reviewing the diff before it merges. `visit.mjs --capture` remains
 * the recommended path — it substitutes a synthetic root before the shutter
 * so an ORDINARY capture never shows a real one by construction — but this
 * law cannot and does not verify that a given tracked PNG was produced by it.
 */
/**
 * THE CLASSIFIER'S OWN AXES (#22, third re-review). Four rounds on this one
 * bundle have each closed the axis the round before found, one at a time —
 * case, then format, each discovered by a byte-identical control the round
 * before didn't think to write. This is the enumeration that should have
 * shipped with the first one, so the next axis is a row added to a table
 * instead of a fifth round.
 *
 *  - CASE (a `.png` vs its uppercase spelling) — CLOSED. `hasExtension`
 *    lowercases both sides before comparing.
 *  - FORMAT (`.png` vs `.jpg`/`.jpeg`/`.gif`/`.webp`) — CLOSED for the pinned
 *    set in `BINARY_EXTENSIONS`, same list the classifier below checks
 *    against. NOT exhaustive (no `.bmp`, `.tiff`, `.avif`, `.heic`, …) — see
 *    the "unrecognized format" test, which is what stands in for
 *    exhaustiveness: a file under this directory whose extension names
 *    nothing in that list reddens a named test rather than passing quietly,
 *    so widening the list is a decision this law forces rather than one it
 *    silently defers.
 *  - SUBDIRECTORY (a screenshot nested under this directory rather than
 *    directly in it) — CLOSED, and was closed before this round without
 *    anyone noticing: `isTrackedScreenshot` uses `startsWith`, not an exact
 *    parent match, so nesting cannot escape it. Pinned by a test below
 *    rather than left for a reader to take on faith.
 *  - NO EXTENSION AT ALL — CLOSED via the same forcing function as FORMAT:
 *    it matches nothing in `BINARY_EXTENSIONS` either, so it reddens the
 *    identical "unrecognized format" test.
 *  - DOUBLE EXTENSION (a real extension trailing a fake one, or the reverse)
 *    — CLOSED the same way: only the LAST extension is what `hasExtension`
 *    reads, so a file whose true extension is not a recognized image format
 *    reddens as unrecognized, and a file whose true extension IS one
 *    correctly still requires a manifest.
 *  - SYMLINK — CLOSED: a tracked entry in this directory whose git blob mode
 *    is `120000` (a symlink, not a regular file) fails a dedicated test,
 *    rather than letting `readFileSync` silently follow it to whatever the
 *    link target resolves to on whichever machine runs the suite — which
 *    could be a file that was never reviewed, or never committed, at all.
 *
 * What this table is NOT about: whether a manifest's claim is trustworthy.
 * That is the separate, already-narrowed claim in the module doc comment
 * above SCREENSHOT BINDING — a hand-forged pair still passes every check
 * here, on purpose, and this table does not change that.
 */
describe('screenshot binding: a tracked PNG cannot ship unmanifested or be re-paired with different bytes', () => {
  const SCREENSHOT_DIR = 'docs/screenshots/'

  function isTrackedScreenshot(file: string): boolean {
    return file.startsWith(SCREENSHOT_DIR) && BINARY_EXTENSIONS.some((ext) => hasExtension(file, ext))
  }

  function manifestPathFor(pngFile: string): string {
    return `${pngFile}.manifest.json`
  }

  interface BindingResult {
    ok: boolean
    reason?: string
  }

  const HOW_TO_CAPTURE = 'run `node scripts/dev/visit.mjs --capture <path.png> --repo <path>` — see this file\'s SCREENSHOT BINDING comment for the sidecar shape'

  /**
   * The one sanctioned value: imported, not retyped, so this file cannot
   * itself become a second place the literal has to be kept in sync.
   * `visit.mjs --capture` still cannot import it (see the cross-check test
   * below for why, and how that gap is closed instead). Checking for
   * non-emptiness alone let a manifest name `"z"` and still pass 22/22 — not
   * a leak (`"z"` names no one), but not a record of anything real either,
   * and a check that only rejects empty strings is not checking the field at
   * all. There being exactly one tool that mints these and exactly one value
   * it ever writes makes this an equality check, not a pattern — no separate
   * allowlist to keep in sync.
   */
  const SANCTIONED_SYNTHETIC_ROOT = FIXTURE_REPO_PATH

  /**
   * The check itself, as a pure function over bytes the caller already has —
   * so the "detector bites" tests below can prove both red halves with
   * synthetic buffers, the same way `extractHomePathNames` is proven above
   * with synthetic strings, instead of needing new tracked fixture files.
   *
   * Binds a manifest to ONE specific set of bytes. Does not, and cannot,
   * establish where those bytes came from — see the module doc comment above
   * for what that gap means and why it is not closed here.
   */
  function verifyScreenshotBinding(pngBytes: Buffer, manifestContents: string | null): BindingResult {
    if (manifestContents === null) return { ok: false, reason: `no sidecar manifest — ${HOW_TO_CAPTURE}` }
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestContents)
    } catch {
      return { ok: false, reason: `sidecar manifest is not valid JSON — ${HOW_TO_CAPTURE}` }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, reason: `sidecar manifest is not a JSON object — ${HOW_TO_CAPTURE}` }
    }
    const { syntheticRoot, sha256 } = parsed as Record<string, unknown>
    if (syntheticRoot !== SANCTIONED_SYNTHETIC_ROOT) {
      return {
        ok: false,
        reason: `sidecar manifest names syntheticRoot ${JSON.stringify(syntheticRoot)}, the only sanctioned value is ${JSON.stringify(SANCTIONED_SYNTHETIC_ROOT)} — ${HOW_TO_CAPTURE}`,
      }
    }
    if (typeof sha256 !== 'string' || sha256.length === 0) {
      return { ok: false, reason: `sidecar manifest has no sha256 — ${HOW_TO_CAPTURE}` }
    }
    const actual = createHash('sha256').update(pngBytes).digest('hex')
    if (sha256 !== actual) {
      return { ok: false, reason: `sidecar manifest names ${sha256}, the image bytes hash to ${actual}` }
    }
    return { ok: true }
  }

  /**
   * Every tracked PNG that is not a documented app screenshot, pinned by
   * name. Each answers to a different, already-documented mechanism —
   * `packages/app/build/icon.png` is static app art, the `parity/` trio is
   * `capture.mjs`'s own painter-comparison evidence, and the two
   * `research/spikes/renderer/shot-*.png` are that spike's own throwaway
   * rig — none of them a screenshot `visit.mjs` produced or CONTRIBUTING.md's
   * `docs/screenshots/**` obligation reaches. Pinned rather than derived from
   * a path pattern, same reasoning as `ALLOWED_SYNTHETIC_NAMES` above: a
   * silent addition here is exactly how a real screenshot would dodge the
   * check ruling 4 exists to enforce.
   */
  const NON_SCREENSHOT_BINARY_ASSETS: readonly string[] = [
    'packages/app/build/icon.png',
    'packages/web/src/scene/parity/after.png',
    'packages/web/src/scene/parity/before.png',
    'packages/web/src/scene/parity/diff.png',
    'research/spikes/renderer/shot-canvas.png',
    'research/spikes/renderer/shot-webgl.png',
  ]

  it('BINARY_EXTENSIONS is pinned to the opaque image formats this classifier recognizes — the FORMAT axis, in one place', () => {
    expect(BINARY_EXTENSIONS).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
  })

  it('the non-screenshot allowlist is pinned and every entry is still tracked', () => {
    expect(NON_SCREENSHOT_BINARY_ASSETS).toEqual([
      'packages/app/build/icon.png',
      'packages/web/src/scene/parity/after.png',
      'packages/web/src/scene/parity/before.png',
      'packages/web/src/scene/parity/diff.png',
      'research/spikes/renderer/shot-canvas.png',
      'research/spikes/renderer/shot-webgl.png',
    ])
    for (const file of NON_SCREENSHOT_BINARY_ASSETS) {
      expect(isTracked(file), `${file} is pinned as non-screenshot but is not tracked`).toBe(true)
    }
  })

  it('every tracked image in any BINARY_EXTENSIONS format is either a documented screenshot or a pinned non-screenshot asset — no third, silent category', () => {
    const allImages = trackedFiles().filter((file) => BINARY_EXTENSIONS.some((ext) => hasExtension(file, ext)))
    const unclassified = allImages.filter((file) => !isTrackedScreenshot(file) && !NON_SCREENSHOT_BINARY_ASSETS.includes(file))
    expect(unclassified).toEqual([])
  })

  it('the repo tracks zero non-PNG images today — widening BINARY_EXTENSIONS ahead of need costs nothing because there is nothing yet to grandfather', () => {
    const nonPng = trackedFiles().filter((file) => hasExtension(file, '.jpg') || hasExtension(file, '.jpeg') || hasExtension(file, '.gif') || hasExtension(file, '.webp'))
    expect(nonPng).toEqual([])
  })

  it('the tracked-screenshot sweep is non-empty — the checks below would pass vacuously otherwise', () => {
    const screenshots = trackedFiles().filter(isTrackedScreenshot)
    expect(screenshots.length).toBeGreaterThan(0)
  })

  it('isTrackedScreenshot recognizes every BINARY_EXTENSIONS format, not just .png (the FORMAT axis, checked against the classifier itself)', () => {
    for (const ext of BINARY_EXTENSIONS) {
      expect(isTrackedScreenshot(`${SCREENSHOT_DIR}leak${ext}`), `isTrackedScreenshot did not recognize ${ext}`).toBe(true)
    }
  })

  it('a screenshot nested under a subdirectory of docs/screenshots/ is still classified — startsWith, not an exact parent match (the SUBDIRECTORY axis)', () => {
    expect(isTrackedScreenshot(`${SCREENSHOT_DIR}nested/leak.png`)).toBe(true)
  })

  it('a double extension is classified by its actual (last) extension only, in both directions (the DOUBLE-EXTENSION axis)', () => {
    // A real image extension trailing a fake one still requires a manifest.
    expect(isTrackedScreenshot(`${SCREENSHOT_DIR}leak.txt.png`)).toBe(true)
    // A fake extension trailing a real one is not treated as an image at all — it falls
    // to the "unrecognized format" forcing-function test below when it is a real tracked file.
    expect(BINARY_EXTENSIONS.some((ext) => hasExtension(`${SCREENSHOT_DIR}leak.png.bak`, ext))).toBe(false)
  })

  it('a tracked file under docs/screenshots/ with no recognized image extension — or none at all — reddens rather than passing silently (the FORMAT and NO-EXTENSION axes)', () => {
    const files = trackedFiles().filter((file) => file.startsWith(SCREENSHOT_DIR) && !file.endsWith('.manifest.json'))
    const unrecognized = files.filter((file) => !BINARY_EXTENSIONS.some((ext) => hasExtension(file, ext)))
    expect(
      unrecognized,
      `unrecognized format under ${SCREENSHOT_DIR}: ${unrecognized.join(', ')} — extend BINARY_EXTENSIONS above, or explain why not, before this can be tracked`,
    ).toEqual([])
  })

  function gitMode(file: string): string {
    const out = execFileSync('git', ['ls-files', '-s', '--', file], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    return out.split(/\s+/)[0] ?? ''
  }

  it('no tracked screenshot is a symlink (the SYMLINK axis) — git mode 120000 would let readFileSync silently follow it to an unreviewed target', () => {
    const symlinks = trackedFiles().filter(isTrackedScreenshot).filter((file) => gitMode(file) === '120000')
    expect(symlinks).toEqual([])
  })

  /**
   * PINS THE CASE-SENSITIVITY BLOCKER from #22's second re-review. An
   * uppercase-extension screenshot with no sidecar previously passed 22/22: a
   * bare `.endsWith('.png')` does not match `.PNG`, so the file was neither
   * excluded as binary (pulled into the text sweep, which cannot read a leak
   * drawn into pixels) nor classified as a screenshot requiring a manifest.
   * Renaming a leaked capture's extension defeated the whole law.
   */
  it('an uppercase .PNG extension is still classified as a tracked screenshot, and still excluded from the binary text-sweep', () => {
    const upper = `${SCREENSHOT_DIR}UPPER.PNG`
    expect(isTrackedScreenshot(upper)).toBe(true)
    expect(BINARY_EXTENSIONS.some((ext) => hasExtension(upper, ext))).toBe(true)
  })

  it('the binding check goes red when a tracked PNG has no sidecar manifest', () => {
    const result = verifyScreenshotBinding(Buffer.from('a screenshot with nobody vouching for it'), null)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no sidecar manifest/)
  })

  it('the binding check goes red when the sidecar manifest names a syntheticRoot other than the one sanctioned value', () => {
    const captured = Buffer.from('the bytes the shutter actually produced')
    const manifest = JSON.stringify({ syntheticRoot: 'z', sha256: createHash('sha256').update(captured).digest('hex') })
    const result = verifyScreenshotBinding(captured, manifest)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/the only sanctioned value is/)
  })

  /**
   * The one place `FIXTURE_REPO_PATH` cannot be imported instead of retyped
   * (review of #22, third re-review): `scripts/dev/visit.mjs` is invoked as
   * plain `node scripts/dev/visit.mjs`, with no TypeScript loader — Node's own
   * type-stripping exists (this box's Node 22.22.2 has it) but is not enabled
   * at that invocation, and enabling it globally to import one string constant
   * would change how every contributor has to run a dev script, for a script
   * whose whole ADR-0026 point is running unmodified on a fussy GPU setup.
   * Importing across that boundary isn't available, so the boundary is
   * tested instead: this reads `visit.mjs`'s own source and asserts its
   * hardcoded value against the SAME `FIXTURE_REPO_PATH` this file imports,
   * rather than against a second retyped literal — the two cannot drift
   * without this test naming which one moved.
   */
  it("visit.mjs's hardcoded synthetic root matches FIXTURE_REPO_PATH — the two cannot drift without this test naming it", () => {
    const visitSource = readFileSync(`${REPO_ROOT}/scripts/dev/visit.mjs`, 'utf8')
    const match = visitSource.match(/const syntheticRoot = '([^']+)'/)
    expect(match, "visit.mjs's substituteSyntheticRoot no longer assigns `const syntheticRoot = '...'` — update this test's pattern to match").not.toBeNull()
    expect(match?.[1]).toBe(FIXTURE_REPO_PATH)
  })

  it('the binding check goes red when the sidecar manifest names different bytes than the image', () => {
    const captured = Buffer.from('the bytes the shutter actually produced')
    const manifest = JSON.stringify({
      syntheticRoot: FIXTURE_REPO_PATH,
      sha256: createHash('sha256').update(Buffer.from('some other capture entirely')).digest('hex'),
    })
    const result = verifyScreenshotBinding(captured, manifest)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/names .* the image bytes hash to/)
  })

  it('the binding check passes when the sidecar manifest names the image’s own bytes', () => {
    const captured = Buffer.from('the bytes the shutter actually produced')
    const manifest = JSON.stringify({
      syntheticRoot: FIXTURE_REPO_PATH,
      sha256: createHash('sha256').update(captured).digest('hex'),
    })
    expect(verifyScreenshotBinding(captured, manifest)).toEqual({ ok: true })
  })

  /**
   * PINS THE NARROWED CLAIM. This is the #22 review finding itself, reproduced:
   * a hand-authored "PNG" (never touched `visit.mjs`, no synthetic-root
   * substitution happened) carrying a real home-directory string in its own
   * bytes, correctly paired with its own SHA-256 and a plausible-looking
   * `syntheticRoot`. It PASSES — on purpose, and this test is what stops that
   * from quietly becoming untrue again. The digest proves the manifest was
   * not silently re-attached to different bytes; it does not and cannot prove
   * those bytes were never a real capture of a real machine. If this
   * assertion ever needs to flip to `false`, the module doc comment above
   * (and this repo's SECURITY.md / an ADR) need to explain what closed the
   * gap — a bare code change here without that story is a regression, not a
   * fix, per the reasoning in this file's own SCREENSHOT BINDING comment.
   */
  it('a hand-forged pair — a real home path baked into the PNG bytes, paired with its own honest digest — is NOT caught: binding is proven, authorship is not', () => {
    // `notallowedname` (not a real contributor) is this file's own established stand-in for
    // "a realistic, non-allowlisted username" — see the home-path detector tests above.
    const forgedPngBytes = Buffer.from(
      '\x89PNG\r\n\x1a\ntEXtComment\x00captured from /home/notallowedname/rhizomorph — not through visit.mjs',
    )
    const manifest = JSON.stringify({
      syntheticRoot: FIXTURE_REPO_PATH,
      sha256: createHash('sha256').update(forgedPngBytes).digest('hex'),
    })
    expect(verifyScreenshotBinding(forgedPngBytes, manifest)).toEqual({ ok: true })
  })

  it('every tracked screenshot is bound to a manifest naming its own SHA-256', () => {
    const violations: string[] = []
    for (const file of trackedFiles()) {
      if (!isTrackedScreenshot(file)) continue
      const pngBytes = readFileSync(`${REPO_ROOT}/${file}`)
      const manifestFile = manifestPathFor(file)
      const manifestContents = isTracked(manifestFile) ? readFileSync(`${REPO_ROOT}/${manifestFile}`, 'utf8') : null
      const result = verifyScreenshotBinding(pngBytes, manifestContents)
      if (!result.ok) violations.push(`${file}: ${result.reason}`)
    }
    expect(violations).toEqual([])
  })
})
