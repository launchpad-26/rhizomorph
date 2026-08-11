import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * prd-20 ruling 5's read-only repo discovery: enumerate `~/.claude/projects`
 * (the repos the user's own Claude already knows, reversing each slugged
 * directory name back to a real path) plus a shallow, bounded scan of common
 * roots. No writes, ever — this module reads the filesystem and reports what
 * it finds. The two are independent, unmerged sources, not a "known" list and
 * a "not yet known" list: a repo Claude already knows can also sit under a
 * common root and so appear in both — see `scanCommonRoots`'s own doc.
 *
 * `#243` documents the known gaps in the *forward* slug transform
 * (`collectors/sessionlog/worktree-slug.ts` maps only `/` and `_` to `-`,
 * missing Claude Code's `.` → `-`). This module does not rely on that
 * transform at all: `reverseProjectSlug` below walks the real filesystem one
 * directory hop at a time, matching each hop against actual directory
 * entries (encoded the same three ways Claude Code encodes them) rather than
 * guessing which characters a `-` used to be. That sidesteps the dotted-path
 * gap rather than fixing the forward helper, which this lane does not own.
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
 * (never throw). Fixture-driven tests supply an in-memory implementation;
 * `realDiscoveryFs` below is the only production caller.
 */
export interface DiscoveryFs {
  /** True if `target` exists at all, following symlinks — mirrors `cli/doctor.ts`'s own `checkClaudeProjects` check. */
  exists(target: string): boolean
  /**
   * The real (non-symlink) directory entries directly inside `dir`, or an
   * honest refusal — see {@link SubdirectoryListing}. A symlink entry is
   * excluded from `entries` even when it points at a directory: this is the
   * one primitive both the slug-reversal walk and the common-roots scan
   * traverse through, so excluding symlinks here is what keeps both of them
   * from following a link out of the tree they were asked to look at.
   */
  listSubdirectories(dir: string): SubdirectoryListing
}

function realListSubdirectories(dir: string): SubdirectoryListing {
  let dirents: Array<{ name: string; isDirectory(): boolean }>
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { readable: true, entries: [] }
    return { readable: false, reason: `could not read ${dir}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { readable: true, entries: dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name) }
}

export const realDiscoveryFs: DiscoveryFs = {
  exists: existsSync,
  listSubdirectories: realListSubdirectories,
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
 * in fact, real and present. The longest
 * matching entry wins, so a directory whose own name contains a literal `-`
 * (`worktrees-challenge`) is preferred over stopping one token early — the
 * ambiguity a slug can never fully resolve on its own is resolved here by
 * asking the real filesystem instead of guessing.
 *
 * Returns the resolved path, or `null` with a reason naming where the walk
 * stopped — this is the "unknown is not absent" half of the contract: a
 * slug that cannot be walked all the way through is reported, never dropped.
 * That contract now also covers a directory the walk reaches but cannot
 * read: the reason says so plainly, rather than reporting the same "no
 * match" text a genuinely empty directory would get.
 */
export function reverseProjectSlug(slug: string, fs: DiscoveryFs = realDiscoveryFs): { path: string } | { path: null; reason: string } {
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
    const listing = fs.listSubdirectories(currentDir)
    if (!listing.readable) {
      return {
        path: null,
        reason: `could not resolve slug "${slug}" past ${currentDir}: ${listing.reason}`,
      }
    }

    let bestEntry: string | null = null
    let bestEncodedLength = -1
    for (const entry of listing.entries) {
      const encoded = entry.replace(/[._ ]/g, '-')
      const isFinalSegment = remaining === encoded
      const isMidSegment = remaining.startsWith(`${encoded}-`)
      if ((isFinalSegment || isMidSegment) && encoded.length > bestEncodedLength) {
        bestEntry = entry
        bestEncodedLength = encoded.length
      }
    }

    if (bestEntry === null) {
      return {
        path: null,
        reason:
          `no directory under ${currentDir} matches the next part of slug "${slug}" ` +
          `(resolved as far as ${currentDir}, "${remaining}" left unmatched)`,
      }
    }

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
 */
export function listKnownProjects(claudeProjectsRoot: string, fs: DiscoveryFs = realDiscoveryFs): KnownProjectsResult {
  if (!fs.exists(claudeProjectsRoot)) {
    return {
      available: false,
      reason: `no Claude Code project history at ${claudeProjectsRoot} — nothing to enumerate yet`,
    }
  }

  const listing = fs.listSubdirectories(claudeProjectsRoot)
  if (!listing.readable) {
    return { available: false, reason: listing.reason }
  }

  const projects: KnownProjectEntry[] = listing.entries.map((slug) => {
    const reversed = reverseProjectSlug(slug, fs)
    return reversed.path === null
      ? { slug, path: null, resolved: false, reason: reversed.reason }
      : { slug, path: reversed.path, resolved: true }
  })

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
 */
export function scanCommonRoots(homeDir: string, fs: DiscoveryFs = realDiscoveryFs, options: ScanCommonRootsOptions = {}): ScanCommonRootsResult {
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
  function readSubdirs(dir: string): string[] | null {
    dirsVisited += 1
    if (dirsVisited > maxDirsVisited) {
      truncated = true
      return null
    }
    const listing = fs.listSubdirectories(dir)
    if (!listing.readable) {
      unreadable.push(dir)
      return null
    }
    return listing.entries
  }

  function visit(dir: string, depthRemaining: number): void {
    if (truncated) return

    if (fs.exists(path.join(dir, '.git'))) {
      repos.push({ path: dir })
      return
    }
    if (depthRemaining <= 0) return

    const entries = readSubdirs(dir)
    if (entries === null) return

    for (const name of entries) {
      if (name.startsWith('.') || skipDirNames.has(name)) continue
      visit(path.join(dir, name), depthRemaining - 1)
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
  const homeEntries = readSubdirs(homeDir)
  if (homeEntries !== null) {
    const homeEntrySet = new Set(homeEntries)
    for (const rootName of COMMON_ROOT_NAMES) {
      if (truncated) break
      if (!homeEntrySet.has(rootName)) continue
      visit(path.join(homeDir, rootName), maxDepth)
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
 * hermetically against fixtures instead.
 */
export function discoverRepos(options: DiscoverReposOptions = {}): DiscoverReposResult {
  const fs = options.fs ?? realDiscoveryFs
  const homeDir = options.homeDir ?? homedir()
  const claudeProjectsRoot = options.claudeProjectsRoot ?? path.join(homeDir, '.claude', 'projects')

  return {
    known: listKnownProjects(claudeProjectsRoot, fs),
    scanned: scanCommonRoots(homeDir, fs, options.scan),
  }
}
