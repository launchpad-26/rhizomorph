/**
 * Parser for `tmux list-panes -a -F <LIST_PANES_FORMAT>` output. Pure — no
 * shelling out here, so it runs against captured fixtures with no tmux
 * present.
 */
import type { ParseSkip } from '../parse-skip.js'

/** Passed to `tmux list-panes -a -F`. Tab-delimited: none of these fields can contain a tab. */
export const LIST_PANES_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}'

export interface TmuxPaneRecord {
  paneId: string
  sessionName: string | null
  windowIndex: number
  windowName: string
  currentPath: string
  currentCommand: string
  title: string
}

const FIELD_COUNT = 7

/** Parses every line of `list-panes` output. Never throws — a line it can't make sense of is skipped, counted, and returned in `skipped`. */
export function parseListPanes(output: string): { panes: TmuxPaneRecord[]; skipped: ParseSkip[] } {
  const panes: TmuxPaneRecord[] = []
  const skipped: ParseSkip[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.length === 0) continue

    const result = parseListPanesLine(line)
    if (result.ok) {
      panes.push(result.pane)
    } else {
      skipped.push({ line, reason: result.reason })
    }
  }

  return { panes, skipped }
}

function parseListPanesLine(line: string): { ok: true; pane: TmuxPaneRecord } | { ok: false; reason: string } {
  const fields = line.split('\t')
  if (fields.length !== FIELD_COUNT) {
    return { ok: false, reason: `expected ${FIELD_COUNT} tab-separated fields, got ${fields.length}` }
  }

  const [paneId, sessionName, windowIndex, windowName, currentPath, currentCommand, title] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]

  if (paneId.length === 0 || currentPath.length === 0) {
    return { ok: false, reason: 'missing pane id or path' }
  }

  return {
    ok: true,
    pane: {
      paneId,
      sessionName: sessionName.length > 0 ? sessionName : null,
      windowIndex: Number.parseInt(windowIndex, 10),
      windowName,
      currentPath,
      currentCommand,
      title,
    },
  }
}
