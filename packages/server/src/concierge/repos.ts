import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { defaultClaudeProjectsRoot } from '../log/paths.js'

/**
 * prd-20 ruling 5's read-only repo discovery: enumerate `~/.claude/projects`
 * (the repos the user's own Claude already knows, reversing each slugged
 * directory name back to a real path) plus a shallow, bounded scan of common
 * roots. No writes, ever — this module reads the filesystem and reports what
 * it finds. The two are independent, unmerged sources, not a "known" list and
 * a "not yet known" list: a repo Claude already knows can also sit under a
 * common root and so appear in both — see `scanCommonRoots`'s own doc.
 *
 * `collectors/sessionlog/worktree-slug.ts` maps `/`, `_`, `.`, `\`, `:` and a
 * literal space to `-` (prd-42 ruling 1 closed its worst gap, the space — not
 * its last: the real Claude Code slugger maps every non-alphanumeric
 * character, per #47 and the evidence on that helper's own doc comment, and
 * this module's own re-encode below only ever covers three of them). This
 * module does not rely on that transform at all: `reverseProjectSlug`
 * below walks the real filesystem one directory hop at a time, matching each
 * hop against actual directory entries (encoded the same three ways Claude
 * Code encodes them — `.`, `_` and a space) rather than guessing which
 * characters a `-` used to be. That sidesteps the dotted- and spaced-path
 * gaps rather than fixing the forward helper, which this lane does not own —
 * and the divergence between the two encodings is real but not this lane's
 * to reconcile either, for the same reason.
 *
 * Every read goes through `node:fs/promises`, not the `Sync` family: a
 * `GET /api/concierge/repos` request runs this on the server's single event
 * loop thread, and the common-roots scan alone can issue up to
 * `DEFAULT_MAX_DIRS_VISITED` directory reads. A synchronous walk would hold
 * that thread — and every other in-flight request, including `/api/stream`'s
 * SSE — hostage for the walk's entire duration. An `await`ed `readdir` yields
 * between every single filesystem operation instead, so the walk's cost is
 * spread across many microtasks rather than paid as one uninterruptible
 * block. This changes nothing about WHAT is read or how `unreadable`/
 * `truncated` are decided — see `DiscoveryFs`'s own doc — only that reading
 * it no longer blocks anything else this process is doing.
 */

/**
 * The result of listing a directory's real (non-symlink) subdirectories:
 * either the names, or an honest refusal naming why nothing could be read.
 * `readable: false` is reserved for a genuine read failure on a directory
 * that IS there — permission denied, or anything else unexpected. A plain
 * "nothing here" (`ENOENT`/`ENOTDIR` — the directory, or an ancestor of it,
 * does not exist) is `readable: true` with `entries: []`: every call site in
 * this module only ever lists a path it already confirmed exists, or a
 * *candidate* common-root name that may honestly not be present on this
 * machine, so treating "absent" as "empty" there is not a lossy shortcut.
 * "Exists but I could not look" is the one outcome that must never collapse
 * into the same shape as "exists and has nothing."
 */
export type SubdirectoryListing = { readable: true; entries: string[] } | { readable: false; reason: string }

/**
 * The filesystem seam this module reads through — both operations total
 * (never throw) and both asynchronous, so a real call yields the event loop
 * rather than blocking it (see this module's own doc). Fixture-driven tests
 * supply an in-memory implementation that resolves immediately; the
 * `Promise` in the signature is still real, not decorative — an `await` in
 * a test is what proves the caller actually awaits it rather than assuming a
 * synchronous return. `realDiscoveryFs` below is the only production caller.
 */
export interface DiscoveryFs {
  /** True if `target` exists at all, following symlinks — mirrors `cli/doctor.ts`'s own `checkClaudeProjects` check. */
  exists(target: string): Promise<boolean>
  /**
   * The real (non-symlink) directory entries directly inside `dir`, or an
   * honest refusal — see {@link SubdirectoryListing}. A symlink entry is
   * excluded from `entries` even when it points at a directory: this is the
   * one primitive both the slug-reversal walk and the common-roots scan
   * traverse through, so excluding symlinks here is what keeps both of them
   * from following a link out of the tree they were asked to look at.
   */
  listSubdirectories(dir: string): Promise<SubdirectoryListing>
}

