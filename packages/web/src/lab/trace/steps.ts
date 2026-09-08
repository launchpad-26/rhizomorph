import type { TranscriptEntry } from '../../drawer/useTranscript.js'

/**
 * ONE STEP of a transcript, reduced to what divergence compares (prd53 S3):
 * who spoke, and what — with absolute paths masked.
 *
 * Why masked: an arm's session is the parent's, cut at the checkpoint and
 * PATH-REWRITTEN to the arm's own worktree (prd12 ruling 5 — an agent acting
 * on its parent's files is the one corruption the design makes impossible).
 * So the same step in parent and arm differs by exactly its absolute paths,
 * and by nothing else. Judging equality with paths masked is what makes "the
 * arm left the parent behind here" a fact rather than a false alarm on every
 * row. It is also why the two files cannot be lined up by byte offset — the
 * rewrite changes lengths — which is why `diff.ts` aligns by content.
 */
export interface Step {
  /** 0-based position in its own transcript. */
  index: number
  role: string
  /** What the step said, as shown. Never persisted (see `no-persistence-law.test.ts`). */
  text: string
  /** `role` + masked text. Two steps with equal keys are the same step. */
  key: string
}

/**
 * An absolute path: a slash that does not continue a word (so `a/relative` is
 * not one), then path segments. Masked to `/…` before comparison.
 */
const ABSOLUTE_PATH = /(?<![\w.~])\/(?:[\w.@+~-]+\/)*[\w.@+~-]+/g

export function maskPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, '/…')
}

/** The step's words: text blocks, a tool call's name and hint, a tool result's text. The role is not part of the text. */
export function entryText(entry: TranscriptEntry): string {
  const parts: string[] = []
  for (const block of entry.blocks) {
    if (block.kind === 'text') parts.push(block.text)
    else if (block.kind === 'tool_use') parts.push(block.name, block.hint)
    else parts.push(block.text)
  }
  return parts.join(' ').trim()
}

export function stepKey(entry: TranscriptEntry): string {
  return `${entry.role} ${maskPaths(entryText(entry))}`
}

export function toSteps(entries: readonly TranscriptEntry[]): Step[] {
  return entries.map((entry, index) => ({
    index,
    role: entry.role,
    text: entryText(entry),
    key: stepKey(entry),
  }))
}
