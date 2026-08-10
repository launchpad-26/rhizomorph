import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * prd-20 ruling 5's read-only repo discovery: enumerate `~/.claude/projects`
 * (the repos the user's own Claude already knows, reversing each slugged
 * directory name back to a real path) plus a shallow, bounded scan of common
 * roots (repos Claude has never opened). No writes, ever — this module reads
 * the filesystem and reports what it finds.
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
 * The filesystem seam this module reads through — two operations, both
 * total (never throw) and both real-directory-only (never a symlink, even
 * one pointing at a directory). Fixture-driven tests supply an in-memory
 * implementation; `realDiscoveryFs` below is the only production caller.
 */
export interface DiscoveryFs {
  /** True if `target` exists at all, following symlinks — mirrors `cli/doctor.ts`'s own `checkClaudeProjects` check. */
  exists(target: string): boolean
  /**
   * Names of the real (non-symlink) directory entries directly inside `dir`.
   * `[]` when `dir` cannot be read — absent, permission denied, or not a
   * directory — never thrown. A symlink entry is excluded even when it
   * points at a directory: this is the one primitive both the slug-reversal
   * walk and the common-roots scan traverse through, so excluding symlinks
   * here is what keeps both of them from following a link out of the tree
   * they were asked to look at.
   */
  listSubdirectories(dir: string): string[]
}

function realListSubdirectories(dir: string): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

export const realDiscoveryFs: DiscoveryFs = {
  exists: existsSync,
  listSubdirectories: realListSubdirectories,
}

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
 */
export function reverseProjectSlug(slug: string, fs: DiscoveryFs = realDiscoveryFs): { path: string } | { path: null; reason: string } {
  if (!slug.startsWith('-')) {
    return { path: null, reason: `"${slug}" does not start with "-", so it is not a slug for an absolute path` }
  }

  let currentDir: string = path.sep
  let remaining = slug.slice(1)

  while (remaining.length > 0) {
    const candidates = fs.listSubdirectories(currentDir)

    let bestEntry: string | null = null
    let bestEncodedLength = -1
    for (const entry of candidates) {
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
 * `available: false` only when the root itself is absent — the same
 * "nothing to enumerate yet" case `checkClaudeProjects` reports for a fresh
 * machine, not an error. A slug that fails to reverse still appears, with
 * `resolved: false` and a `reason` — never silently dropped from the list.
 */
export function listKnownProjects(claudeProjectsRoot: string, fs: DiscoveryFs = realDiscoveryFs): KnownProjectsResult {
  if (!fs.exists(claudeProjectsRoot)) {
    return {
      available: false,
      reason: `no Claude Code project history at ${claudeProjectsRoot} — nothing to enumerate yet`,
    }
  }

  const slugs = fs.listSubdirectories(claudeProjectsRoot)
  const projects: KnownProjectEntry[] = slugs.map((slug) => {
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
}

/**
 * A shallow, bounded scan of `homeDir`'s conventional subdirectories for
 * repos Claude has never opened. Bounded three ways at once: a short named
 * root list (not the whole home directory), a shallow depth per root, and a
 * hard cap on total directories visited. Never follows a symlink — `fs`'s
 * `listSubdirectories` excludes them at the source, so a symlink planted
 * inside a common root cannot walk the scan out into the rest of the
 * filesystem.
 *
 * A directory containing `.git` is reported as a repo and not descended
 * into further — its own internals are not this scan's concern.
 */
export function scanCommonRoots(homeDir: string, fs: DiscoveryFs = realDiscoveryFs, options: ScanCommonRootsOptions = {}): ScanCommonRootsResult {
  const skipDirNames = options.skipDirNames ?? DEFAULT_SKIP_DIR_NAMES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxDirsVisited = options.maxDirsVisited ?? DEFAULT_MAX_DIRS_VISITED

  const repos: ScannedRepo[] = []
  let dirsVisited = 0
  let truncated = false

  /** `fs.listSubdirectories`, metered against the visit budget — the one place every directory read in this scan goes through. */
  function readSubdirs(dir: string): string[] {
    dirsVisited += 1
    if (dirsVisited > maxDirsVisited) {
      truncated = true
      return []
    }
    return fs.listSubdirectories(dir)
  }

  function visit(dir: string, depthRemaining: number): void {
    if (truncated) return

    const entries = readSubdirs(dir)
    if (entries.includes('.git')) {
      repos.push({ path: dir })
      return
    }
    if (depthRemaining <= 0) return

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
  const homeEntries = new Set(readSubdirs(homeDir))
  for (const rootName of COMMON_ROOT_NAMES) {
    if (truncated) break
    if (!homeEntries.has(rootName)) continue
    visit(path.join(homeDir, rootName), maxDepth)
  }

  return { repos, truncated }
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