async function realExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function realListSubdirectories(dir: string): Promise<SubdirectoryListing> {
  let dirents: Array<{ name: string; isDirectory(): boolean }>
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { readable: true, entries: [] }
    return { readable: false, reason: `could not read ${dir}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { readable: true, entries: dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name) }
}

export const realDiscoveryFs: DiscoveryFs = {
  exists: realExists,
  listSubdirectories: realListSubdirectories,
}

/**
 * Wraps `fs` so every distinct directory it lists is read at most once,
 * however many separate `listSubdirectories` calls ask for it — the cache
 * lives only as long as the closure returned here, never module-level state,
 * so a caller that discards this wrapper after one operation cannot leak a
 * stale listing into an unrelated later call.
 *
 * `exists` is now cached the same way. The comment here used to argue it
 * needed no cache ("scattered across many distinct, rarely-repeated paths"),
 * and that was true until `findRepoRoot` existed: an ancestor walk asks
 * `exists(<dir>/.git)` at every hop, and sibling slugs under one home
 * directory repeat the same shallow ancestors dozens of times. Same
 * promise-holding single-flight shape as the listings, same per-call scope.
 */
function withSharedDirectoryCache(fs: DiscoveryFs): DiscoveryFs {
  const listings = new Map<string, Promise<SubdirectoryListing>>()
  const existence = new Map<string, Promise<boolean>>()
  return {
    exists: (target) => {
      const cached = existence.get(target)
      if (cached) return cached
      const pending = fs.exists(target)
      existence.set(target, pending)
      return pending
    },
    listSubdirectories: (dir) => {
      const cached = listings.get(dir)
      if (cached) return cached
      const pending = fs.listSubdirectories(dir)
      listings.set(dir, pending)
      return pending
    },
  }
}

/**
 * The nearest ancestor-or-self of `target` holding a `.git` (dir or file — a
 * linked worktree's `.git` is a file), or `null` when the walk reaches the
 * filesystem root without finding one. Pure `exists` hops: no spawn (this
 * serves a tokenless route), no clock, terminates because `dirname` reaches a
 * fixed point at the root.
 */
export async function findRepoRoot(target: string, fs: DiscoveryFs = realDiscoveryFs): Promise<string | null> {
  let dir = target
  for (;;) {
    if (await fs.exists(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * A Windows drive-rooted slug's own shape — Claude Code's project directory
 * for a native-Windows session is e.g. `C--Users-operator-agenticlaunchpad`
 * (`C:\` encoded, not a leading `/`). Detected only so the refusal reason
 * below can say something TRUE about it; native Windows support is not
 * implemented here.
 */
const WINDOWS_DRIVE_SLUG_RE = /^[A-Za-z]--/

/**
 * Reverses one `~/.claude/projects` slug back to the real path it names, by
 * walking the filesystem from `/` one path segment at a time and matching
 * the next stretch of the slug against actual directory entries — never by
 * guessing which of `/`, `_`, `.`, or a space a given `-` used to be.
 *
 * At each directory, every real subdirectory name is re-encoded the same way
 * Claude Code encodes a path segment (`.`, `_`, and a literal space all
 * become `-`; a literal `-` is left alone) and checked against the
 * *remaining* slug. Verified against this machine's own `~/.claude/projects`
 * during development — the space case (`ASK JO` → `ASK-JO`, `TailR
 * Nutrition` → `TailR-Nutrition`) is not in #243's own list, so it would
 * otherwise have surfaced as a run of honestly-unresolved slugs that were,
 * in fact, real and present.
 *
 * Among entries that match, the LONGEST encoded form wins, so a directory
 * whose own name contains a literal `-` (`worktrees-challenge`) is preferred
 * over stopping one token early. But when TWO OR MORE entries tie for that
 * longest match — `foo-bar` and `foo.bar` both encode to `foo-bar`, and
 * nothing about the slug says which one Claude Code meant — the walk does
 * NOT pick whichever the filesystem happened to enumerate first. A silent
 * pick would be a wrong answer with no sign it was ever in doubt, which is
 * the one thing this module's whole contract refuses to do: the tie is
 * reported as an ambiguous slug, naming every tied candidate, rather than
 * guessed at.
 *
 * Returns the resolved path, or `null` with a reason naming where the walk
 * stopped — this is the "unknown is not absent" half of the contract: a
 * slug that cannot be walked all the way through is reported, never dropped.
 * That contract now also covers a directory the walk reaches but cannot
 * read: the reason says so plainly, rather than reporting the same "no
 * match" text a genuinely empty directory would get.
 */
export async function reverseProjectSlug(
  slug: string,
  fs: DiscoveryFs = realDiscoveryFs,
): Promise<{ path: string } | { path: null; reason: string }> {
  if (!slug.startsWith('-')) {
    if (WINDOWS_DRIVE_SLUG_RE.test(slug)) {
      return {
        path: null,
        reason:
          `"${slug}" looks like a Windows drive-rooted slug (Claude Code encodes e.g. "C:\\Users\\..." as ` +
          `"C--Users-..."); this walk starts at the filesystem root and does not resolve drive-rooted paths — ` +
          `native Windows is out of this instrument's support matrix, so it is reported unresolved rather than guessed at`,
      }
    }
    return { path: null, reason: `"${slug}" does not start with "-", so it is not a slug for an absolute path` }
  }

  let currentDir: string = path.sep
  let remaining = slug.slice(1)

  while (remaining.length > 0) {
    const listing = await fs.listSubdirectories(currentDir)
    if (!listing.readable) {
      return {
        path: null,
        reason: `could not resolve slug "${slug}" past ${currentDir}: ${listing.reason}`,
      }
    }

    let bestEntries: string[] = []
    let bestEncodedLength = -1
    for (const entry of listing.entries) {
      const encoded = entry.replace(/[._ ]/g, '-')
      const isFinalSegment = remaining === encoded
      const isMidSegment = remaining.startsWith(`${encoded}-`)
      if (!isFinalSegment && !isMidSegment) continue

      if (encoded.length > bestEncodedLength) {
        bestEntries = [entry]
        bestEncodedLength = encoded.length
      } else if (encoded.length === bestEncodedLength) {
        bestEntries.push(entry)
      }
    }

    if (bestEntries.length === 0) {
      return {
        path: null,
        reason:
          `no directory under ${currentDir} matches the next part of slug "${slug}" ` +
          `(resolved as far as ${currentDir}, "${remaining}" left unmatched)`,
      }
    }

    if (bestEntries.length > 1) {
      return {
        path: null,
        reason:
          `ambiguous slug "${slug}": under ${currentDir}, ${bestEntries.map((entry) => `"${entry}"`).join(' and ')} ` +
          `all encode to the same next part of the slug — cannot tell which one Claude Code meant without guessing`,
      }
    }

    const bestEntry = bestEntries[0] as string
    currentDir = path.join(currentDir, bestEntry)
    remaining = remaining.length === bestEncodedLength ? '' : remaining.slice(bestEncodedLength + 1)
  }

  return { path: currentDir }
}

