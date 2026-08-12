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
