import { z } from 'zod'
import { envelope, nonEmptyString } from './common.js'

/** tmux-sourced events. A pane is identified by its tmux pane id (`%12`). */

export const paneDiscoveredPayloadSchema = z.object({
  paneId: nonEmptyString,
  sessionName: nonEmptyString.nullable().optional(),
  windowName: z.string(),
  windowIndex: z.number().int().nonnegative().optional(),
  currentPath: nonEmptyString,
  currentCommand: z.string().optional(),
  title: z.string().optional(),
  /** Worktree the pane was mapped to via its cwd, when one matched. */
  worktreePath: nonEmptyString.nullable().optional(),
})
export type PaneDiscoveredPayload = z.infer<typeof paneDiscoveredPayloadSchema>

export const paneClosedPayloadSchema = z.object({
  paneId: nonEmptyString,
})
export type PaneClosedPayload = z.infer<typeof paneClosedPayloadSchema>

/**
 * Emitted only when a pane's captured content hash changes between polls —
 * the raw fact behind the flatline detector. It says *that* a pane changed and
 * when, never *what* it said: a hash and a line count are derived from the
 * capture, and the captured text itself is discarded (#292).
 */
export const paneActivityPayloadSchema = z.object({
  paneId: nonEmptyString,
  contentHash: nonEmptyString,
  previousHash: nonEmptyString.nullable().optional(),
  lines: z.number().int().nonnegative().optional(),
})
export type PaneActivityPayload = z.infer<typeof paneActivityPayloadSchema>

export const paneDiscoveredEventSchema = envelope(
  'tmux',
  'pane.discovered',
  paneDiscoveredPayloadSchema,
)
export const paneClosedEventSchema = envelope('tmux', 'pane.closed', paneClosedPayloadSchema)
export const paneActivityEventSchema = envelope('tmux', 'pane.activity', paneActivityPayloadSchema)

export const tmuxEventSchemas = [
  paneDiscoveredEventSchema,
  paneClosedEventSchema,
  paneActivityEventSchema,
] as const