export interface KnownProjectEntry {
  /** The literal directory name under `~/.claude/projects`. */
  slug: string
  /** The real path the slug reverses to, or `null` when it could not be resolved — see `reason`. */
  path: string | null
  resolved: boolean
  /** Present only when `resolved` is `false`: where the reversal walk stopped and why. */
  reason?: string
  /**
   * Present only when `resolved` is `true`: the nearest ancestor-or-self of
   * `path` that holds a `.git`, or `null` when no ancestor does.
   *
   * This is the classification the picker was missing. A slug records a cwd a
   * Claude session once ran in — which is often a repo, sometimes a SUBDIR of
   * one (`<repo>/packages/web`, honestly resolvable and honestly not itself a
   * repo), and sometimes no repo at all (a home directory, a probe dir).
   * Offering all three as "repos" is how the measured picker came to hold a
   * home directory beside two scratch dirs. The fold to the nearest `.git`
   * ancestor answers the subdir case truthfully (the repo IS there, one level
   * up — and folding gives dedup for free when a repo and its subdir both
   * appear); `null` moves the no-repo case into a counted bucket the wizard
   * names rather than silence.
   *
   * `.git` as dir OR file, via `exists` — a linked worktree's `.git` is a
   * file, and the scan half's own pinned test says a worktree counts. Cheap
   * on purpose: this is a tokenless GET, so it must not spawn processes;
   * `retarget-validation.ts` still runs the real `git rev-parse` at act time,
   * so this is a pre-filter in front of a real gate, not the gate.
   */
  repoRoot?: string | null
}

