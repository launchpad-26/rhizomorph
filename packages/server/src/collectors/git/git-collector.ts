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
import { describeExecFailure } from '../../server/exec.js'
import { type FanoutOutcome, mapBounded } from '../../server/concurrency.js'

const COLLECTOR_NAME = 'git'

/**
 * How many consecutive `git status --porcelain` failures a worktree may
 * carry its last-known dirty set through before the gap becomes a voiced
 * `collector.error` instead of silent stale data. Matches
 * `resilience.ts`'s `DEFAULT_FAILURE_THRESHOLD` — no reason to invent a
 * second convention for "how many failures before something becomes
 * visible". Voicing happens exactly once per incident — on the poll that
 * crosses this bound — never on every poll in between, and never again on
 * recovery: the counter resets silently so a later incident re-arms and
 * voices again (#415). A voiced close was tried and reverted — per-worktree
 * recovery routed through per-collector `CollectorState` can mask a sibling
 * worktree's still-open incident — the close is now voiced safely via
 * `worktree.dirtyStatusRecovered`, which names its own worktree (#429).
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
 * The three-arm failure describer lives in `server/exec.ts`, beside the
 * `errorMessage` contract that creates its third case — one home (#425
 * review), because the two-arm `errorMessage ?? stderr` bug reappeared in
 * the judge readers after being fixed here.
 */
const describeGitFailure = describeExecFailure

/**
 * `runGit` (via `context.exec`) never rejects — every real and fixture
 * `Exec` resolves an `ExecResult` with `failed: true` instead — so `!ok` here
 * is unreached in practice. Handled anyway because {@link mapBounded} is
 * typed for it: a thrown value becomes a synthetic failed result routed
 * through the same `describeGitFailure` fallback chain as a normal exec
 * failure, so a caller never has to branch on how the outcome failed.
 *
 * `outcome` is `| undefined` only because `noUncheckedIndexedAccess` can't
 * see that {@link mapBounded} returns exactly one outcome per input at its
 * own index — a hole here would itself be a `mapBounded` contract violation,
 * not a real git failure, but it still gets the same failed-result shape
 * rather than a throw, so a bug in the helper surfaces as one collector.error
 * instead of taking the whole poll down.
 */
function execResultOf(outcome: FanoutOutcome<ExecResult> | undefined): ExecResult {
  if (outcome === undefined) {
    return { stdout: '', stderr: '', code: null, failed: true, errorMessage: 'mapBounded returned no outcome at its own index' }
  }
  if (outcome.ok) return outcome.value
  return {
    stdout: '',
    stderr: '',
    code: null,
    failed: true,
    errorMessage: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
  }
}

