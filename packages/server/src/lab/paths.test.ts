import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertInsideLabWorktrees, isInside, labWorktreesRoot } from './paths.js'

/**
 * #227: the macOS CI leg (#217) failed `namespace-law.test.ts`'s live
 * containment check on its first run because macOS temp dirs live under
 * `/var/folders/…`, itself a symlink to `/private/var/folders/…`. A
 * containment check that compares raw path prefixes sees the worktree at one
 * spelling and the lab root at the other and reports an escape that never
 * happened. Confirmed on Linux (no macOS needed): `git worktree add` given a
 * path through a symlink reports the REALPATH back on `git worktree list`,
 * so the same mismatch reproduces here — that reproduction is `dataRoot
 * itself is reached through a symlink` below.
 *
 * The fix (canonicalizing both sides, in `paths.ts`'s `canonicalize`) is also
 * a strengthening, not just a compat patch: a raw-prefix check is equally
 * foolable the OTHER way, by a symlink placed INSIDE the permitted directory
 * whose target lies outside it. `escaping symlink inside the permitted dir
 * is refused, not contained` is that direction's test.
 *
 * Hermetic under 4x concurrency: one `mkdtemp` root per test, no shared state.
 */
describe('lab path containment (prd12 ruling 1, #227)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-paths-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('an ordinary, non-symlinked worktree path is contained — the regression case, not vacuous', async () => {
    const dataRoot = path.join(root, 'data')
    const worktreesRoot = labWorktreesRoot(dataRoot)
    await mkdir(worktreesRoot, { recursive: true })

    const worktree = path.join(worktreesRoot, 'fork-1-arm-1')
    expect(isInside(worktreesRoot, worktree)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, worktree)).not.toThrow()
  })

  it('an ordinary, non-symlinked path outside the root is refused — the check still bites', async () => {
    const dataRoot = path.join(root, 'data')
    await mkdir(labWorktreesRoot(dataRoot), { recursive: true })

    const escapee = path.join(root, 'elsewhere')
    expect(isInside(labWorktreesRoot(dataRoot), escapee)).toBe(false)
    expect(() => assertInsideLabWorktrees(dataRoot, escapee)).toThrow(/refusing to write outside/)
  })

  it('the macOS shape, reproduced: dataRoot itself is reached through a symlink, a worktree under it is still contained', async () => {
    const realDataRoot = path.join(root, 'real-data')
    const dataRoot = path.join(root, 'data-link') // the spelling the lab is handed, e.g. TMPDIR on macOS
    await mkdir(realDataRoot, { recursive: true })
    await symlink(realDataRoot, dataRoot)

    // The candidate arrives at the REAL spelling, exactly as `git worktree
    // list` reported it in the Linux reproduction above (confirmed against a
    // real `git worktree add` through a symlinked target directory).
    const worktreeViaRealSpelling = path.join(labWorktreesRoot(realDataRoot), 'fork-1-arm-1')
    await mkdir(path.dirname(worktreeViaRealSpelling), { recursive: true })

    expect(isInside(labWorktreesRoot(dataRoot), worktreeViaRealSpelling)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, worktreeViaRealSpelling)).not.toThrow()

    // And the reverse spelling — candidate given through the very same
    // symlink the caller was handed — must also be recognized, since a
    // worktree that does not exist yet (the real call order: this assert
    // runs BEFORE `git worktree add`) can only be named through dataRoot's
    // own spelling.
    const worktreeNotYetCreated = path.join(labWorktreesRoot(dataRoot), 'fork-2-arm-1')
    expect(isInside(labWorktreesRoot(dataRoot), worktreeNotYetCreated)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, worktreeNotYetCreated)).not.toThrow()
  })

  it('escaping symlink inside the permitted dir is refused, not contained — the strengthening, not just the compat patch', async () => {
    const dataRoot = path.join(root, 'data')
    const worktreesRoot = labWorktreesRoot(dataRoot)
    await mkdir(worktreesRoot, { recursive: true })

    const secret = path.join(root, 'operator-secrets')
    await mkdir(secret, { recursive: true })

    // A symlink whose OWN path is inside the lab's worktrees dir, but whose
    // target escapes it entirely — exactly the shape a raw-prefix check
    // cannot tell apart from a real worktree, because the un-followed
    // spelling of the link's path IS inside the root.
    const decoy = path.join(worktreesRoot, 'fork-evil-arm-1')
    await symlink(secret, decoy)

    expect(isInside(worktreesRoot, decoy)).toBe(false)
    expect(() => assertInsideLabWorktrees(dataRoot, decoy)).toThrow(/refusing to write outside/)
  })

  it('a symlinked ancestor that is legitimate does not make an escaping SIBLING look contained', async () => {
    // Two real trees side by side; dataRoot is a symlink to one of them.
    const realDataRoot = path.join(root, 'real-data')
    const dataRoot = path.join(root, 'data-link')
    await mkdir(realDataRoot, { recursive: true })
    await symlink(realDataRoot, dataRoot)

    const outsideTree = path.join(root, 'not-lab-data')
    await mkdir(outsideTree, { recursive: true })

    expect(isInside(labWorktreesRoot(dataRoot), path.join(outsideTree, 'fork-1-arm-1'))).toBe(false)
  })
})