export type KnownProjectsResult = { available: true; projects: KnownProjectEntry[] } | { available: false; reason: string }

/**
 * Every project slug under `claudeProjectsRoot`, each reversed honestly.
 * `available: false` covers two DIFFERENT truths, both with their own
 * reason: the root is absent — the same "nothing to enumerate yet" case
 * `checkClaudeProjects` reports for a fresh machine, not an error — or the
 * root exists but could not be READ (permission denied), which must never
 * come back looking like "Claude has no history here." A slug that fails to
 * reverse still appears, with `resolved: false` and a `reason` — never
 * silently dropped from the list.
 *
 * Every slug is reversed concurrently (`Promise.all`), through a
 * `listSubdirectories` cache SCOPED TO THIS ONE CALL: many slugs share a long
 * stretch of ancestor directories (every project under `/Users/operator/…`
 * re-walks `/`, `/Users`, `/Users/operator` from scratch), so without it, a
 * `~/.claude/projects` with dozens of slugs would re-read the same handful
 * of shallow directories dozens of times over. The cache holds the PROMISE,
 * not just the eventual value, so two slugs whose concurrent walks reach the
 * same directory in the same tick single-flight onto one real read rather
 * than issuing it twice — deliberately fresh per call, never a module-level
 * cache, so nothing here can serve a stale listing across separate requests.
 */
export async function listKnownProjects(claudeProjectsRoot: string, fs: DiscoveryFs = realDiscoveryFs): Promise<KnownProjectsResult> {
  if (!(await fs.exists(claudeProjectsRoot))) {
    return {
      available: false,
      reason: `no Claude Code project history at ${claudeProjectsRoot} — nothing to enumerate yet`,
    }
  }

  const listing = await fs.listSubdirectories(claudeProjectsRoot)
  if (!listing.readable) {
    return { available: false, reason: listing.reason }
  }

  const cachedFs = withSharedDirectoryCache(fs)
  const projects: KnownProjectEntry[] = await Promise.all(
    listing.entries.map(async (slug) => {
      const reversed = await reverseProjectSlug(slug, cachedFs)
      if (reversed.path === null) {
        return { slug, path: null, resolved: false, reason: reversed.reason }
      }
      // The classification the picker reads — see `KnownProjectEntry.repoRoot`.
      // Through the same per-call cache, so sibling slugs' ancestor hops
      // single-flight instead of re-stating the same shallow directories.
      return { slug, path: reversed.path, resolved: true, repoRoot: await findRepoRoot(reversed.path, cachedFs) }
    }),
  )

  return { available: true, projects }
}

export interface ScannedRepo {
  path: string
}

/**
 * Conventional top-level directory names the scan looks under — deliberately
 * a short, named list rather than a walk of the whole home directory. This
 * is the "common roots" ruling 5 asks for, not a repo finder that tries to
 * be exhaustive; a repo living somewhere unconventional is exactly what the
 * clone-by-URL half of the concierge (#262, out of scope here) is for.
 */
export const COMMON_ROOT_NAMES: readonly string[] = [
  'Desktop',
  'Documents',
  'Developer',
  'Projects',
  'projects',
  'code',
  'Code',
  'dev',
  'src',
  'workspace',
  'repos',
  'git',
  'work',
]

