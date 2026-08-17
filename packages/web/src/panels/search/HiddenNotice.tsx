import { hiddenLine, type FilterResult } from './session.js'

/**
 * THE DECLARATION, rendered (prd-31 ruling 4, #559) — "a filtered view declares
 * itself and its hidden count".
 *
 * One component, so the three surfaces cannot end up phrasing law 12 three
 * ways, and `role="status"` so a screen reader is told the list under it just
 * became partial rather than just becoming shorter.
 *
 * Renders `null` when nothing is filtered. That is not an optimisation: a
 * permanent "0 hidden" on every unfiltered screen would train a reader to stop
 * reading the line, which is precisely the line that must be read on the one
 * screen where it is not zero.
 */
export interface HiddenNoticeProps {
  result: Pick<FilterResult<unknown>, 'hidden' | 'filtering'>
  /** What this surface holds, plural — "turns", "events", "interactions". */
  noun: string
  query: string
  shown: number
  /** Distinguishes the three mounts in a test, and nothing else. */
  surface: string
}

export function HiddenNotice({ result, noun, query, shown, surface }: HiddenNoticeProps) {
  const line = hiddenLine(result, { noun, query, shown })
  if (line === null) return null

  return (
    <p
      role="status"
      data-testid={`session-search-hidden-${surface}`}
      data-hidden={result.hidden}
      className="shrink-0 border-b border-(--line-hair) px-1 py-1 text-inst leading-snug text-(--ink-dim)"
    >
      {line}
    </p>
  )
}
