import { createHash } from 'node:crypto'

/**
 * Pure helpers over `tmux capture-pane -p` output — the raw fact behind
 * `pane.activity`. Hashing (not diffing) is deliberate: the collector only
 * needs to know *whether* a pane changed, never what changed.
 */

export function hashPaneContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function countLines(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}

/** Last non-blank line of a capture, for a human-readable "what is it doing" preview. */
export function lastNonEmptyLine(content: string): string | undefined {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (line) return line
  }
  return undefined
}
