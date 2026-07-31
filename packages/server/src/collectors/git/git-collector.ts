import type {
  Collector,
  CollectorContext,
  DirtyFile,
  ExecResult,
  ObservatoryEvent,
  PollResult,
} from '@observatory/core'
import { LOG_PRETTY, parseGitLog } from './parse-log.js'
import { parseForEachRef } from './parse-refs.js'
import { parseStatusPorcelain } from './parse-status.js'
import { parseWorktreeList, type ParsedWorktree } from './parse-worktrees.js'
import type { GitBranchState, GitSnapshot, GitWorktreeState } from './types.js'

const COLLECTOR_NAME = 'git'

function runGit(context: CollectorContext, args: readonly string[], cwd: string): Promise<ExecResult> {
  return context.exec('git', args, { cwd })
}

export const gitCollector: Collector<GitSnapshot> = {
  name: COLLECTOR_NAME,

  initialSnapshot(): GitSnapshot {
    return { disabled: false, mainBranch: null, worktrees: {}, branches: {}, dirty: {} }
  },

  async poll(prevSnapshot, context): Promise<PollResult<GitSnapshot>> {
    if (prevSnapshot.disabled) {
      return { nextSnapshot: prevSnapshot, events: [] }
    }

    const events: ObservatoryEvent[] = []

    const worktreeListResult = await runGit(context, ['worktree', 'list', '--porcelain'], context.repoPath)
    if (worktreeListResult.failed) {
      const reason =
        worktreeListResult.errorMessage ??
        (worktreeListResult.stderr.trim().length > 0
          ? worktreeListResult.stderr.trim()
          : 'git worktree list --porcelain failed')
      events.push(context.emit('collector.disabled', { collector: COLLECTOR_NAME, reason }))
      return { nextSnapshot: { ...prevSnapshot, disabled: true }, events }
    }

    const worktrees = parseWorktreeList(worktreeListResult.stdout)
    const mainBranch = worktrees[0]?.branch ?? null
    const nextWorktrees = diffWorktrees(worktrees, prevSnapshot, context, events)

    const nextBranches = await diffBranches(context, worktrees, mainBranch, prevSnapshot, events)

    const nextDirty = await diffDirty(context, worktrees, prevSnapshot, events)

    return {
      nextSnapshot: { disabled: false, mainBranch, worktrees: nextWorktrees, branches: nextBranches, dirty: nextDirty },
      events,
    }
  },
}

function diffWorktrees(
  worktrees: ParsedWorktree[],
  prevSnapshot: GitSnapshot,
  context: CollectorContext,
  events: ObservatoryEvent[],
): Record<string, GitWorktreeState> {
  const nextWorktrees: Record<string, GitWorktreeState> = {}

  worktrees.forEach((worktree, index) => {
    const state: GitWorktreeState = {
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      isMain: index === 0,
      detached: worktree.detached,
      locked: worktree.locked,
      prunable: worktree.prunable,
    }
    nextWorktrees[worktree.path] = state

    if (!prevSnapshot.worktrees[worktree.path]) {
      events.push(
        context.emit('worktree.discovered', {
          path: state.path,
          branch: state.branch,
          head: state.head,
          isMain: state.isMain,
          detached: state.detached,
          locked: state.locked,
          prunable: state.prunable,
        }),
      )
    }
  })

  for (const path of Object.keys(prevSnapshot.worktrees)) {
    if (!nextWorktrees[path]) {
      events.push(context.emit('worktree.removed', { path }))
    }
  }

  return nextWorktrees
}

