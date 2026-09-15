import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #544's law — a private key cannot be committed or copied into a Docker image.
 *
 * `docs/team-server-runbook.md` tells an operator to create a GitHub App
 * private key and put it on the host. Until now nothing mechanical stopped
 * them putting it in the repository instead: neither `.gitignore` nor
 * `.dockerignore` named a key extension, and the Docker build context is the
 * repository ROOT (`packages/team/deploy/compose.yml`'s `context: ../../..`),
 * so a `.pem` anywhere in the tree reaches an image layer.
 *
 * This law proves the two ignore rules actually refuse a planted key file, by
 * observing the mechanisms' own verdicts rather than grepping the ignore
 * files for the string `*.pem` — a grep passes whether or not the rule works,
 * which is the exact failure this issue exists to close (see M4 in the plan:
 * appending `!*.pem` to `.gitignore` leaves the string in place and must
 * still redden this law).
 *
 * The two halves are deliberately asymmetric and are asserted SEPARATELY:
 *
 * - The git half reads git's own verdict (`git check-ignore`). A gitignore
 *   pattern with no `/` matches the basename at every depth, so `.gitignore`
 *   carries bare patterns only.
 * - The docker half reads a small, DOCUMENTED MODEL of Docker's matcher
 *   (Go `filepath.Match` + `**`), because the suite must run with no daemon
 *   available (`docker info` fails here with no `docker.sock`) and no
 *   package in this tree implements Docker's own matcher. A `.dockerignore`
 *   pattern is matched against the context-root-relative path, and `*` does
 *   not cross a separator — so `.dockerignore` carries BOTH a bare and a
 *   `**\/`-prefixed pattern per extension, matching the existing
 *   `node_modules` / `**\/node_modules` pair already in that file. This model
 *   does NOT cover character classes (`[a-z]`), Go's `\` escape, or Docker's
 *   rule that excluding a directory excludes its contents — none of which any
 *   rule in this repo's `.dockerignore` uses, which a test below asserts
 *   rather than assumes. It also cannot catch a divergence between this model
 *   and whatever `moby/patternmatcher` a given Docker version actually ships
 *   — that would need a daemon-gated build test, a separate decision with its
 *   own cost.
 *
 * Planted files are unmistakably fake: `PLANTED_CONTENTS` is a plain string
 * and no test in this file may ever contain a PEM body or the string
 * `-----BEGIN`.
 *
 * Lives under `packages/server/` for `runbook-delivery-law.test.ts`'s own
 * reason: the root vitest config globs `packages/*`, so a root-level test
 * would never run and would be its own vacuous law.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** Pinned. Widening is a deliberate decision this law forces, not one it silently defers. */
const GUARDED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'] as const

/** Unmistakably not a key. Never a PEM body, never `-----BEGIN`. */
const PLANTED_CONTENTS = 'not a key - planted by secret-file-guard-law.test.ts\n'

/** Comment-stripped, trimmed, non-empty lines of an ignore file at the repo root. */
function ignoreFileRules(file: '.gitignore' | '.dockerignore'): string[] {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * `git check-ignore` exits 0 when the path is ignored and 1 when it is not —
 * exit 1 is a legitimate verdict, not a failure, so this uses `spawnSync`
 * rather than `execFileSync`, which would throw on it. No `--no-index`: the
 * default is the honest end-to-end verdict for an untracked path, which is
 * what every planted file here is.
 */
function isGitIgnored(relPath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`git check-ignore exited ${result.status} for ${relPath}: ${result.stderr}`)
}

/** Repo-root-relative paths `git status --porcelain` currently reports, tracked or not. */
function gitStatusPaths(): string[] {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
}

/**
 * A documented model of Docker's `.dockerignore` pattern syntax — NOT
 * Docker's own matcher. Translates one pattern into an anchored regexp
 * matched against a `/`-separated, context-root-relative path:
 *
 * - a leading `**\/` (or a `**\/` segment) -> zero or more path segments
 * - `*` -> any run of characters NOT containing `/` (does not cross a separator)
 * - `?` -> a single non-separator character
 * - every other character escaped literally
 *
 * Deliberately does not model character classes (`[a-z]`), Go's `\` escape,
 * or directory-exclusion-implies-contents — a test below asserts this repo's
 * `.dockerignore` uses none of that syntax, which is what makes the omission
 * safe rather than a silent gap.
 */
function dockerPatternToRegExp(pattern: string): RegExp {
  let source = ''
  let rest = pattern
  if (rest.startsWith('**/')) {
    source += '(?:[^/]+/)*'
    rest = rest.slice(3)
  }
  for (const ch of rest) {
    if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * True when any rule in `rules` excludes `relPath` under the model above.
 * Negations (`!`) are not modelled — a test below asserts the real
 * `.dockerignore` contains none, which is what makes that omission safe.
 */
function dockerExcludes(rules: string[], relPath: string): boolean {
  return rules.some((rule) => dockerPatternToRegExp(rule).test(relPath))
}

interface Planted {
  stamp: string
  dir: string
  rootPaths: string[]
  depth1Paths: string[]
  depth3Path: string
  exposurePath: string
  controlPath: string
}

/**
 * Plants a uniquely-named set of scratch key files (root depth, depth 1,
 * depth 3, the real runbook exposure path, plus a non-key control), runs
 * `fn` against them, and always cleans up in a `finally` — `force: true`
 * so cleanup survives a file something else already removed. Biome's
 * unsafe-finally lint rule is an error, so the `finally` below contains no
 * return/throw/break/continue.
 *
 * `exposurePath` sits inside `packages/team/deploy/` — the directory
 * `docs/team-server-runbook.md` tells an operator to work in, and where
 * `deploy/.env` already lives. That directory is tracked, so only the
 * planted FILE is removed in the `finally`, never the directory itself.
 * Planting here (rather than only under the isolated `rz-…` scratch dir)
 * is what makes a negation scoped to that exact path — `!packages/team/
 * deploy/*.pem` — reddened rather than invisible; see the "targeted
 * negation" test below.
 *
 * A stray file left behind by a killed run is uniquely named by `stamp` and
 * is itself matched by the rule under test, so it cannot be swept up by a
 * future `git add -A`.
 */
function withPlantedKeyFiles<T>(fn: (planted: Planted) => T): T {
  const stamp = randomUUID()
  const dir = `rz-secret-file-guard-${stamp}`
  const dirAbs = join(REPO_ROOT, dir)
  const rootPaths = GUARDED_EXTENSIONS.map((ext) => `rz-secret-file-guard-${stamp}-scratch${ext}`)
  const depth1Paths = GUARDED_EXTENSIONS.map((ext) => `${dir}/scratch${ext}`)
  const depth3Path = `${dir}/nested/deeper/scratch.pem`
  const exposurePath = `packages/team/deploy/rz-secret-file-guard-${stamp}-scratch.pem`
  const controlPath = `${dir}/scratch.txt`

  mkdirSync(join(dirAbs, 'nested', 'deeper'), { recursive: true })
  for (const relPath of [...rootPaths, ...depth1Paths, depth3Path, exposurePath, controlPath]) {
    writeFileSync(join(REPO_ROOT, relPath), PLANTED_CONTENTS)
  }

  const planted: Planted = { stamp, dir, rootPaths, depth1Paths, depth3Path, exposurePath, controlPath }
  try {
    return fn(planted)
  } finally {
    rmSync(dirAbs, { recursive: true, force: true })
    for (const relPath of rootPaths) {
      rmSync(join(REPO_ROOT, relPath), { force: true })
    }
    // The parent directory (packages/team/deploy) is tracked — only the
    // planted FILE is removed, never the directory.
    rmSync(join(REPO_ROOT, exposurePath), { force: true })
  }
}

describe('git refuses planted key material, anywhere in the tree', () => {
  it('every planted key path is ignored by git itself, at the root and at depth', () => {
    withPlantedKeyFiles((planted) => {
      for (const relPath of [...planted.rootPaths, ...planted.depth1Paths, planted.depth3Path]) {
        expect(isGitIgnored(relPath), `expected ${relPath} to be git-ignored`).toBe(true)
      }
    })
  })

  // The real exposure path, asserted on its own so a negation scoped to
  // exactly this directory (`!packages/team/deploy/*.pem`) cannot hide
  // behind the root/depth-1/depth-3 plants above, which never reach it.
  it('the real exposure path (packages/team/deploy/) is refused too, not only the scratch tree', () => {
    withPlantedKeyFiles((planted) => {
      expect(isGitIgnored(planted.exposurePath), `expected ${planted.exposurePath} to be git-ignored`).toBe(
        true,
      )
    })
  })

  it('the planted control file is NOT ignored — the check is not vacuous', () => {
    withPlantedKeyFiles((planted) => {
      expect(isGitIgnored(planted.controlPath)).toBe(false)
    })
  })

  it('git status does not list a planted key file, and does list the control', () => {
    withPlantedKeyFiles((planted) => {
      const statusPaths = gitStatusPaths()
      expect(statusPaths).toContain(planted.controlPath)
      for (const relPath of [
        ...planted.rootPaths,
        ...planted.depth1Paths,
        planted.depth3Path,
        planted.exposurePath,
      ]) {
        expect(statusPaths, `expected ${relPath} to be absent from git status`).not.toContain(relPath)
      }
    })
  })

  it('git never reports a TRACKED file as ignored — which is why the plant must be untracked', () => {
    // Documents the trap that makes a "does the rule cover an existing
    // tracked file" test vacuous by construction — the same fact
    // runbook-delivery-law.test.ts records for AGENTS.md.
    expect(isGitIgnored('package.json')).toBe(false)
  })
})

describe('the Docker build context refuses the same paths, by its own syntax', () => {
  // Split from the depth case below on purpose: a bare pattern already
  // excludes the context root, so this must stay green even when only the
  // `**/`-prefixed rules are damaged — the depth case is what the `**/` form
  // exists for.
  it('the real .dockerignore excludes every planted key path AT THE ROOT', () => {
    const rules = ignoreFileRules('.dockerignore')
    withPlantedKeyFiles((planted) => {
      for (const relPath of planted.rootPaths) {
        expect(dockerExcludes(rules, relPath), `expected ${relPath} to be docker-excluded`).toBe(true)
      }
    })
  })

  it('the real .dockerignore excludes every planted key path AT DEPTH', () => {
    const rules = ignoreFileRules('.dockerignore')
    withPlantedKeyFiles((planted) => {
      for (const relPath of [...planted.depth1Paths, planted.depth3Path]) {
        expect(dockerExcludes(rules, relPath), `expected ${relPath} to be docker-excluded`).toBe(true)
      }
    })
  })

  it('the real .dockerignore does NOT exclude the control path', () => {
    const rules = ignoreFileRules('.dockerignore')
    withPlantedKeyFiles((planted) => {
      expect(dockerExcludes(rules, planted.controlPath)).toBe(false)
    })
  })

  it('.dockerignore carries no negation at all — last-match-wins cannot be used to reopen this', () => {
    const rules = ignoreFileRules('.dockerignore')
    expect(rules.filter((rule) => rule.startsWith('!'))).toEqual([])
  })

  it('.dockerignore uses no pattern syntax this model does not cover', () => {
    const rules = ignoreFileRules('.dockerignore')
    for (const rule of rules) {
      expect(rule, `${rule} uses syntax outside the documented model`).not.toMatch(/[[\]\\]/)
    }
  })

  it('both spellings are present for every guarded extension', () => {
    const rules = ignoreFileRules('.dockerignore')
    for (const ext of GUARDED_EXTENSIONS) {
      expect(rules, `.dockerignore must carry a bare *${ext} rule`).toContain(`*${ext}`)
      expect(rules, `.dockerignore must carry a **/*${ext} rule`).toContain(`**/*${ext}`)
    }
  })
})

describe('the two mechanisms are different, and this law does not assume otherwise', () => {
  it('a bare pattern reaches every depth in git and only the root in Docker', () => {
    withPlantedKeyFiles((planted) => {
      const depth1Pem = planted.depth1Paths.find((p) => p.endsWith('.pem'))
      if (depth1Pem === undefined) throw new Error('no .pem plant at depth 1')
      expect(isGitIgnored(depth1Pem)).toBe(true)
      expect(dockerExcludes(['*.pem'], depth1Pem)).toBe(false)
      expect(dockerExcludes(['**/*.pem'], depth1Pem)).toBe(true)
    })
  })

  it("the model's own axes", () => {
    const bare = dockerPatternToRegExp('*.pem')
    expect(bare.test('a.pem')).toBe(true)
    expect(bare.test('sub/a.pem')).toBe(false)
    expect(bare.test('deep/er/a.pem')).toBe(false)
    expect(bare.test('a.pem.bak')).toBe(false)
    expect(bare.test('apem')).toBe(false)

    const deep = dockerPatternToRegExp('**/*.pem')
    expect(deep.test('a.pem')).toBe(true)
    expect(deep.test('sub/a.pem')).toBe(true)
    expect(deep.test('deep/er/a.pem')).toBe(true)
  })
})

describe('the ratchet', () => {
  it('GUARDED_EXTENSIONS is pinned', () => {
    expect(GUARDED_EXTENSIONS).toEqual(['.pem', '.key', '.p12', '.pfx'])
  })

  it('.gitignore carries a bare rule for every guarded extension', () => {
    const rules = ignoreFileRules('.gitignore')
    for (const ext of GUARDED_EXTENSIONS) {
      expect(rules, `.gitignore must carry a bare *${ext} rule`).toContain(`*${ext}`)
    }
  })

  it('no tracked file carries key material’s extension', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0)
    const offenders = tracked.filter((path) => GUARDED_EXTENSIONS.some((ext) => path.endsWith(ext)))
    expect(
      offenders,
      'a tracked file matches a guarded key extension — STOP and report on #544; do not add an exception',
    ).toEqual([])
  })

  it('the tracked-file sweep is non-empty', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0)
    expect(tracked.length).toBeGreaterThan(500)
  })

  it('three plant/observe/clean cycles give identical verdicts and leave nothing behind', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      let dirAbs = ''
      let rootAbsPaths: string[] = []
      let exposureAbsPath = ''

      const verdict = withPlantedKeyFiles((planted) => {
        dirAbs = join(REPO_ROOT, planted.dir)
        rootAbsPaths = planted.rootPaths.map((p) => join(REPO_ROOT, p))
        exposureAbsPath = join(REPO_ROOT, planted.exposurePath)
        const dockerRules = ignoreFileRules('.dockerignore')
        const gitPaths = [...planted.rootPaths, ...planted.depth1Paths, planted.depth3Path, planted.exposurePath]
        return {
          gitIgnored: gitPaths.map((p) => isGitIgnored(p)),
          controlIgnored: isGitIgnored(planted.controlPath),
          dockerExcluded: [...planted.rootPaths, ...planted.depth1Paths, planted.depth3Path].map((p) =>
            dockerExcludes(dockerRules, p),
          ),
        }
      })

      // The verdict shape is identical across cycles by construction (the
      // same fixed set of extensions and depths every time) — what this test
      // actually protects is that every observation is consistently `true`
      // for a key path and `false` for the control, cycle after cycle.
      expect(verdict.gitIgnored.every((v) => v === true)).toBe(true)
      expect(verdict.controlIgnored).toBe(false)
      expect(verdict.dockerExcluded.every((v) => v === true)).toBe(true)

      // Cleanup already ran (withPlantedKeyFiles' own finally) by the time
      // this line runs — nothing from this cycle survives it.
      expect(existsSync(dirAbs)).toBe(false)
      for (const abs of rootAbsPaths) {
        expect(existsSync(abs)).toBe(false)
      }
      // The exposure-path plant lives inside the tracked packages/team/deploy
      // directory — only the FILE should be gone, and the directory itself
      // (which the exposure plant does not own) must still exist.
      expect(existsSync(exposureAbsPath)).toBe(false)
      expect(existsSync(join(REPO_ROOT, 'packages/team/deploy'))).toBe(true)
    }
  })
})