/** Same shape of defensive unwrap as {@link execResultOf}, for `computeAheadBehind`'s own result type. */
function aheadBehindOf(
  outcome: FanoutOutcome<{ aheadOfMain: number | null; behindMain: number | null }> | undefined,
): { aheadOfMain: number | null; behindMain: number | null } {
  if (outcome !== undefined && outcome.ok) return outcome.value
  return { aheadOfMain: null, behindMain: null }
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
      refsFailures: 0,
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

    const branchResult = await diffBranches(context, worktrees, mainBranch, prevSnapshot, events)

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
        branches: branchResult.branches,
        refsFailures: branchResult.refsFailures,
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
): Promise<{ branches: Record<string, GitBranchState>; refsFailures: number }> {
  const refsResult = await runGit(
    context,
    ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'],
    context.repoPath,
  )
  if (refsResult.failed) {
    const failures = (prevSnapshot.refsFailures ?? 0) + 1
    if (failures === MAX_DIRTY_STATUS_FAILURES + 1) {
      // #429: the exact #415 pattern — silent through the bound, voiced once
      // on crossing it, silent again after. Stays `collector.error` (not a
      // new `worktree.*` event): a single `for-each-ref` call is
      // collector-wide, not per-worktree, so there is only one entity and
      // the masking defect this issue fixes cannot occur here.
      events.push(
        context.emit('collector.error', {
          collector: COLLECTOR_NAME,
          message: `git for-each-ref failed ${failures} times in a row`,
          detail: describeGitFailure(refsResult),
        }),
      )
    }
    return { branches: prevSnapshot.branches, refsFailures: failures }
  }

  const refs = parseForEachRef(refsResult.stdout)

  // Fan out `computeAheadBehind` per branch through #33's bounded helper
  // instead of awaiting each `rev-list` serially. Outcomes land indexed to
  // `refs`, so the loop below still walks branches in for-each-ref's own
  // order no matter which exec settles first — a replay stays byte-identical.
  const aheadBehindOutcomes = await mapBounded(refs, (ref) => computeAheadBehind(context, mainBranch, ref.branch))

  const nextBranches: Record<string, GitBranchState> = {}

  for (const [index, ref] of refs.entries()) {
    const prevBranch: GitBranchState | undefined = prevSnapshot.branches[ref.branch]
    const { aheadOfMain, behindMain } = aheadBehindOf(aheadBehindOutcomes[index])
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

  return { branches: nextBranches, refsFailures: 0 }
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

  // Dropped by diffWorktrees already — no exec, no carry-forward, and no
  // ENOENT to misread as "git is gone" (ADR-0016). A prunable worktree never
  // reaches the fan-out below, so it costs no exec at all.
  const liveWorktrees = worktrees.filter((worktree) => !worktree.prunable)

  // Fan out `git status --porcelain` per worktree through #33's bounded
  // helper instead of awaiting each one serially. Outcomes land indexed to
  // `liveWorktrees`, so the loop below still walks worktrees in `worktree
  // list`'s own order no matter which exec settles first — a replay stays
  // byte-identical, and the per-worktree failure counters below see exactly
  // the same sequence of results they would have serially.
  const statusOutcomes = await mapBounded(liveWorktrees, (worktree) =>
    runGit(context, ['status', '--porcelain'], worktree.path),
  )

  liveWorktrees.forEach((worktree, index) => {
    const statusResult = execResultOf(statusOutcomes[index])
    if (statusResult.failed) {
      const failures = (prevSnapshot.dirtyFailures?.[worktree.path] ?? 0) + 1
      nextFailures[worktree.path] = failures

      if (failures <= MAX_DIRTY_STATUS_FAILURES) {
        // Genuine transient (index lock, a locked-and-momentarily-
        // unreachable worktree, a permission blip): carry the last known
        // set forward, same as before, but only for a bounded number of
        // polls — a real removal proves itself via `prunable` above, so
        // this branch is never how "gone" is detected.
        const carried = prevSnapshot.dirty[worktree.path]
        if (carried) nextDirty[worktree.path] = carried
      } else if (failures === MAX_DIRTY_STATUS_FAILURES + 1) {
        // Past the bound, and only on the one poll that crosses it: asserting
        // old data as current is the thing being fixed, so stop carrying and
        // say so, once (#415). The count is fixed at this single moment, so
        // the message text is stable for the rest of the incident too.
        // #429: a per-worktree fact, voiced as a fact about the worktree —
        // not squeezed through the shared per-collector `collector.error` slot.
        events.push(
          context.emit('worktree.dirtyStatusFailed', {
            worktreePath: worktree.path,
            consecutiveFailures: failures,
            message: describeGitFailure(statusResult),
          }),
        )
      }
      // Every failure after that stays silent — the incident was already
      // voiced once; repeating it every poll is the heartbeat #415 removes.
      return
    }

    const files = parseStatusPorcelain(statusResult.stdout)
    nextDirty[worktree.path] = files
    // nextFailures[worktree.path] intentionally left unset: a success resets
    // the count to 0, silently, so a later incident re-arms and voices again
    // (#415 ruling).

    // #429: safe to voice a close here, because it names its own worktree —
    // a sibling worktree's still-open incident cannot be masked by it, which
    // is exactly what routing this through `collector.recovered` could do
    // (and is why #415 refused to voice one at all).
    if ((prevSnapshot.dirtyFailures?.[worktree.path] ?? 0) > MAX_DIRTY_STATUS_FAILURES) {
      events.push(context.emit('worktree.dirtyStatusRecovered', { worktreePath: worktree.path }))
    }

    if (!sameDirtySet(prevSnapshot.dirty[worktree.path], files)) {
      events.push(
        context.emit('worktree.dirty', {
          path: worktree.path,
          branch: worktree.branch,
          files,
        }),
      )
    }
  })

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
