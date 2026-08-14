import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import {
  assertCloneTarget,
  assertMigrationPaths,
  CloneFenceError,
  conciergeRoot,
  defaultClonesRoot,
  isInside,
  MigrationFenceError,
} from './paths.js'

/**
 * The fourth hand's clone fence, tested against real directories on a real
 * filesystem — symlinks, `..` spellings and case included. The namespace law
 * beside this file asserts the same predicate as *law*; this file is the
 * ordinary unit coverage that stops the predicate quietly changing meaning.
 */

describe('conciergeRoot', () => {
  it('is a sibling of the lab and the event log under the data root', () => {
    expect(conciergeRoot('/data')).toBe(path.join('/data', 'concierge'))
  })

  it('resolves a relative data root, so the fence never compares a cwd-dependent path', () => {
    expect(path.isAbsolute(conciergeRoot('data'))).toBe(true)
  })
})

describe('defaultClonesRoot', () => {
  it('is a visible top-level directory, not the hidden data root', () => {
    expect(defaultClonesRoot()).toBe(path.join(homedir(), 'rhizomorph', 'repos'))
  })
})

describe('the clone fence', () => {
  let root: string
  let clonesRoot: string
  let watchedRepoPath: string
  let dataRoot: string

  function fence() {
    return { clonesRoot, watchedRepoPath, dataRoot }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-paths-test-'))
    clonesRoot = path.join(root, 'clones')
    watchedRepoPath = path.join(root, 'watched-repo')
    dataRoot = path.join(root, 'data')
    await mkdir(clonesRoot, { recursive: true })
    await mkdir(watchedRepoPath, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('allows an ordinary clone into the root it was handed', () => {
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'some-repo'))).not.toThrow()
  })

  it('allows a nested clone — a target need only be under the root, not directly in it', () => {
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'github.com', 'owner', 'repo'))).not.toThrow()
  })

  it('refuses a target outside the clone root', () => {
    expect(() => assertCloneTarget(fence(), path.join(root, 'elsewhere'))).toThrow(CloneFenceError)
  })

  it('refuses the clone root itself — the root holds clones, it is not one', () => {
    expect(() => assertCloneTarget(fence(), clonesRoot)).toThrow(/not strictly inside/)
  })

  it('refuses a `..` escape, however it is spelled', () => {
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, '..', 'escaped'))).toThrow(CloneFenceError)
    // The spelling that walks out and back in is NOT an escape, and must still pass.
    expect(() =>
      assertCloneTarget(fence(), path.join(clonesRoot, '..', 'clones', 'ok', '..', 'also-ok')),
    ).not.toThrow()
  })

  it('refuses a target reached through a symlink that leaves the clone root — the hostile case', async () => {
    // A link INSIDE the permitted directory pointing OUT of it. Its own
    // un-followed spelling passes a raw prefix check; every byte written
    // through it lands in `outside`.
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(clonesRoot, 'bolthole'))

    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'bolthole', 'repo'))).toThrow(CloneFenceError)
  })

  it('allows a target under a clone root that is ITSELF reached through a symlink — the benign macOS case', async () => {
    const realClones = path.join(root, 'real-clones')
    await mkdir(realClones, { recursive: true })
    const linkedClones = path.join(root, 'clones-link')
    await symlink(realClones, linkedClones)

    // Handed the link, given a target spelled through the real directory: the
    // /var vs /private/var shape #217 was about, and not an escape.
    expect(() =>
      assertCloneTarget({ ...fence(), clonesRoot: linkedClones }, path.join(realClones, 'repo')),
    ).not.toThrow()
  })

  it('refuses a clone root inside the watched repo — never a write in the operator\'s working tree', () => {
    const insideRepo = path.join(watchedRepoPath, 'clones')
    expect(() => assertCloneTarget({ ...fence(), clonesRoot: insideRepo }, path.join(insideRepo, 'repo'))).toThrow(
      /overlaps the watched repo/,
    )
  })

  it('refuses a clone root that CONTAINS the watched repo — the same trespass, wider hat', () => {
    expect(() => assertCloneTarget({ ...fence(), clonesRoot: root }, path.join(root, 'repo'))).toThrow(
      /overlaps the watched repo/,
    )
  })

  it('refuses a clone root that IS the watched repo', () => {
    expect(() =>
      assertCloneTarget({ ...fence(), clonesRoot: watchedRepoPath }, path.join(watchedRepoPath, 'repo')),
    ).toThrow(/overlaps the watched repo/)
  })

  it('refuses a target inside the watched repo even when the root is legitimate', async () => {
    // Reached by a symlink from inside the clone root, so clause 3 passes on
    // the raw spelling and only the watched-repo clause can catch it.
    await symlink(watchedRepoPath, path.join(clonesRoot, 'repo-link'))
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'repo-link', 'nested'))).toThrow(CloneFenceError)
  })

  it('refuses a clone root parked in another hand\'s namespace under the data root', () => {
    // The recorder's session directories are `dataRoot`'s direct children; the
    // lab's worktrees are `<dataRoot>/lab`. Neither is the concierge's to write.
    for (const stolen of [path.join(dataRoot, 'lab', 'worktrees'), path.join(dataRoot, 'some-repo-deadbeef')]) {
      expect(() => assertCloneTarget({ ...fence(), clonesRoot: stolen }, path.join(stolen, 'repo'))).toThrow(
        /belongs to the other hands/,
      )
    }
  })

  it('allows a clone root under the concierge\'s own footprint inside the data root', () => {
    const mine = path.join(conciergeRoot(dataRoot), 'clones')
    expect(() => assertCloneTarget({ ...fence(), clonesRoot: mine }, path.join(mine, 'repo'))).not.toThrow()
  })

  it('allows a clone root entirely outside the data root — what the open question will probably choose', () => {
    expect(() => assertCloneTarget(fence(), path.join(clonesRoot, 'repo'))).not.toThrow()
    expect(isInside(dataRoot, clonesRoot)).toBe(false) // the premise of the test above
  })

  it('names the clause it refused on, so a failure is debuggable', () => {
    expect(() => assertCloneTarget(fence(), path.join(root, 'elsewhere'))).toThrow(/ADR-0019/)
  })
})

