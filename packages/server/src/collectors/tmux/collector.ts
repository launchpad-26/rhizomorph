import type { AdapterCapabilities, Collector, CollectorContext, RhizomorphEvent, PollResult } from '@rhizomorph/core'
import { countLines, hashPaneContent } from './capture.js'
import { LIST_PANES_FORMAT, parseListPanes } from './list-panes.js'
import { resolveWorktreePath } from '../worktree.js'
import { voiceSkips } from '../parse-skip.js'

const COLLECTOR_NAME = 'tmux'

/** A tmux pane id — `%` then digits (`%0`, `%73`). Used to recover the pane a skipped list-panes line belonged to, since the id is the one field that cannot itself contain the tab that made the line unparseable. */
const PANE_ID = /^%\d+$/

/**
 * prd15 ruling 5's L4 ingredient (paired with workmux): pane content is a
 * real byte-stream witness for identity/liveness/activity, and its footer
 * heuristics are the tmux-era attention read — still an inference, never a
 * declared status (that's workmux's `agent.status`). No telemetry at all:
 * `capture-pane` sees rendered text, not tokens.
 */
export const TMUX_CAPABILITIES: AdapterCapabilities = {
  identity: { level: 'provided' },
  liveness: { level: 'provided' },
  activity: { level: 'provided' },
  attention: {
    level: 'partial',
    reason: 'footer/prompt heuristics over captured pane text, not a declared status',
    remedy: 'pair with the workmux collector for declared `agent.status`',
  },
  telemetry: {
    level: 'absent',
    reason: 'pane capture carries no token data',
    remedy: 'the sessionlog transcript organ reads tokens from the CLI transcript',
  },
  cost: {
    level: 'absent',
    reason: 'pane capture carries no cost data',
    remedy: 'env vars at launch (`rhizomorph env <lane>`) bring OTLP dollars',
  },
}

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
  /**
   * Cache of pane_current_path → worktree root, since a path's toplevel never
   * changes mid-session once resolved. Only a successful resolution is
   * memoised here — a failed resolve is not cached and is retried on every
   * later poll (#505).
   */
  worktreeByPath: Record<string, string | null>
  /** Per-pane-id (or `~unattributed:<reason>`) latch for a malformed
   * list-panes line — same shape as workmux's skip latches (#506). */
  listPanesSkipVoiced: Record<string, boolean>
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
  capabilities: TMUX_CAPABILITIES,

  initialSnapshot(): TmuxSnapshot {
    return { disabled: false, panes: {}, worktreeByPath: {}, listPanesSkipVoiced: {} }
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
    // Resume-safety: a snapshot persisted by a pre-#506 build has no
    // `listPanesSkipVoiced` field at all, so it reads as `undefined`, not
    // `{}` — never read it without this default.
    const listPanesSkipVoiced = prevSnapshot.listPanesSkipVoiced ?? {}
    const nextListPanesSkipVoiced: Record<string, boolean> = {}

    const { panes, skipped } = parseListPanes(listResult.stdout)

    // A pane absent from `nextPanes` has not necessarily closed: its
    // list-panes line may have been skipped this tick, when a tab in a title
    // or path splits the line into the wrong field count. Recover each
    // skipped line's pane id (the tab-free first field, present whenever the
    // line survived enough to skip at all) — used both to hold such panes as
    // still present (below) and as this skip's per-incident latch key
    // (#506): a skip so garbled its own pane id is gone falls back to
    // `~unattributed:<reason>`, same shape as workmux's unattributable skips.
    const skippedPaneIds = new Set<string>()
    let allSkipsAttributed = true
    const skipKeys: string[] = []
    for (const skip of skipped) {
      const candidate = skip.line.split('\t')[0] ?? ''
      if (PANE_ID.test(candidate)) {
        skippedPaneIds.add(candidate)
        skipKeys.push(candidate)
      } else {
        allSkipsAttributed = false
        skipKeys.push(`~unattributed:${skip.reason}`)
      }
    }

    if (skipped.length > 0) {
      // Per-identity latch (#506, #415's shape generalized): voice only when
      // at least one of this batch's keys wasn't already latched;
      // `nextListPanesSkipVoiced` is built fresh from just this poll's keys,
      // so any key absent from a later poll silently re-arms.
      const hasNewIncident = skipKeys.some((key) => !listPanesSkipVoiced[key])
      if (hasNewIncident) {
        events.push(
          context.emit('collector.error', {
            collector: COLLECTOR_NAME,
            message: `skipped ${skipped.length} unparseable list-panes line${skipped.length === 1 ? '' : 's'}`,
            detail: voiceSkips(skipped),
          }),
        )
      }
      for (const key of skipKeys) nextListPanesSkipVoiced[key] = true
    }

    for (const entry of panes) {
      let worktreePath = worktreeByPath[entry.currentPath]
      if (worktreePath === undefined || worktreePath === null) {
        worktreePath = await resolveWorktreePath(entry.currentPath, context.exec)
        if (worktreePath !== null) {
          worktreeByPath[entry.currentPath] = worktreePath
        }
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
          }),
        )
      }
    }

    // A pane absent from `nextPanes` has not necessarily closed: its
    // list-panes line may have been skipped this tick (`skippedPaneIds`,
    // computed above). Announcing a closure for such a pane reports a live
    // agent's pane as dead — and #242's whole point is that one bad line
    // costs that line, not the collector's truth. If a skip is so garbled
    // its own pane id is gone, no absent pane can be proven closed this tick,
    // so every closure waits for a tick we can fully account for.
    for (const [paneId, prevPane] of Object.entries(prevSnapshot.panes)) {
      if (paneId in nextPanes) continue
      if (skippedPaneIds.has(paneId) || !allSkipsAttributed) {
        // Alive but unreadable this tick — carry the last-known snapshot
        // forward unchanged rather than announcing a closure that did not
        // happen. When the line parses again the carried `contentHash` makes
        // the diff correct; when the pane really is gone, the next fully
        // accounted-for tick reports it.
        nextPanes[paneId] = prevPane
        continue
      }
      events.push(context.emit('pane.closed', { paneId }))
    }

    return {
      nextSnapshot: {
        disabled: false,
        panes: nextPanes,
        worktreeByPath,
        listPanesSkipVoiced: nextListPanesSkipVoiced,
      },
      events,
    }
  },
}