async function diffBranches(
  context: CollectorContext,
  worktrees: ParsedWorktree[],
  mainBranch: string | null,
  prevSnapshot: GitSnapshot,
  events: ObservatoryEvent[],
): Promise<Record<string, GitBranchState>> {
  const refsResult = await runGit(
    context,
    ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'],
    context.repoPath,
  )
  if (refsResult.failed) {
    events.push(
      context.emit('collector.error', {
        collector: COLLECTOR_NAME,
        message: 'git for-each-ref failed',
        detail: refsResult.errorMessage ?? refsResult.stderr,
      }),
    )
    return prevSnapshot.branches
  }

  const nextBranches: Record<string, GitBranchState> = {}

  for (const ref of parseForEachRef(refsResult.stdout)) {
    const prevBranch: GitBranchState | undefined = prevSnapshot.branches[ref.branch]
    const { aheadOfMain, behindMain } = await computeAheadBehind(context, mainBranch, ref.branch)
    nextBranches[ref.branch] = { head: ref.head, aheadOfMain, behindMain }

    const headMoved = !prevBranch || prevBranch.head !== ref.head
    const countsChanged =
      prevBranch && (prevBranch.aheadOfMain !== aheadOfMain || prevBranch.behindMain !== behindMain)

    if (headMoved || countsChanged) {
      const worktreePath = worktrees.find((worktree) => worktree.branch === ref.branch)?.path ?? null
      events.push(
        context.emit('branch.updated', {
          branch: ref.branch,
          head: ref.head,
          previousHead: prevBranch?.head ?? null,
          worktreePath,
          aheadOfMain,
          behindMain,
        }),
      )

      if (prevBranch && headMoved) {
        const commits = await loadNewCommits(context, prevBranch.head, ref.head)
        for (const commit of commits) {
          events.push(
            context.emit('commit.landed', {
              sha: commit.sha,
              branch: ref.branch,
              message: commit.subject,
              author: commit.author,
              authoredAt: commit.authoredAt,
              parents: commit.parents,
              files: commit.files,
              insertions: commit.insertions,
              deletions: commit.deletions,
              worktreePath,
            }),
          )
        }
      }
    }
  }

  return nextBranches
}

async function computeAheadBehind(
  context: CollectorContext,
  mainBranch: string | null,
  branch: string,
): Promise<{ aheadOfMain: number | null; behindMain: number | null }> {
  if (!mainBranch) return { aheadOfMain: null, behindMain: null }
  if (branch === mainBranch) return { aheadOfMain: 0, behindMain: 0 }

  const result = await runGit(
    context,
    ['rev-list', '--left-right', '--count', `${mainBranch}...${branch}`],
    context.repoPath,
  )
  if (result.failed) return { aheadOfMain: null, behindMain: null }

  const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number)
  if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) {
    return { aheadOfMain: null, behindMain: null }
  }
  return { aheadOfMain: ahead, behindMain: behind }
}

async function loadNewCommits(context: CollectorContext, fromHead: string, toHead: string) {
  const result = await runGit(
    context,
    ['log', '--raw', '--numstat', '-M', '--reverse', `--pretty=format:${LOG_PRETTY}`, `${fromHead}..${toHead}`],
    context.repoPath,
  )
  if (result.failed) return []
  return parseGitLog(result.stdout)
}

async function diffDirty(
  context: CollectorContext,
  worktrees: ParsedWorktree[],
  prevSnapshot: GitSnapshot,
  events: ObservatoryEvent[],
): Promise<Record<string, DirtyFile[]>> {
  const nextDirty: Record<string, DirtyFile[]> = {}

  for (const worktree of worktrees) {
    const statusResult = await runGit(context, ['status', '--porcelain'], worktree.path)
    if (statusResult.failed) {
      // Transient (e.g. a worktree mid-removal); keep last known state.
      const carried = prevSnapshot.dirty[worktree.path]
      if (carried) nextDirty[worktree.path] = carried
      continue
    }

    const files = parseStatusPorcelain(statusResult.stdout)
    nextDirty[worktree.path] = files

    if (!sameDirtySet(prevSnapshot.dirty[worktree.path], files)) {
      events.push(
        context.emit('worktree.dirty', {
          path: worktree.path,
          branch: worktree.branch,
          files,
        }),
      )
    }
  }

  return nextDirty
}

function sameDirtySet(previous: DirtyFile[] | undefined, current: DirtyFile[]): boolean {
  if (!previous) return current.length === 0
  if (previous.length !== current.length) return false

  const byPath = (a: DirtyFile, b: DirtyFile) => a.path.localeCompare(b.path)
  const sortedPrevious = [...previous].sort(byPath)
  const sortedCurrent = [...current].sort(byPath)

  return sortedPrevious.every((file, index) => {
    const other = sortedCurrent[index]
    return (
      other !== undefined &&
      file.path === other.path &&
      file.status === other.status &&
      file.staged === other.staged
    )
  })
}