/** Directory names the scan never descends into, at any depth — none of these can themselves be a repo root worth surfacing. */
const DEFAULT_SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.cache'])

/** Path segments below a common root the scan will look — `~/code/repo` is depth 1, `~/code/org/repo` is depth 2. */
const DEFAULT_MAX_DEPTH = 2

/**
 * Upper bound on directories visited across the WHOLE scan (every root
 * combined), so a pathologically wide common root cannot block the wizard's
 * first screen the way #274 describes for an unrelated unbounded walk. Once
 * hit, the scan stops and reports `truncated: true` rather than silently
 * returning a partial list that looks complete.
 */
const DEFAULT_MAX_DIRS_VISITED = 2000

export interface ScanCommonRootsOptions {
  skipDirNames?: ReadonlySet<string>
  maxDepth?: number
  maxDirsVisited?: number
}

export interface ScanCommonRootsResult {
  repos: ScannedRepo[]
  /** True when `maxDirsVisited` was hit before the scan finished — the result is honest but incomplete. */
  truncated: boolean
  /**
   * Directories the scan reached but could not read — permission denied, or
   * anything else unexpected. Kept separate from `truncated`: hitting the
   * visit budget and being refused by the OS are different failures, and a
   * caller cannot tell a genuinely empty `~/Desktop` from an unreadable one
   * unless the two stay distinguishable.
   */
  unreadable: string[]
}

/**
 * A shallow, bounded scan of `homeDir`'s conventional subdirectories, for
 * repos this scan finds independently of `listKnownProjects`. The two are
 * NOT deduplicated against each other: a repo Claude already knows can also
 * sit under a common root and so appear in both `known` and `scanned` — this
 * function only reports what a filesystem walk finds, and merging that with
 * `known` is the picker's call to make (it has the slug metadata `scanned`
 * does not, and may want to show "already known" differently from "found by
 * scanning" rather than collapsing the two).
 *
 * Bounded three ways at once: a short named root list (not the whole home
 * directory), a shallow depth per root, and a hard cap on total directories
 * visited. Never follows a symlink — `fs`'s `listSubdirectories` excludes
 * them at the source, so a symlink planted inside a common root cannot walk
 * the scan out into the rest of the filesystem.
 *
 * A repo is recognised by `.git` merely EXISTING at that path, not by it
 * being a directory: a *linked* git worktree's `.git` is a FILE containing
 * `gitdir: …`, and this instrument's own subject matter is worktree swarms,
 * so a scan that only recognised the plain-clone shape would walk past every
 * worktree in a `~/code` full of them and then descend INTO each one looking
 * for repos. Once recognised, a repo's own contents are not descended into
 * further.
 *
 * The walk is sequential, not fanned out with `Promise.all` across
 * siblings: every `await` here still yields the event loop between reads
 * (the fix this function exists to carry — see this module's own doc), and
 * staying sequential keeps `dirsVisited`/`truncated`/`unreadable` exactly as
 * deterministic as they were when this was synchronous, rather than trading
 * that for a speed-up nothing here asked for.
 */
