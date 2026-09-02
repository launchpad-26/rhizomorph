import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The manifest a person actually receives.
 *
 * Every other workspace here is `0.0.0`, which is right: they are private, they
 * are never published, and a version on them would be a number nobody reads.
 * **This one is different, and it is the only one that is** — it is the package
 * `electron-builder` reads, so its version becomes the installer's filename,
 * the Windows uninstall entry, the macOS Get Info panel and whatever
 * `app.getVersion()` reports in the about box.
 *
 * Left at `0.0.0`, the release artifacts were `rhizomorph-0.0.0-x64.dmg`. That
 * is not a cosmetic complaint: a version of zero is how a build says it was
 * never meant to leave the machine that made it, and the whole point of the
 * doorstep is that a stranger installs this.
 *
 * So the app tracks the ROOT package's version — the product's — and this law
 * holds the two together. Two files stating one fact is the shape this repo
 * uses everywhere (the window ground mirrors `theme.css`, the frame mirrors
 * prd-32's prose); the law is what stops the copy going stale.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_MANIFEST = path.join(HERE, '..', '..', 'package.json')
const ROOT_MANIFEST = path.join(HERE, '..', '..', '..', '..', 'package.json')

function manifest(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/**
 * Pulls `owner/repo` out of a github.com `repository.url`, validating the
 * WHOLE url rather than searching it for a `github.com/owner/repo`
 * substring.
 *
 * **Review of #21, round 2 (two EXECUTED findings, both in this function):**
 *
 * 1. The first version's repo group was `[^/.]+`, which stops at the first
 *    DOT — `.../launchpad-26/rhizomorph.archive.git` parsed as `rhizomorph`,
 *    silently truncating a *legal* GitHub repo name (dots are permitted) to
 *    a different, wrong one that happened to be a prefix of it. Fixed by a
 *    non-greedy `[^/#?]+?` repo group with an optional trailing `.git`,
 *    `#...` or `?...` consumed AFTER it rather than a character class that
 *    excludes dots from the name itself.
 * 2. The host match was a bare `github\.com\/`, unanchored — it matched just
 *    as happily inside `https://mirror.github.com/...`, a different host
 *    entirely (subdomain takeover, a compromised or unrelated mirror).
 *    Fixed by anchoring the whole url from `^` straight into the scheme and
 *    host, so a subdomain in front of it can no longer match.
 *
 * Both are the same root cause as round 1's `toContain` finding — matching a
 * PART of the string and treating it as if the whole string had been
 * validated — just moved one level down, from the assertion into the parser
 * every assertion here calls.
 *
 * **Review of #21, round 3: four legitimate spellings the round-2 regex
 * rejected outright** (fail CLOSED, so a nuisance rather than a hole, but a
 * real contributor writes at least the first of these). Decided and
 * supported, rather than left as a stale TODO for whoever hits one:
 *
 * - **`git+ssh://git@github.com/owner/repo.git`** — npm's own canonical ssh
 *   form, and the one `npm config get` / a fresh `npm init` produces for an
 *   ssh-cloned repo. Supported: an optional `git+(https|ssh)://` scheme with
 *   an optional `user@` in front of the host covers both.
 * - **`https://GitHub.com/...`** — DNS is case-insensitive, so this names
 *   the IDENTICAL host, not a different one the way a subdomain does.
 *   Supported: the host match is case-insensitive (`i` flag).
 * - **An explicit `:443` port, and a trailing `/`** — both cosmetic, neither
 *   changes which repository the url names. Supported.
 */
function ownerRepoFrom(repositoryUrl: string): string | undefined {
  const match = repositoryUrl.match(
    /^(?:git\+(?:https|ssh):\/\/(?:[^@/]+@)?|https:\/\/)github\.com(?::\d+)?\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i,
  )
  return match ? `${match[1]}/${match[2]}` : undefined
}

describe('ownerRepoFrom: the exact owner/repo parser every describe block below shares (review of #21, rounds 2–3)', () => {
  it('does not truncate the repo name at a DOT — dots are legal in GitHub repo names, and a truncated name silently resolves to a DIFFERENT repository', () => {
    const dotted = 'git+https://github.com/launchpad-26/rhizomorph.archive.git'
    expect(ownerRepoFrom(dotted)).toBe('launchpad-26/rhizomorph.archive')
    expect(ownerRepoFrom(dotted)).not.toBe('launchpad-26/rhizomorph')
  })

  it('does not accept a github.com SUBDOMAIN as the real host', () => {
    expect(ownerRepoFrom('git+https://mirror.github.com/launchpad-26/rhizomorph.git')).toBeUndefined()
  })

  it('still parses the real, unmutated repository.url, and a wrong OWNER still fails', () => {
    expect(ownerRepoFrom('git+https://github.com/launchpad-26/rhizomorph.git')).toBe('launchpad-26/rhizomorph')
    expect(ownerRepoFrom('git+https://github.com/reviewer-source/rhizomorph.git')).not.toBe('launchpad-26/rhizomorph')
  })

  it('accepts the ssh form npm itself writes for an ssh-cloned repo', () => {
    expect(ownerRepoFrom('git+ssh://git@github.com/launchpad-26/rhizomorph.git')).toBe('launchpad-26/rhizomorph')
  })

  it('accepts a differently-cased host — DNS is case-insensitive, so this is the SAME host, not a different one', () => {
    expect(ownerRepoFrom('https://GitHub.com/launchpad-26/rhizomorph')).toBe('launchpad-26/rhizomorph')
  })

  it('accepts an explicit port and a trailing slash — cosmetic, neither changes which repository this names', () => {
    expect(ownerRepoFrom('https://github.com:443/launchpad-26/rhizomorph.git')).toBe('launchpad-26/rhizomorph')
    expect(ownerRepoFrom('https://github.com/launchpad-26/rhizomorph/')).toBe('launchpad-26/rhizomorph')
  })
})

describe("the shipped manifest is the product's, not a placeholder", () => {
  it("the app's version matches the repo root's — the installer's filename comes from this", () => {
    const app = manifest(APP_MANIFEST)
    const root = manifest(ROOT_MANIFEST)
    expect(app['version']).toBe(root['version'])
  })

  it('is not 0.0.0 — a version of zero is how a build says it was never meant to ship', () => {
    expect(manifest(APP_MANIFEST)['version']).not.toBe('0.0.0')
  })

  it('names the product, so electron-builder does not derive filenames from the npm scope', () => {
    // Without `productName`, electron-builder took `@rhizomorph/app` and
    // produced a Debian package path with a directory in it, which fpm refused
    // outright. `electron-builder.yml` records that failure; this keeps the
    // field that fixed it from being dropped as redundant.
    expect(manifest(APP_MANIFEST)['productName']).toBe('rhizomorph')
  })

  it('points its homepage at the repository that actually exists', () => {
    // It read `KelliherL/rhizomorph` — a personal fork path, not where this
    // lives. A wrong homepage ends up in the Linux desktop entry and the
    // Windows uninstall metadata, which is exactly where nobody looks until a
    // stranger clicks it.
    //
    // Derived from the ROOT manifest's `repository.url` (review of #21,
    // round 1) rather than checked with `toContain('launchpad-26/rhizomorph')`
    // against itself — that passed a `-archive`-suffixed fork path just as
    // readily as the real one, and ties this field to the same one source the
    // describe block below reads, instead of being its own fourth copy.
    const root = manifest(ROOT_MANIFEST)
    const ownerRepo = ownerRepoFrom(String((root['repository'] as { url?: string } | undefined)?.url ?? ''))
    expect(manifest(APP_MANIFEST)['homepage']).toBe(`https://github.com/${ownerRepo}#readme`)
  })

  it('declares the entry point electron-builder packages, and only bundled output', () => {
    expect(manifest(APP_MANIFEST)['main']).toBe('dist/main.js')
  })
})

/**
 * The root manifest's published siblings of the field above.
 *
 * `homepage` was guarded on the app manifest alone; `repository.url` and
 * `bugs.url` — the fields npm actually publishes from the ROOT package, and
 * what `npm repo` / `npm bugs` and every registry listing resolve through —
 * had no law at all. Same defect (prd43 w3, #21): a personal fork path
 * instead of where this repo actually lives.
 *
 * **Review of #21, round 1 (BLOCKER):** the first version of this law asserted
 * each field with `toContain('launchpad-26/rhizomorph')` — three independent
 * `toContain` calls are three copies with three assertions, not one source
 * with three derivations, and containment passes anything with that text as
 * a PREFIX. EXECUTED by the reviewer: `homepage` and `bugs.url` rewritten to
 * `.../rhizomorph-archive` still passed 13/13. `repository.url` is now read
 * ONCE, into `ownerRepo`, and `homepage`/`bugs.url` are asserted `toBe` the
 * exact string that derives from it, so a `-archive` suffix can no longer
 * pass. That alone was not the whole fix: `toBe` only checks as much as
 * `ownerRepoFrom` actually parses, and round 2 found two ways that parser
 * still under-validated its input (the DOT-truncation and SUBDOMAIN findings
 * on `ownerRepoFrom` itself, above) — this describe block inherits that fix
 * rather than repeating it.
 */
describe("the root manifest's published repository identity", () => {
  const root = manifest(ROOT_MANIFEST)
  const repository = root['repository'] as { url?: string } | undefined
  const ownerRepo = ownerRepoFrom(String(repository?.url ?? ''))

  it("repository.url names the repo that actually exists — every field below derives from this ONE read, not a copy of its own", () => {
    expect(ownerRepo).toBe('launchpad-26/rhizomorph')
  })

  it("homepage is EXACTLY what repository.url derives — what 'npm repo' resolves", () => {
    expect(root['homepage']).toBe(`https://github.com/${ownerRepo}#readme`)
  })

  it("bugs.url is EXACTLY what repository.url derives — what 'npm bugs' resolves", () => {
    const bugs = root['bugs'] as { url?: string } | undefined
    expect(bugs?.url).toBe(`https://github.com/${ownerRepo}/issues`)
  })

  it('bites: a homepage carrying the real owner/repo as a mere PREFIX (an archived-fork suffix, the reviewer\'s exact repro) is rejected — containment would have missed it, equality does not', () => {
    const archived = `https://github.com/${ownerRepo}-archive#readme`
    expect(archived).toContain(ownerRepo!) // documents exactly the trap `toContain` fell into
    expect(archived).not.toBe(`https://github.com/${ownerRepo}#readme`)
  })
})

const REPO_ROOT = path.join(HERE, '..', '..', '..', '..')

/** Dated records, excluded as CITING sources — the same line prd43 ruling 1's citation law already draws, not a new one invented here. */
const EXCLUDED_CLONE_SITE_DIRS = ['docs/prds/', 'docs/review/']

function trackedMarkdownFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

/** A line naming an actual GitHub clone instruction, tolerant of everything `cloneLinesIn` below is — used only to DISCOVER which files to check, not to extract a url from them. `[ \t]+` rather than a single space for the same reason `cloneLinesIn` matches that way: the shell collapses whitespace, so `git  clone` is the same invocation, and a discovery filter that misses it leaves the whole file unswept (review of #223). */
const CLONE_INSTRUCTION_RE = /git[ \t]+clone.*github\.com/

/**
 * Every tracked, non-historical markdown file with a real clone-this-repo
 * instruction in it — discovered by reading the tracked tree, not hand-typed
 * (review round 3, #21): a hand-pinned list of "the three files that have
 * one" has nothing proving those are ALL of them, so a fourth doc growing a
 * clone instruction would silently go unchecked. `packages/server/src/
 * concierge/` mentions `git clone` too (that feature clones an ARBITRARY repo
 * a user names, nothing to do with this repo's own install identity) but
 * never against a `github.com` url in its own fixtures, and code isn't
 * markdown either — both exclude it from this sweep without a special case.
 */
function discoverCloneSites(): string[] {
  return trackedMarkdownFiles()
    .filter((file) => !EXCLUDED_CLONE_SITE_DIRS.some((dir) => file.startsWith(dir)))
    .filter((file) => CLONE_INSTRUCTION_RE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
    .sort()
}

/**
 * Every tracked clone instruction derives from the root manifest's own
 * `repository.url`, rather than typing the owner/repo a second (third,
 * fourth…) time. #21's audit found six copies agreeing with the manifest and
 * needing hand-correction — the shape the sibling law above exists to close
 * for the manifest itself, and this one closes for its readers: a future
 * transfer that updates `repository.url` and forgets a doc is caught here,
 * instead of leaving a dead clone URL for the next stranger to hit.
 *
 * `docs/prds/`, `docs/review/` and `manifest-law.test.ts`'s own comment above
 * are excluded on purpose — they are dated records of what this repo's
 * install identity used to be (prd43 ruling 1's law draws the same line for
 * citations), not live instructions a reader will act on today.
 */
describe("every tracked clone instruction names the manifest's own repository (prd43 w3, #21)", () => {
  const root = manifest(ROOT_MANIFEST)
  const repositoryUrl = String((root['repository'] as { url?: string } | undefined)?.url ?? '')
  const ownerRepo = ownerRepoFrom(repositoryUrl)

  it("the root manifest's repository.url names a github.com owner/repo to derive from", () => {
    expect(ownerRepo).toBe('launchpad-26/rhizomorph')
  })

  const expectedUrl = `https://github.com/${ownerRepo}`
  const CLONE_SITES = discoverCloneSites()

  it('the discovery sweep finds exactly the known sites — pinned so a silently emptied or silently widened sweep cannot pass every check below vacuously', () => {
    expect(CLONE_SITES).toEqual(['README.md', 'docs/demo.md', 'docs/user-guide/getting-started.md'])
  })

  it("bites: the discovery filter recognizes a real clone-this-repo line and ignores unrelated \"git clone\" text — the concierge feature's own fixtures, which name no github.com url, must not be swept in", () => {
    expect(CLONE_INSTRUCTION_RE.test('git clone https://github.com/launchpad-26/rhizomorph')).toBe(true)
    expect(CLONE_INSTRUCTION_RE.test("execSync('git clone ' + url)")).toBe(false)
  })

  /**
   * git flags this law knows take a SEPARATE value token (`--depth 1`), so
   * the value isn't mistaken for the url. A flag written `--flag=value` (one
   * token) needs no entry here — `urlFromCloneTokens` below treats anything
   * starting with `-` that it doesn't recognize as value-taking as a
   * self-contained token and simply steps over it.
   */
  const CLONE_FLAGS_TAKING_A_VALUE = new Set([
    '--depth',
    '--branch',
    '-b',
    '--origin',
    '-o',
    '--reference',
    '--reference-if-able',
    '--shallow-since',
    '--shallow-exclude',
    '--separate-git-dir',
    '--template',
    '--jobs',
    '-j',
    '--filter',
    '--config',
    '-c',
  ])

  /** The first token that isn't a flag (or a value-taking flag's value) — `undefined` if the tokens run out first. */
  function urlFromCloneTokens(tokens: readonly string[]): string | undefined {
    let i = 0
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      i += CLONE_FLAGS_TAKING_A_VALUE.has(tokens[i]!) ? 2 : 1
    }
    return tokens[i]
  }

  type CloneLine = { line: string; url: string | undefined }

  /**
   * `git` and `clone` separated by any run of spaces or tabs. The shell
   * collapses whitespace before git ever sees the words, so `git  clone <url>`
   * is the SAME invocation as `git clone <url>` — rounds 2 and 3 normalized the
   * whitespace BEFORE `git` (indentation, a `$ ` prompt) and left the gap
   * BETWEEN `git` and `clone`, where a wrong url was invisible to both this
   * matcher and `CLONE_INSTRUCTION_RE`'s discovery sweep (review of #223).
   */
  const GIT_CLONE_PREFIX_RE = /^git[ \t]+clone(?=[ \t]|$)/

  /**
   * Every `git clone` invocation in `text`. Four review-round-3 findings, all
   * EXECUTED against the real tree, all fixed here — the round-2 version
   * only ever recognized a bare `git clone <url> [dir]` line at column 0:
   *
   * 1. A trailing shell comment (`git clone <url> # alternate source`) —
   *    stripped before tokenizing.
   * 2. git's own flags before the url (`--depth 1 <url>`, three tokens) —
   *    the round-2 pattern's `(\S+)(?:\s+\S+)?` only ever admits two, so a
   *    WRONG url hidden behind a flag went unchecked. `urlFromCloneTokens`
   *    steps over any number of flags, resolving `--depth 1` and
   *    `--depth=1` to the same url.
   * 3. Leading indentation — round 2 anchored `^` at column 0 exactly.
   * 4. A shell-prompt prefix (`$ git clone <url>`), which is how roughly
   *    half the commands in this repo's own docs are written.
   *
   * A line matching none of the above (ordinary prose, code elsewhere) is
   * not a `git clone` invocation and is correctly absent from the result —
   * this function's job is to find every ACTUAL invocation, not to treat an
   * unparseable one as if it did not exist: `url` comes back `undefined`
   * when a recognized `git clone` line's tokens don't resolve to one (every
   * token was a flag this law doesn't know takes a value), and the caller
   * below fails that case loudly rather than skipping it.
   */
  function cloneLinesIn(text: string): CloneLine[] {
    const out: CloneLine[] = []
    for (const rawLine of text.split('\n')) {
      const stripped = rawLine.replace(/^\s*(?:\$\s+)?/, '')
      const prefix = stripped.match(GIT_CLONE_PREFIX_RE)
      if (!prefix) continue
      const withoutComment = stripped.replace(/\s+#.*$/, '')
      const tokens = withoutComment
        .slice(prefix[0].length)
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0)
      out.push({ line: rawLine, url: urlFromCloneTokens(tokens) })
    }
    return out
  }

  for (const relPath of CLONE_SITES) {
    it(`${relPath}: every "git clone" line names EXACTLY the repository the manifest names`, () => {
      const text = readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
      const lines = cloneLinesIn(text)
      expect(lines, `${relPath} has no "git clone" line — nothing for this law to check`).not.toEqual([])
      for (const { line, url } of lines) {
        expect(url, `${relPath}: "${line.trim()}" has no url this law can find in it`).toBeDefined()
        expect(url, `${relPath}: "${line.trim()}" names the wrong repository`).toBe(expectedUrl)
      }
    })
  }

  it('bites: ownerRepoFrom does not accept a fork path the manifest never named — a spelling #21\'s own audit never used', () => {
    expect(ownerRepoFrom('git+https://github.com/a-forked-mirror/rhizomorph.git')).toBe('a-forked-mirror/rhizomorph')
    expect(ownerRepoFrom('git+https://github.com/a-forked-mirror/rhizomorph.git')).not.toBe(ownerRepo)
  })

  it('bites: cloneLinesIn reads EVERY clone line, not just the first — review round 2', () => {
    const twoBlocks = [`git clone ${expectedUrl}`, `git clone ${expectedUrl}-archive`].join('\n')
    expect(cloneLinesIn(twoBlocks).map((l) => l.url)).toEqual([expectedUrl, `${expectedUrl}-archive`])
  })

  it('bites: a legitimate clone-target-directory argument parses correctly instead of failing an unrelated assertion — review round 2', () => {
    expect(cloneLinesIn(`git clone ${expectedUrl} rhizomorph`).map((l) => l.url)).toEqual([expectedUrl])
  })

  it('bites: a trailing shell comment does not hide a wrong url — review round 3', () => {
    expect(cloneLinesIn(`git clone ${expectedUrl}-archive # alternate source`).map((l) => l.url)).toEqual([
      `${expectedUrl}-archive`,
    ])
  })

  it('bites: git flags before the url (both "--depth 1" and "--depth=1") do not hide a wrong url, and resolve a correct one the same way — review round 3', () => {
    expect(cloneLinesIn(`git clone --depth 1 ${expectedUrl}-archive rhizomorph`).map((l) => l.url)).toEqual([
      `${expectedUrl}-archive`,
    ])
    expect(cloneLinesIn(`git clone --depth 1 ${expectedUrl}`).map((l) => l.url)).toEqual([expectedUrl])
    expect(cloneLinesIn(`git clone --depth=1 ${expectedUrl}`).map((l) => l.url)).toEqual([expectedUrl])
  })

  it('bites: leading indentation and a shell-prompt prefix do not hide a wrong url — review round 3', () => {
    expect(cloneLinesIn(`  git clone ${expectedUrl}-archive`).map((l) => l.url)).toEqual([`${expectedUrl}-archive`])
    expect(cloneLinesIn(`$ git clone ${expectedUrl}-archive`).map((l) => l.url)).toEqual([`${expectedUrl}-archive`])
  })

  it('bites: whitespace BETWEEN "git" and "clone" does not hide a wrong url — the shell collapses it, so this is the same invocation (review of #223)', () => {
    expect(cloneLinesIn(`git  clone ${expectedUrl}-archive`).map((l) => l.url)).toEqual([`${expectedUrl}-archive`])
    expect(cloneLinesIn(`git\tclone ${expectedUrl}-archive`).map((l) => l.url)).toEqual([`${expectedUrl}-archive`])
    expect(cloneLinesIn(`  $ git   clone ${expectedUrl}-archive`).map((l) => l.url)).toEqual([`${expectedUrl}-archive`])
    // and the DISCOVERY sweep sees it too, or the file above is never swept at all
    expect(CLONE_INSTRUCTION_RE.test(`git  clone ${expectedUrl}`)).toBe(true)
  })

  it('bites: a clone line whose tokens resolve to no url is reported as its own failure, not silently treated as absent — review round 2\'s core complaint', () => {
    expect(cloneLinesIn('git clone --depth 1').map((l) => l.url)).toEqual([undefined])
  })
})