/**
 * The fourth hand's THIRD power (prd-20 ruling 6 / ADR-0020), against real
 * directories on a real filesystem — every path here is under one `mkdtemp`
 * root, so the suite never reads or writes the machine's own `~/.claude`.
 *
 * The root is `realpathSync`'d immediately: `mkdtemp` hands back the raw
 * `/var/folders/…` spelling on macOS, where `/var` is a symlink, and the fence
 * canonicalizes the watched repo before slugging it. Without this, the
 * destination's slug and the tests' own expectations would disagree on one
 * platform and agree on the other — the exact shape the macOS CI leg exists to
 * catch, and worth removing from every test that is not ABOUT it (there is one
 * below that is).
 */
describe('the migration fence', () => {
  const SESSION_ID = 'edf0eb2b-9c37-4d15-8f06-99e9306cdac6'

  let root: string
  let claudeProjectsRoot: string
  let watchedRepoPath: string
  /** Where the conversation was had — the cwd the event log attributed it to. */
  let originRepoPath: string
  let originTranscript: string

  function fence() {
    return { claudeProjectsRoot, watchedRepoPath }
  }

  function attribution(overrides: Partial<{ sessionId: string; worktreePath: string | null }> = {}) {
    return { sessionId: SESSION_ID, worktreePath: originRepoPath, ...overrides }
  }

  /** Where a resume in `repoPath` looks for `sessionId` — the destination, spelled independently. */
  function slugDir(repoPath: string): string {
    return path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
  }

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-migration-test-')))
    claudeProjectsRoot = path.join(root, 'claude-projects')
    watchedRepoPath = path.join(root, 'watched-repo')
    originRepoPath = path.join(root, 'origin-repo')
    await mkdir(claudeProjectsRoot, { recursive: true })
    await mkdir(watchedRepoPath, { recursive: true })
    await mkdir(originRepoPath, { recursive: true })

    // The transcript, where the collector would have tailed it.
    await mkdir(slugDir(originRepoPath), { recursive: true })
    originTranscript = path.join(slugDir(originRepoPath), `${SESSION_ID}.jsonl`)
    await writeFile(originTranscript, '{"type":"user","sessionId":"x"}\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('derives both paths from the attribution — the one thing the power is for', () => {
    expect(assertMigrationPaths(fence(), attribution())).toEqual({
      source: originTranscript,
      destination: path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`),
    })
  })

  it('lands in the WATCHED repo\'s slug directory, never the origin\'s — the wrong-slug destination', () => {
    // The mutation this exists to catch: deriving the destination directory
    // from `attribution.worktreePath` instead of from the watched repo would
    // copy the file onto itself, and resume from the watched repo would never
    // find it (the spike's Q1 control: lookup is slug-scoped to the cwd).
    const { destination } = assertMigrationPaths(fence(), attribution())
    expect(path.dirname(destination)).toBe(slugDir(watchedRepoPath))
    expect(path.dirname(destination)).not.toBe(slugDir(originRepoPath))
    expect(path.basename(destination)).toBe(`${SESSION_ID}.jsonl`)
  })

  it('slugs the watched repo by where it REALLY is, not by the spelling it was handed', async () => {
    // The macOS `/var` → `/private/var` shape, reproduced on any filesystem
    // (#217's trick). Claude Code slugs its own `process.cwd()`, which Node has
    // already resolved, so a file placed under the LINK's slug would sit in a
    // directory no resume ever reads.
    const linked = path.join(root, 'watched-link')
    await symlink(watchedRepoPath, linked)

    const { destination } = assertMigrationPaths({ ...fence(), watchedRepoPath: linked }, attribution())
    expect(path.dirname(destination)).toBe(slugDir(watchedRepoPath))
    expect(path.dirname(destination)).not.toBe(slugDir(linked))
  })

  it('refuses a traversal-shaped session id before it builds any path at all', () => {
    // `..` and `.` are in this list because `path.basename` returns them
    // unchanged, so `isSafeSessionId` — the shared check — admits both. Found
    // by running this test, not by reading the function.
    for (const sessionId of ['..', '../../etc/passwd', '/etc/passwd', 'a/b', `${SESSION_ID}\0.jsonl`, '.']) {
      expect(
        () => assertMigrationPaths(fence(), attribution({ sessionId })),
        `permitted the session id ${JSON.stringify(sessionId)}`,
      ).toThrow(/not a bare session id/)
    }
  })

  it('refuses when the destination\'s slug directory is a symlink out of the projects root', async () => {
    // The hostile spelling: the directory the file would land in is a link
    // pointing anywhere. Its un-followed name passes a raw prefix check; every
    // byte written through it lands in `outside`.
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, slugDir(watchedRepoPath))

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/does not resolve inside/)
  })

  it('refuses a destination inside the watched repo\'s working tree, however the roots are arranged', async () => {
    // prd-20's non-goal, and the clone fence's own fourth clause. Clause 2 is
    // satisfied here — the destination IS inside the projects root it was
    // given — so only the independent clause can catch it.
    const insideRepo = path.join(watchedRepoPath, '.claude', 'projects')
    await mkdir(insideRepo, { recursive: true })
    expect(() => assertMigrationPaths({ ...fence(), claudeProjectsRoot: insideRepo }, attribution())).toThrow(
      /is inside the watched repo/,
    )
  })

  it('refuses to overwrite — the copy is create-only', async () => {
    await mkdir(slugDir(watchedRepoPath), { recursive: true })
    await writeFile(path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`), 'someone else\'s conversation\n')

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/already exists/)
  })

  it('refuses a DANGLING symlink at the destination too — the sibling case `existsSync` misses', async () => {
    // `existsSync` follows the link and answers false; `copyFile` follows it
    // and creates the target. Only an `lstat` sees the thing that is there.
    //
    // The link points INSIDE the projects root deliberately: a dangling link
    // pointing out of it is refused too, but by clause 2 (`canonicalize`
    // chases a dangling target), and then this test would pass without the
    // create-only clause ever running.
    await mkdir(slugDir(watchedRepoPath), { recursive: true })
    await symlink(
      path.join(claudeProjectsRoot, 'nothing-here'),
      path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`),
    )

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/already exists/)
  })

  it('refuses when the transcript is already where a resume in the watched repo would look', async () => {
    // Nothing to migrate: the conversation was had in the watched repo itself.
    // Caught before the create-only clause, so the operator is told WHY rather
    // than that something is in the way.
    const alreadyHere = path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`)
    await mkdir(path.dirname(alreadyHere), { recursive: true })
    await writeFile(alreadyHere, '{"type":"user"}\n')

    expect(() => assertMigrationPaths(fence(), attribution({ worktreePath: watchedRepoPath }))).toThrow(
      /already where a resume/,
    )
  })

  it('never names a source the attribution does not derive — an arbitrary path is unrepresentable', async () => {
    // A perfectly good transcript, with the right name, sitting somewhere the
    // event log never pointed at. There is no parameter that could ask for it,
    // and nothing the fence derives resolves to it.
    const elsewhere = path.join(root, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(path.join(elsewhere, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
    await rm(originTranscript)

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/no transcript for session/)
  })

  it('refuses a source that is not a regular file', async () => {
    await rm(originTranscript)
    await mkdir(originTranscript) // a DIRECTORY wearing the transcript's name

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/no transcript for session/)
  })

  it('refuses a source reached through a symlink that leaves the source root', async () => {
    // The mirror of the destination case: the ORIGIN's slug directory is a
    // link out of the projects root, so the candidate path resolves somewhere
    // the attribution never named. `candidateTranscriptPaths` drops it, and
    // there is nothing left to migrate.
    await rm(slugDir(originRepoPath), { recursive: true })
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
    await symlink(outside, slugDir(originRepoPath))

    expect(() => assertMigrationPaths(fence(), attribution())).toThrow(/no transcript for session/)
  })

  it('refuses an attribution that never named a worktree — there is nothing to derive from', () => {
    expect(() => assertMigrationPaths(fence(), attribution({ worktreePath: null }))).toThrow(
      /<no candidate path passed containment>/,
    )
  })

  it('accepts the transcript beside its worktree — the `--extra-sessions` candidate', async () => {
    await rm(slugDir(originRepoPath), { recursive: true })
    const beside = path.join(originRepoPath, `${SESSION_ID}.jsonl`)
    await writeFile(beside, '{"type":"user"}\n')

    expect(assertMigrationPaths(fence(), attribution()).source).toBe(beside)
  })

  it('reads a foreign projects root when it is given one — the cross-host case', async () => {
    // `research/2026-08-14-cross-host-resume.md` Q2: a Windows-authored
    // transcript, reached through a mount, resumed on Linux. The source ROOT
    // moves; the directory beneath it and the filename are still derived.
    const foreignRoot = path.join(root, 'mnt-c-users-lachl-claude-projects')
    const foreignSlugDir = path.join(foreignRoot, worktreePathToProjectSlug(originRepoPath))
    await mkdir(foreignSlugDir, { recursive: true })
    const foreign = path.join(foreignSlugDir, `${SESSION_ID}.jsonl`)
    await writeFile(foreign, '{"cwd":"C:\\\\Users\\\\lachl\\\\agenticlaunchpad"}\n')

    expect(assertMigrationPaths({ ...fence(), sourceProjectsRoot: foreignRoot }, attribution())).toEqual({
      source: foreign,
      destination: path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`),
    })
  })

  it('names the ruling it refused on, so a failure is debuggable', () => {
    expect(() => assertMigrationPaths(fence(), attribution({ sessionId: '..' }))).toThrow(MigrationFenceError)
    expect(() => assertMigrationPaths(fence(), attribution({ sessionId: '..' }))).toThrow(/ADR-0020/)
  })

  it('writes nothing itself — a fence that passed has still created no file', () => {
    assertMigrationPaths(fence(), attribution())
    expect(() => realpathSync(path.join(slugDir(watchedRepoPath), `${SESSION_ID}.jsonl`))).toThrow()
    expect(() => realpathSync(slugDir(watchedRepoPath))).toThrow()
  })
})

describe('isInside', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-isinside-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('counts a directory as inside itself', () => {
    expect(isInside(root, root)).toBe(true)
  })

  it('does not count a sibling whose name merely shares a prefix', () => {
    // `…/clones-evil` must not read as inside `…/clones`.
    expect(isInside(path.join(root, 'clones'), path.join(root, 'clones-evil'))).toBe(false)
  })

  it('resolves a symlinked ancestor on both sides through the same realpath', async () => {
    const real = path.join(root, 'real')
    await mkdir(real, { recursive: true })
    const link = path.join(root, 'link')
    await symlink(real, link)

    expect(isInside(link, path.join(real, 'child'))).toBe(true)
    expect(isInside(real, path.join(link, 'child'))).toBe(true)
  })

  it('answers a case-different spelling by where it really points, and never gives a false ALLOW', async () => {
    // The property that holds on BOTH filesystems: containment follows the real
    // directory, not the spelling. Whether two cases ARE one directory is a
    // platform fact, so it is asked of the filesystem rather than assumed —
    // asserting that they agree would encode macOS's rules as a universal law,
    // and that is what CI caught on Linux.
    const dir = path.join(root, 'Clones')
    await mkdir(dir, { recursive: true })
    const lower = path.join(root, 'clones')

    // Same `realpath` the implementation defaults to (#228: the JS one has been
    // seen disagreeing with itself), so the probe and the subject agree.
    const canonical = realpathSync.native ?? realpathSync
    let sameDirectory: boolean
    try {
      sameDirectory = canonical(lower) === canonical(dir)
    } catch {
      sameDirectory = false // ENOENT — case-sensitive filesystem, two distinct names
    }

    expect(isInside(dir, path.join(lower, 'child'))).toBe(sameDirectory)

    // And the invariant neither filesystem may break: something genuinely
    // outside the parent never reads as inside it, whatever the case rules —
    // including a sibling whose name only differs from it by case plus a suffix.
    expect(isInside(dir, path.join(root, 'Elsewhere', 'child'))).toBe(false)
    expect(isInside(dir, path.join(root, 'clones-evil', 'child'))).toBe(false)
  })

  /**
   * The platform half this machine cannot exercise. `isInside` takes an
   * injectable `realpath` precisely so the other filesystem's rules can be
   * simulated — the same trick #217/#227 used to prove a macOS symlink shape on
   * Linux without a mac. Without these two, the case behaviour is only ever
   * verified on whichever filesystem the author happens to have, which is
   * exactly how the assertion CI rejected got written.
   */
  it('simulated case-SENSITIVE filesystem: the two spellings are different directories (the Linux answer)', () => {
    const enoent = () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    // Only `/root` and `/root/Clones` exist. `/root/clones` is a different name.
    const caseSensitive = (p: string): string => (p === '/root' || p === '/root/Clones' ? p : enoent())

    expect(isInside('/root/Clones', '/root/clones/child', caseSensitive)).toBe(false)
    expect(isInside('/root/Clones', '/root/Clones/child', caseSensitive)).toBe(true)
  })

  it('simulated case-INSENSITIVE filesystem: the two spellings are one directory (the macOS answer)', () => {
    const enoent = () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    // Any casing of `/root/clones` resolves to the on-disk spelling `/root/Clones`.
    const caseInsensitive = (p: string): string =>
      p.toLowerCase() === '/root/clones' ? '/root/Clones' : p === '/root' ? p : enoent()

    expect(isInside('/root/Clones', '/root/clones/child', caseInsensitive)).toBe(true)
    // Still no false ALLOW: case-folding must not swallow a prefix sibling.
    expect(isInside('/root/Clones', '/root/clones-evil/child', caseInsensitive)).toBe(false)
  })

  it('uses the realpath it is given, so a self-disagreeing canonicalizer is testable', () => {
    // The #228 shape: a canonicalizer that attaches `/private` to one call and
    // not the other. Both sides go through the same function, so containment
    // still reconciles.
    const flaky = (p: string) => (p.startsWith('/var/') ? p.replace('/var/', '/private/var/') : p)
    expect(isInside('/var/clones', '/var/clones/repo', flaky)).toBe(true)
    expect(isInside('/var/clones', '/var/elsewhere/repo', flaky)).toBe(false)
  })
})
