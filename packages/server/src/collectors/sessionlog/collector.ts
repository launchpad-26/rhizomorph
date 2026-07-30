import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  UNATTRIBUTED_LANE,
  type AgentRole,
  type Collector,
  type CollectorContext,
  type ObservatoryEvent,
  type PollResult,
} from '@observatory/core'
import { parseAssistantLine } from './parse-session-line.js'
import { parseWorktreePaths } from './parse-worktree-paths.js'
import { readNewLines } from './tail.js'
import type { SessionlogSnapshot, TailedFileState } from './types.js'
import { worktreePathToProjectSlug } from './worktree-slug.js'

const COLLECTOR_NAME = 'sessionlog'
const JSONL_SUFFIX = '.jsonl'

export interface SessionlogCollectorConfig {
  /**
   * Root of Claude Code's per-project session logs. Defaults to
   * `~/.claude/projects`. Tests point this at a fixture directory so they
   * never depend on (or pollute) the real one.
   */
  claudeProjectsRoot?: string
  /**
   * Extra worktree-shaped paths to also tail — e.g. the conductor's own cwd,
   * possibly on another filesystem (`--extra-sessions`; CLI wiring is a
   * separate issue). Sessions discovered under these are attributed
   * `role: 'conductor'` rather than the default `'worker'`.
   */
  extraSessionDirs?: readonly string[]
}

interface WatchedDir {
  worktreePath: string
  role: AgentRole
}

/**
 * Tails `~/.claude/projects/<slug>/*.jsonl` for every worktree of the watched
 * repo (discovered the same way the git collector does, via
 * `git worktree list --porcelain`) plus any configured extra session dirs.
 * Assistant lines become `llm.usage` (once per `requestId`, since a single
 * reply can span several lines that all repeat the same usage block) and
 * `tool.activity` (one per `tool_use` content block). Missing or
 * undiscoverable session dirs never crash the poll loop — either the whole
 * collector disables itself once (no `~/.claude/projects` at all, or git
 * itself unusable), or a single worktree's project dir is treated as "no
 * session yet" and retried next poll.
 */
export function createSessionlogCollector(
  config: SessionlogCollectorConfig = {},
): Collector<SessionlogSnapshot> {
  const claudeProjectsRoot = config.claudeProjectsRoot ?? path.join(homedir(), '.claude', 'projects')
  const extraSessionDirs = config.extraSessionDirs ?? []

  return {
    name: COLLECTOR_NAME,

    initialSnapshot(): SessionlogSnapshot {
      return { disabled: false, files: {} }
    },

    async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<SessionlogSnapshot>> {
      if (prevSnapshot.disabled) {
        return { nextSnapshot: prevSnapshot, events: [] }
      }

      const rootInfo = await statOrNull(claudeProjectsRoot)
      if (!rootInfo?.isDirectory()) {
        return disable(context, `no Claude Code session log directory at ${claudeProjectsRoot}`)
      }

      const worktreeListResult = await context.exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: context.repoPath,
      })
      if (worktreeListResult.failed) {
        return disable(
          context,
          worktreeListResult.errorMessage ?? 'git worktree list --porcelain failed',
        )
      }

      const watchedDirs: WatchedDir[] = [
        ...parseWorktreePaths(worktreeListResult.stdout).map(
          (worktreePath): WatchedDir => ({ worktreePath, role: 'worker' }),
        ),
        ...extraSessionDirs.map((worktreePath): WatchedDir => ({ worktreePath, role: 'conductor' })),
      ]

      const events: ObservatoryEvent[] = []
      const nextFiles: Record<string, TailedFileState> = { ...prevSnapshot.files }

      for (const dir of watchedDirs) {
        await tailProjectDir(claudeProjectsRoot, dir, context, events, nextFiles)
      }

      return { nextSnapshot: { disabled: false, files: nextFiles }, events }
    },
  }
}

async function tailProjectDir(
  claudeProjectsRoot: string,
  dir: WatchedDir,
  context: CollectorContext,
  events: ObservatoryEvent[],
  nextFiles: Record<string, TailedFileState>,
): Promise<void> {
  const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(dir.worktreePath))
  const projectInfo = await statOrNull(projectDir)
  if (!projectInfo?.isDirectory()) return // no session started here (yet) — not an error

  const entries = await readdir(projectDir).catch(() => [] as string[])
  const jsonlFiles = entries.filter((name) => name.endsWith(JSONL_SUFFIX))

  for (const fileName of jsonlFiles) {
    const filePath = path.join(projectDir, fileName)
    const fallbackSessionId = fileName.slice(0, -JSONL_SUFFIX.length)
    const prevFile = nextFiles[filePath] ?? { offset: 0, lastUsageRequestId: null }

    const { lines, nextOffset } = await readNewLines(filePath, prevFile.offset)
    let lastUsageRequestId = prevFile.lastUsageRequestId

    for (const rawLine of lines) {
      const facts = parseAssistantLine(rawLine)
      if (!facts) continue

      const lane = facts.gitBranch ?? basenameOf(facts.cwd ?? dir.worktreePath) ?? UNATTRIBUTED_LANE
      const sessionId = facts.sessionId ?? fallbackSessionId

      if (facts.requestId && facts.requestId !== lastUsageRequestId) {
        events.push(
          context.emit('llm.usage', {
            lane,
            sessionId,
            worktreePath: dir.worktreePath,
            branch: facts.gitBranch,
            role: dir.role,
            model: facts.model,
            tokens: facts.tokens,
            requestId: facts.requestId,
            durationMs: null,
          }),
        )
        lastUsageRequestId = facts.requestId
      }

      for (const tool of facts.toolUses) {
        events.push(
          context.emit('tool.activity', {
            lane,
            sessionId,
            worktreePath: dir.worktreePath,
            branch: facts.gitBranch,
            tool,
            role: dir.role,
            durationMs: null,
          }),
        )
      }
    }

    nextFiles[filePath] = { offset: nextOffset, lastUsageRequestId }
  }
}

function disable(context: CollectorContext, reason: string): PollResult<SessionlogSnapshot> {
  return {
    nextSnapshot: { disabled: true, files: {} },
    events: [context.emit('collector.disabled', { collector: COLLECTOR_NAME, reason })],
  }
}

async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

function basenameOf(target: string): string | null {
  const base = path.basename(target)
  return base.length > 0 ? base : null
}
