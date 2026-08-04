import type { Exec } from '@rhizomorph/core'

/**
 * prd11 ruling 6b, phase 1 — the structural judge organ's speculative-merge
 * half (research `docs/research/2026-08-04-semantic-judge-spike.md`, verdict
 * §1): pairwise `git merge-tree --write-tree`, the spike's one salvageable
 * industry technique (Crystal, §5 — attempt the integration instead of
 * predicting it). Reports whether two lane branches would conflict, and
 * which files, before either lands.
 *
 * **Read-only law, precisely stated.** `git merge-tree --write-tree` moves
 * NO ref, touches NO index, checks out NO worktree — the repo's visible state
 * (HEAD, branches, working tree, `git status`) is byte-for-byte unchanged
 * before and after a call, and `mergetree.test.ts` asserts exactly that. It
 * DOES write loose tree/blob objects into `.git/objects` to represent the
 * merge result it is reporting on — that is unavoidable plumbing (the
 * command's whole job is to describe a tree), and those objects are inert,
 * content-addressed, and never referenced by anything until something else
 * chooses to point at them (nothing here ever does). This module reads the
 * result and discards the tree oid; it never creates a ref, a worktree, or an
 * index entry, which is what the OBSERVER's read-only law actually forbids.
 */

export interface MergeTreeOptions {
  exec: Exec
  repoPath: string
  branchA: string
  branchB: string
}

export interface MergeTreeResult {
  /** True when git reported no conflicts merging branchA into branchB (or vice versa — merge-tree is symmetric on conflict detection). */
  clean: boolean
  /** Distinct file paths git reported as conflicting. Empty when clean. */
  conflictingFiles: string[]
}

/** One conflicted-file-info line: `<mode> <oid> <stage>\t<path>`. */
const CONFLICT_LINE_RE = /^\d+ [0-9a-f]+ [123]\t(.+)$/

/**
 * Parses `git merge-tree --write-tree -z`'s NUL-delimited output. Layout,
 * confirmed against a real git 2.43 (see the module test): field 0 is the
 * result tree oid; on a clean merge that is the whole output. On conflict,
 * fields 1..N are conflicted-file-info lines (one per stage per conflicted
 * path — up to three stages, base/ours/theirs), terminated by an empty field,
 * followed by informational messages this parser has no use for and ignores.
 */
export function parseMergeTreeOutput(stdout: string): { conflictingFiles: string[] } {
  const fields = stdout.split('\0')
  const conflictingFiles = new Set<string>()

  for (const field of fields.slice(1)) {
    if (field.length === 0) break // the conflict-info section's own terminator
    const match = CONFLICT_LINE_RE.exec(field)
    if (match?.[1]) conflictingFiles.add(match[1])
  }

  return { conflictingFiles: [...conflictingFiles].sort() }
}

/**
 * Runs the real speculative merge. Exit code 0 means clean (no conflicts);
 * exit code 1 with a non-empty stdout means git ran fine and found conflicts
 * — both are success paths here. Anything else (missing binary, an unknown
 * ref — which also exits 1, but with nothing on stdout — a genuinely broken
 * repo) throws, so the caller can decide how to degrade rather than this
 * module silently reporting "clean" for a merge it never actually evaluated.
 */
export async function speculativeMergeTree(options: MergeTreeOptions): Promise<MergeTreeResult> {
  const { exec, repoPath, branchA, branchB } = options
  const result = await exec('git', ['merge-tree', '--write-tree', '-z', branchA, branchB], { cwd: repoPath })

  if (result.code === 0) {
    return { clean: true, conflictingFiles: [] }
  }
  // Exit 1 is ALSO what git uses for "couldn't even attempt this" (an unknown
  // ref, say) — the tell is that a real conflict report always writes its
  // machine-readable output to stdout first, while a plumbing error writes
  // only to stderr and leaves stdout empty.
  if (result.code === 1 && result.stdout.trim().length > 0) {
    const { conflictingFiles } = parseMergeTreeOutput(result.stdout)
    return { clean: conflictingFiles.length === 0, conflictingFiles }
  }

  throw new Error(
    `git merge-tree failed unexpectedly for "${branchA}" vs "${branchB}" (code ${result.code}): ${result.errorMessage ?? result.stderr}`,
  )
}
