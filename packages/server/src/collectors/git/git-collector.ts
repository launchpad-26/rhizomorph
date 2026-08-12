import type {
  AdapterCapabilities,
  Collector,
  CollectorContext,
  DirtyFile,
  ExecResult,
  RhizomorphEvent,
  PollResult,
} from '@rhizomorph/core'
import { LOG_PRETTY, parseGitLog } from './parse-log.js'
import { parseForEachRef } from './parse-refs.js'
import { parseStatusPorcelain } from './parse-status.js'
import { parseWorktreeList, type ParsedWorktree } from './parse-worktrees.js'
import type { GitBranchState, GitSnapshot, GitWorktreeState } from './types.js'
import { voiceSkips } from '../parse-skip.js'

const COLLECTOR_NAME = 'git'

/**
 * How many consecutive `git status --porcelain` failures a worktree may
 * carry its last-known dirty set through before the gap becomes a voiced
 * `collector.error` instead of silent stale data. Matches
 * `resilience.ts`'s `DEFAULT_FAILURE_THRESHOLD` — no reason to invent a
 * second convention for "how many failures before something becomes
 * visible".
 */
export const MAX_DIRTY_STATUS_FAILURES = 3

/**
 * prd15 ruling 5's L0 floor: git alone is fully CLI-agnostic and structural
 * for identity, but everything else is a lagging inference over commits and
 * dirty-file deltas, with no attention or telemetry signal at all — the
 * adapters spike's own §3a scoring (`docs/research/2026-08-05-agnostic-adapters-spike.md`).
 */
export const GIT_CAPABILITIES: AdapterCapabilities = {
  identity: { level: 'provided' },
  liveness: {
    level: 'partial',
    reason: 'commit and dirty-file cadence only — minutes-scale, no live read',
    remedy: 'the sessionlog transcript organ gives a live liveness read from the same worktree',
  },
  activity: {
    level: 'partial',
    reason: 'diffstat and dirty-file deltas only — lagging, no in-flight view',
    remedy: 'the sessionlog transcript organ streams per-message activity',
  },
  attention: {
    level: 'absent',
    reason: 'git carries no signal for whether a lane is blocked on a human',
    remedy: 'the sessionlog transcript organ infers it from turn shape; a hook beacon would declare it',
  },
  telemetry: {
    level: 'absent',
    reason: 'git carries no token or usage data',
    remedy: 'the sessionlog transcript organ reads tokens from the CLI transcript',
  },
  cost: {
    level: 'absent',
    reason: 'git carries no cost data',
    remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP dollars where the CLI reports them',
  },
}

function runGit(context: CollectorContext, args: readonly string[], cwd: string): Promise<ExecResult> {
  return context.exec('git', args, { cwd })
}

/**
 * Best available one-line reason a git call failed, in the same order the
 * worktree-list arm of `poll` already uses: the spawn error if the binary
 * could not be run at all, else real stderr, else the exit status.
 *
 * That last arm is load-bearing, not decoration. `errorMessage` is set only
 * for a spawn error (#306 narrowed it there so a hung collector stops reading
 * as an uninstalled one), and a call killed on the exec timeout has no stderr
 * either — so without a literal fallback the `detail` these events carry
 * would be the empty string for exactly the timeout case the callers below
 * exist to describe.
 */
function describeGitFailure(result: ExecResult): string {
  if (result.errorMessage !== undefined) return result.errorMessage
  const stderr = result.stderr.trim()
  if (stderr.length > 0) return stderr
  // No spawn error and no stderr leaves a signal kill, which is what the
  // per-exec timeout (`COLLECTOR_EXEC_TIMEOUT_MS`) produces.
  return result.code === null ? 'killed with no exit code — the exec timeout' : `exited with code ${String(result.code)}`
}

export const gitCollector: Collector<GitSnapshot> = {
  name: COLLECTOR_NAME,
  capabilities: GIT_CAPABILITIES,

  initialSnapshot(): GitSnapshot {
    return {
      disabled: false,
      mainBranch: null,
      mainBranchGapVoiced: false,
      worktrees: {},
      branches: {},
      dirty: {},
      dirtyFailures: {},
    }
  },

  async poll(prevSnapshot, context): Promise<PollResult<GitSnapshot>> {
    if (prevSnapshot.disabled) {
      return { nextSnapshot: prevSnapshot, events: [] }
    }

    const events: RhizomorphEvent[] = []

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
    const mainWorktreeDetached = mainBranch === null

    if (mainWorktreeDetached && !prevSnapshot.mainBranchGapVoiced) {
      events.push(
        context.emit('collector.error', {
          collector: COLLECTOR_NAME,
          message: 'main worktree HEAD is detached — aheadOfMain/behindMain cannot be computed for any branch',
          detail: `no branch checked out at ${worktrees[0]?.path ?? context.repoPath}`,
        }),
      )
    }

    const nextWorktrees = diffWorktrees(worktrees, prevSnapshot, context, events)

    const nextBranches = await diffBranches(context, worktrees, mainBranch, prevSnapshot, events)

    const { dirty: nextDirty, dirtyFailures: nextDirtyFailures } = await diffDirty(
      context,
      worktrees,
      prevSnapshot,
      events,
    )

    return {
      nextSnapshot: {
        disabled: false,
        mainBranch,
        mainBranchGapVoiced: mainWorktreeDetached,
        worktrees: nextWorktrees,
        branches: nextBranches,
        dirty: nextDirty,
        dirtyFailures: nextDirtyFailures,
      },
      events,
    }
  },
}