export async function scanCommonRoots(
  homeDir: string,
  fs: DiscoveryFs = realDiscoveryFs,
  options: ScanCommonRootsOptions = {},
): Promise<ScanCommonRootsResult> {
  const skipDirNames = options.skipDirNames ?? DEFAULT_SKIP_DIR_NAMES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxDirsVisited = options.maxDirsVisited ?? DEFAULT_MAX_DIRS_VISITED

  const repos: ScannedRepo[] = []
  const unreadable: string[] = []
  let dirsVisited = 0
  let truncated = false

  /**
   * `fs.listSubdirectories`, metered against the visit budget — the one
   * place every directory read in this scan goes through. Returns `null`
   * for EITHER stop condition (budget hit, or a genuine read failure); the
   * caller doesn't need to tell them apart, because `truncated`/`unreadable`
   * are already recorded here, at the one place that knows which happened.
   */
  async function readSubdirs(dir: string): Promise<string[] | null> {
    dirsVisited += 1
    if (dirsVisited > maxDirsVisited) {
      truncated = true
      return null
    }
    const listing = await fs.listSubdirectories(dir)
    if (!listing.readable) {
      unreadable.push(dir)
      return null
    }
    return listing.entries
  }

  async function visit(dir: string, depthRemaining: number): Promise<void> {
    if (truncated) return

    if (await fs.exists(path.join(dir, '.git'))) {
      repos.push({ path: dir })
      return
    }
    if (depthRemaining <= 0) return

    const entries = await readSubdirs(dir)
    if (entries === null) return

    for (const name of entries) {
      if (name.startsWith('.') || skipDirNames.has(name)) continue
      await visit(path.join(dir, name), depthRemaining - 1)
    }
  }

  // A common root name is only descended into when it is itself a REAL
  // subdirectory of `homeDir` — checked through the same symlink-excluding
  // primitive as every other hop, so a symlinked `~/code` is refused here
  // exactly as a symlink discovered mid-walk would be. Reading the top-level
  // name through readSubdirs's own return value, rather than trusting
  // `path.join` to have named something real, is what keeps "never follow a
  // symlink out of the filesystem" true for the roots themselves too, not
  // only for what the walk finds underneath them.
  const homeEntries = await readSubdirs(homeDir)
  if (homeEntries !== null) {
    const homeEntrySet = new Set(homeEntries)
    for (const rootName of COMMON_ROOT_NAMES) {
      if (truncated) break
      if (!homeEntrySet.has(rootName)) continue
      await visit(path.join(homeDir, rootName), maxDepth)
    }
  }

  return { repos, truncated, unreadable }
}

export interface DiscoverReposOptions {
  claudeProjectsRoot?: string
  homeDir?: string
  fs?: DiscoveryFs
  scan?: ScanCommonRootsOptions
}

export interface DiscoverReposResult {
  known: KnownProjectsResult
  scanned: ScanCommonRootsResult
}

/**
 * The one read this module exists to serve: the repos Claude already knows
 * (`~/.claude/projects`, honestly reversed) plus the repos a shallow,
 * bounded scan of common roots turns up. Every field defaults to the real
 * machine; tests override `homeDir`/`claudeProjectsRoot`/`fs` to run
 * hermetically against fixtures instead. Reuses `log/paths.ts`'s own
 * `defaultClaudeProjectsRoot()` for the default rather than re-deriving the
 * same join — that module is a shared, ungated utility (not `lab/`,
 * `recorder/`, or `api/`, the three namespaces the concierge law fences
 * against), and `namespace-law.test.ts` passes with this import in place.
 *
 * The two reads run CONCURRENTLY (`Promise.all`), not one after the other:
 * they touch disjoint parts of the filesystem (`~/.claude/projects` vs. the
 * common roots), so there is nothing to serialize them for.
 */
export async function discoverRepos(options: DiscoverReposOptions = {}): Promise<DiscoverReposResult> {
  const fs = options.fs ?? realDiscoveryFs
  const homeDir = options.homeDir ?? homedir()
  // `defaultClaudeProjectsRoot()` has no parameter of its own — it always
  // means THE REAL machine's `~/.claude/projects`. That is exactly right
  // when `homeDir` is also at its real default (the production path this
  // finding is about), but a test overriding `homeDir` alone, without also
  // naming `claudeProjectsRoot`, clearly means "derive it under the home I
  // gave you" — `defaultClaudeProjectsRoot()` cannot honour that, so this
  // only reaches for it when nothing here is overridden.
  const claudeProjectsRoot =
    options.claudeProjectsRoot ?? (options.homeDir === undefined ? defaultClaudeProjectsRoot() : path.join(homeDir, '.claude', 'projects'))

  const [known, scanned] = await Promise.all([listKnownProjects(claudeProjectsRoot, fs), scanCommonRoots(homeDir, fs, options.scan)])

  return { known, scanned }
}
