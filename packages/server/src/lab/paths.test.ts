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

/**
 * #228: #227 canonicalized both sides of the containment check, but with
 * `fs.realpathSync` — Node's pure-JS reimplementation of `realpath(3)`, which
 * CI showed disagreeing with ITSELF across Node versions on the very same
 * macOS host: `/private` got attached to a resolved `/var/folders/…` path
 * under Node 22.22.2 (min) and not under the version CI runs as "current".
 * Same OS, same code, different Node, different answer — the live symlink
 * reproduction above (and the namespace-law end-to-end twin) failed on
 * macOS-current only, right after #227 landed.
 *
 * There is no macOS runner here, so these tests don't reproduce the Node-JS
 * bug directly — they simulate its OUTPUT by injecting a fake `realpath`
 * into `isInside`/`assertInsideLabWorktrees` (both accept one, defaulting to
 * `fs.realpathSync.native` in production) and proving two things a Linux run
 * can prove on its own:
 *
 *   1. A canonicalizer that agrees with itself — whether it happens to
 *      always attach `/private` (the macOS shape) or never does (the Linux
 *      shape) — always resolves containment correctly, regardless of which
 *      shape it is.
 *   2. A canonicalizer that DISAGREES with itself between the two sides of
 *      one comparison — /private-prefixed on one side, plain on the other,
 *      the exact shape CI's evidence describes — reports a false escape for
 *      a worktree that is genuinely contained. That failure mode is real and
 *      mechanical, not hypothetical: it is what `fs.realpathSync` (JS) did.
 *
 * Together they justify routing production through `realpathSync.native`
 * rather than trying to patch the comparison itself: no comparison can
 * reconcile two DIFFERENT canonical spellings of the same real path: the fix
 * has to be a canonicalizer that cannot produce two spellings for one path in
 * the first place, which is exactly the guarantee a single native OS call
 * (over a JS reimplementation with its own version history) provides.
 */
describe('the macOS Node-version canonicalizer disagreement, simulated on Linux (#228)', () => {
  const dataRoot = '/simulated/data-link' // never touches the real filesystem — realpath is fully faked below
  const worktreesRoot = labWorktreesRoot(dataRoot) // '/simulated/data-link/lab/worktrees'
  const candidate = path.join(worktreesRoot, 'fork-1-arm-1')

  function withPrivatePrefix(p: string): string {
    return p.startsWith('/private') ? p : `/private${p}`
  }

  it('both sides /private-prefixed (macOS shape) — a self-consistent canonicalizer still recognizes containment', () => {
    const macLikeRealpath = withPrivatePrefix
    expect(isInside(worktreesRoot, candidate, macLikeRealpath)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, candidate, macLikeRealpath)).not.toThrow()
  })

  it('both sides plain, no /private (Linux shape) — a self-consistent canonicalizer still recognizes containment', () => {
    const linuxLikeRealpath = (p: string) => p
    expect(isInside(worktreesRoot, candidate, linuxLikeRealpath)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, candidate, linuxLikeRealpath)).not.toThrow()
  })

  it('mixed: candidate arrives /private-prefixed (as if already resolved by git) but this canonicalizer leaves the parent plain — the exact macOS-current disagreement reads a contained worktree as an escape', () => {
    // Stands in for the CI shape: the worktree path git reports has already
    // been through git's OWN (consistent) resolution and carries /private;
    // this fake canonicalizer, standing in for the buggy `fs.realpathSync`,
    // fails to add that same prefix when asked to resolve the parent — an
    // identity function is the simplest thing that reproduces the mismatch,
    // since it reconciles neither spelling to the other.
    const inconsistentRealpath = (p: string) => p
    const candidateAlreadyResolved = withPrivatePrefix(candidate)

    // This is the false escape #228's CI evidence describes: same real
    // directory, wrongly reported as outside.
    expect(isInside(worktreesRoot, candidateAlreadyResolved, inconsistentRealpath)).toBe(false)

    // A canonicalizer that agrees with itself — the fix's actual guarantee,
    // simulated here rather than swapped in via the untestable native OS
    // call — resolves the very same inputs correctly.
    const consistentRealpath = withPrivatePrefix
    expect(isInside(worktreesRoot, candidateAlreadyResolved, consistentRealpath)).toBe(true)
    expect(() => assertInsideLabWorktrees(dataRoot, candidateAlreadyResolved, consistentRealpath)).not.toThrow()
  })
})