function diffWorktrees(
  worktrees: ParsedWorktree[],
  prevSnapshot: GitSnapshot,
  context: CollectorContext,
  events: RhizomorphEvent[],
): Record<string, GitWorktreeState> {
  const nextWorktrees: Record<string, GitWorktreeState> = {}

  worktrees.forEach((worktree, index) => {
    // Proven gone: git's own `list --porcelain` already checked the path and
    // will keep listing this record forever (there is no `prune` call in
    // this app), so it must never enter `nextWorktrees` even though it's
    // right here in `worktrees`. Falls into the removal loop below exactly
    // like a worktree that vanished from the list outright — same event,
    // same reducer, no new branch of logic (ADR-0016).
    if (worktree.prunable) return

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
  events: RhizomorphEvent[],
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
        detail: describeGitFailure(refsResult),
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

      const loaded =
        prevBranch && headMoved ? await loadNewCommits(context, prevBranch.head, ref.head) : { commits: [], skipped: [] }

      // The skip, when present, is voiced ahead of this tick's own
      // branch.updated/commit.landed — same "error surfaces first" ordering
      // the tmux collector's list-panes skip already follows.
      if (loaded.skipped.length > 0) {
        events.push(
          context.emit('collector.error', {
            collector: COLLECTOR_NAME,
            message: `skipped ${loaded.skipped.length} unparseable git raw diff line${loaded.skipped.length === 1 ? '' : 's'} on ${ref.branch}`,
            detail: voiceSkips(loaded.skipped),
          }),
        )
      }

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

      for (const commit of loaded.commits) {
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

  for (const name of Object.keys(prevSnapshot.branches)) {
    if (!nextBranches[name]) {
      events.push(context.emit('branch.removed', { branch: name }))
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
  if (result.failed) return { commits: [], skipped: [] }
  return parseGitLog(result.stdout)
}

async function diffDirty(
  context: CollectorContext,
  worktrees: ParsedWorktree[],
  prevSnapshot: GitSnapshot,
  events: RhizomorphEvent[],
): Promise<{ dirty: Record<string, DirtyFile[]>; dirtyFailures: Record<string, number> }> {
  const nextDirty: Record<string, DirtyFile[]> = {}
  const nextFailures: Record<string, number> = {}

  for (const worktree of worktrees) {
    // Dropped by diffWorktrees already — no exec, no carry-forward, and no
    // ENOENT to misread as "git is gone" (ADR-0016).
    if (worktree.prunable) continue

    const statusResult = await runGit(context, ['status', '--porcelain'], worktree.path)
    if (statusResult.failed) {
      const failures = (prevSnapshot.dirtyFailures?.[worktree.path] ?? 0) + 1
      if (failures <= MAX_DIRTY_STATUS_FAILURES) {
        // Genuine transient (index lock, a locked-and-momentarily-
        // unreachable worktree, a permission blip): carry the last known
        // set forward, same as before, but only for a bounded number of
        // polls — a real removal proves itself via `prunable` above, so
        // this branch is never how "gone" is detected.
        const carried = prevSnapshot.dirty[worktree.path]
        if (carried) nextDirty[worktree.path] = carried
        nextFailures[worktree.path] = failures
      } else {
        // Past the bound: asserting old data as current is the thing being
        // fixed, so stop carrying and say so — the same event
        // `diffBranches` already uses for its own single-thing-failed case.
        nextFailures[worktree.path] = failures
        events.push(
          context.emit('collector.error', {
            collector: COLLECTOR_NAME,
            message: `git status --porcelain failed ${failures} times in a row for ${worktree.path}`,
            detail: describeGitFailure(statusResult),
          }),
        )
      }
      continue
    }

    const files = parseStatusPorcelain(statusResult.stdout)
    nextDirty[worktree.path] = files
    // nextFailures[worktree.path] intentionally left unset: a success resets
    // the count to 0, read back via `?? 0` next poll.

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

  return { dirty: nextDirty, dirtyFailures: nextFailures }
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
