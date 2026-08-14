import type { BranchState, SessionState } from '../state.js'
import {
  type MainBranchOption,
  compareStrings,
  selectMainBranch,
  selectMainShas,
} from './touches.js'

/** How far ahead of main each branch is, and the branch table behind it. */

export interface AheadOptions extends MainBranchOption {
  /**
   * Trust the collector's merge-base count when it reported one. Defaults to
   * true: git's answer beats ours, because ours only knows about commits that
   * landed while we were watching. Set false to force stream-derived counts.
   */
  preferReported?: boolean
}

export interface BranchView {
  name: string
  head: string | null
  previousHead: string | null
  worktreePath: string | null
  isMain: boolean
  /** The number to show: reported when available, else derived. */
  aheadOfMain: number
  behindMain: number | null
  /** As reported by the git collector's merge-base maths. */
  reportedAhead: number | null
  /** Derived from commits observed on this branch that main lacks. */
  observedAhead: number
  commitCount: number
  lastCommitTs: number | null
  firstSeenAt: number
  updatedAt: number
}

export function aheadOfMain(
  state: SessionState,
  branch: BranchState,
  options: AheadOptions = {},
): number {
  const main = selectMainBranch(state, options)
  if (branch.name === main) return 0
  const preferReported = options.preferReported ?? true
  if (preferReported && branch.aheadOfMain !== null) return branch.aheadOfMain
  const mainShas = selectMainShas(state, options)
  return branch.commits.filter((sha) => !mainShas.has(sha)).length
}

/** branch name → commits ahead of main. */
export function selectAheadOfMain(
  state: SessionState,
  options: AheadOptions = {},
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const branch of Object.values(state.branches)) {
    counts[branch.name] = aheadOfMain(state, branch, options)
  }
  return counts
}

export function selectBranchView(
  state: SessionState,
  branch: BranchState,
  options: AheadOptions = {},
): BranchView {
  const main = selectMainBranch(state, options)
  const mainShas = selectMainShas(state, options)
  const observedAhead =
    branch.name === main ? 0 : branch.commits.filter((sha) => !mainShas.has(sha)).length

  let lastCommitTs: number | null = null
  for (const sha of branch.commits) {
    const commit = state.commits.bySha[sha]
    if (commit === undefined) continue
    if (lastCommitTs === null || commit.landedAt > lastCommitTs) lastCommitTs = commit.landedAt
  }

  return {
    name: branch.name,
    head: branch.head,
    previousHead: branch.previousHead,
    worktreePath: branch.worktreePath,
    isMain: branch.name === main,
    aheadOfMain: aheadOfMain(state, branch, options),
    behindMain: branch.name === main ? 0 : branch.behindMain,
    reportedAhead: branch.aheadOfMain,
    observedAhead,
    commitCount: branch.commits.length,
    lastCommitTs,
    firstSeenAt: branch.firstSeenAt,
    updatedAt: branch.updatedAt,
  }
}

/** Main first, then alphabetical — a stable order the eye can track. */
export function selectBranches(state: SessionState, options: AheadOptions = {}): BranchView[] {
  return Object.values(state.branches)
    .map((branch) => selectBranchView(state, branch, options))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || compareStrings(a.name, b.name))
}

export function selectBranchIndex(
  state: SessionState,
  options: AheadOptions = {},
): Record<string, BranchView> {
  const index: Record<string, BranchView> = {}
  for (const branch of selectBranches(state, options)) index[branch.name] = branch
  return index
}
