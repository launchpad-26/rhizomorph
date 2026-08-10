import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertCloneTarget, CloneFenceError, conciergeRoot, isInside } from './paths.js'

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
    expect(() => assertCloneTarget(fence(), path.join(root, 'elsewhere'))).toThrow(/ADR-0014/)
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

  it('does not disagree with itself over the case of a path that exists', async () => {
    // On a case-insensitive filesystem (macOS's default) `realpath` returns the
    // on-disk spelling, so the two agree. On a case-sensitive one they are
    // genuinely different directories and `false` is the correct answer — the
    // point is that neither filesystem can be made to give a false ALLOW.
    const dir = path.join(root, 'Clones')
    await mkdir(dir, { recursive: true })
    const lower = path.join(root, 'clones')
    const sameDirectory = isInside(dir, path.join(lower, 'child'))
    expect(sameDirectory).toBe(isInside(dir, path.join(dir, 'child')) && isInside(lower, lower))
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
