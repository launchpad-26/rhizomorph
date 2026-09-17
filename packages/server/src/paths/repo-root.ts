import type { Exec } from '@rhizomorph/core'
import { canonicalize } from './containment.js'

/**
 * Which repository a working directory belongs to — prd-58 ruling 1's half of
 * "a repo becomes a colony when an actor is placed in it".
 *
 * **The grouping key is the COMMON directory, not the worktree root**, and that
 * is the whole reason this file exists rather than a `--show-toplevel` call at
 * the call site. `git rev-parse --show-toplevel` inside a linked worktree
 * answers with that *worktree's* root, so three worktrees of one repo would
 * become three colonies — which is the opposite of what ruling 1 wants and is
 * invisible in any test whose fixture has one worktree per repo.
 *
 * `--git-common-dir` is the value that is shared across a repo's worktrees: it
 * is `<repo>/.git` for the main checkout and for every linked worktree of it.
 * Its parent is the repo, and that is the colony.
 *
 * **What this deliberately does not do:** decide anything about the answer. A
 * cwd in no repository resolves to `null` and the caller declares the gap;
 * ADR-0010 is the same rule here as everywhere else in this PRD, and a resolver
 * that guessed a root would put an agent on a colony nobody is working in.
 */
export interface RepoRootResolver {
  /** The repo containing `cwd`, canonicalised — or `null` when there is none. */
  resolve(cwd: string): Promise<string | null>
}

/**
 * A resolver that asks `git`, and asks it once per directory.
 *
 * **The cache is not an optimisation, it is a budget.** ADR-0013 bounds a
 * collector tick at 5s per exec and 10s per poll, and the process table is
 * re-read on the production cadence — so an uncached resolver would spawn one
 * `git` per agent per tick, forever, to re-answer a question whose answer
 * changes only when a worktree is created or removed.
 *
 * A NEGATIVE answer is cached too, and that is the case worth stating: an agent
 * running in `~` or `/tmp` is not a mistake to retry every two seconds, and
 * re-asking would make the unrooted case the most expensive one.
 *
 * The cache is unbounded by design and that is safe here for a reason rather
 * than by luck: its keys are the distinct cwds of roster-matched agent
 * processes on one machine, which is tens of entries, not thousands. A cache
 * keyed by something the operator can grow without bound would need a ceiling.
 */
export function createRepoRootResolver(exec: Exec): RepoRootResolver {
  const cache = new Map<string, string | null>()

  return {
    async resolve(cwd: string): Promise<string | null> {
      const cached = cache.get(cwd)
      if (cached !== undefined) return cached

      const answer = await resolveOnce(exec, cwd)
      cache.set(cwd, answer)
      return answer
    },
  }
}

async function resolveOnce(exec: Exec, cwd: string): Promise<string | null> {
  const result = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    timeoutMs: 5_000,
  })
  // `failed` covers a non-zero exit, a signal, a timeout and a missing binary.
  // "Not a git repository" is a non-zero exit and reaches here as the same
  // `null` as "no git installed" — both are "this instrument cannot place it",
  // and neither is a colony.
  if (result.failed) return null

  const common = result.stdout.trim()
  if (common.length === 0) return null

  // `<repo>/.git` for a main checkout and for every linked worktree of it; a
  // bare repo answers with the repo directory itself. Strip one trailing `.git`
  // segment and canonicalise, so the value is comparable by plain string
  // equality against the other canonical paths in this tree (ADR-0003 keeps
  // that comparison, and only that comparison, in `packages/core`).
  const root = common.endsWith('/.git') || common.endsWith('\\.git') ? common.slice(0, -5) : common
  try {
    return canonicalize(root)
  } catch {
    // A root that will not resolve is a placement this cannot state. Refused,
    // never guessed — the fail-closed posture `canonicalize`'s own callers take.
    return null
  }
}

