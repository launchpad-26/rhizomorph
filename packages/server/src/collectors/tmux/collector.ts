import type { Collector, CollectorContext, RhizomorphEvent, PollResult } from '@rhizomorph/core'
import { countLines, hashPaneContent, lastNonEmptyLine } from './capture.js'
import { LIST_PANES_FORMAT, parseListPanes } from './list-panes.js'
import { resolveWorktreePath } from './worktree.js'

const COLLECTOR_NAME = 'tmux'

export interface TmuxPaneSnapshot {
  paneId: string
  sessionName: string | null
  windowIndex: number
  windowName: string
  currentPath: string
  currentCommand: string
  title: string
  worktreePath: string | null
  contentHash: string | null
}

export interface TmuxSnapshot {
  /** Set once tmux is missing or no server is running. Every later poll is a no-op. */
  disabled: boolean
  panes: Record<string, TmuxPaneSnapshot>
  /** Cache of pane_current_path → worktree root, since a path's toplevel never changes mid-session. */
  worktreeByPath: Record<string, string | null>
}

/**
 * `Collector` implementation for tmux. Shells to `list-panes` and
 * `capture-pane` via the injected `exec`, diffs against `prevSnapshot`, and
 * emits `pane.discovered/closed/activity`. Disables itself permanently (one
 * `collector.disabled`, then no-ops) the first time `list-panes` fails —
 * covers both "tmux not installed" and "no server running".
 */
export const tmuxCollector: Collector<TmuxSnapshot> = {
  name: COLLECTOR_NAME,

  initialSnapshot(): TmuxSnapshot {
    return { disabled: false, panes: {}, worktreeByPath: {} }
  },

  async poll(prevSnapshot, context: CollectorContext): Promise<PollResult<TmuxSnapshot>> {
    if (prevSnapshot.disabled) {
      return { nextSnapshot: prevSnapshot, events: [] }
    }

    const listResult = await context.exec('tmux', ['list-panes', '-a', '-F', LIST_PANES_FORMAT])
    if (listResult.failed) {
      const reason =
        listResult.errorMessage ??
        (listResult.stderr.trim().length > 0
          ? listResult.stderr.trim()
          : `tmux exited with code ${String(listResult.code)}`)
      const event = context.emit('collector.disabled', { collector: COLLECTOR_NAME, reason })
      return {
        nextSnapshot: { ...prevSnapshot, disabled: true },
        events: [event],
      }
    }

    const events: RhizomorphEvent[] = []
    const nextPanes: Record<string, TmuxPaneSnapshot> = {}
    const worktreeByPath = { ...prevSnapshot.worktreeByPath }

    for (const entry of parseListPanes(listResult.stdout)) {
      let worktreePath = worktreeByPath[entry.currentPath]
      if (worktreePath === undefined) {
        worktreePath = await resolveWorktreePath(entry.currentPath, context.exec)
        worktreeByPath[entry.currentPath] = worktreePath
      }

      const prevPane = prevSnapshot.panes[entry.paneId]
      const captureResult = await context.exec('tmux', ['capture-pane', '-p', '-t', entry.paneId])
      const contentHash = captureResult.failed
        ? (prevPane?.contentHash ?? null)
        : hashPaneContent(captureResult.stdout)

      nextPanes[entry.paneId] = {
        paneId: entry.paneId,
        sessionName: entry.sessionName,
        windowIndex: entry.windowIndex,
        windowName: entry.windowName,
        currentPath: entry.currentPath,
        currentCommand: entry.currentCommand,
        title: entry.title,
        worktreePath,
        contentHash,
      }

      if (!prevPane) {
        events.push(
          context.emit('pane.discovered', {
            paneId: entry.paneId,
            sessionName: entry.sessionName,
            windowName: entry.windowName,
            windowIndex: entry.windowIndex,
            currentPath: entry.currentPath,
            currentCommand: entry.currentCommand || undefined,
            title: entry.title || undefined,
            worktreePath,
          }),
        )
      }

      if (contentHash && contentHash !== (prevPane?.contentHash ?? null)) {
        events.push(
          context.emit('pane.activity', {
            paneId: entry.paneId,
            contentHash,
            previousHash: prevPane?.contentHash ?? null,
            lines: countLines(captureResult.stdout),
            preview: lastNonEmptyLine(captureResult.stdout),
          }),
        )
      }
    }

    for (const paneId of Object.keys(prevSnapshot.panes)) {
      if (!(paneId in nextPanes)) {
        events.push(context.emit('pane.closed', { paneId }))
      }
    }

    return {
      nextSnapshot: { disabled: false, panes: nextPanes, worktreeByPath },
      events,
    }
  },
}
