/**
 * Parser for `tmux list-panes -a -F <LIST_PANES_FORMAT>` output. Pure — no
 * shelling out here, so it runs against captured fixtures with no tmux
 * present.
 */

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

/** Parses every line of `list-panes` output. Throws on a line that doesn't match {@link LIST_PANES_FORMAT}. */
export function parseListPanes(output: string): TmuxPaneRecord[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map(parseListPanesLine)
}

function parseListPanesLine(line: string): TmuxPaneRecord {
  const fields = line.split('\t')
  if (fields.length !== FIELD_COUNT) {
    throw new Error(
      `tmux collector: expected ${FIELD_COUNT} tab-separated fields, got ${fields.length}: ${line}`,
    )
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
    throw new Error(`tmux collector: malformed list-panes line (missing pane id or path): ${line}`)
  }

  return {
    paneId,
    sessionName: sessionName.length > 0 ? sessionName : null,
    windowIndex: Number.parseInt(windowIndex, 10),
    windowName,
    currentPath,
    currentCommand,
    title,
  }
}
