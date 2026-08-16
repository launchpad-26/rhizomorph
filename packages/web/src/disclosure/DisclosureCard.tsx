import type { ReactElement } from 'react'
import { disclosureLines, type DisclosureContent } from './vocabulary.js'

/**
 * THE CARD (prd-30 ruling 1, S1 · #554) — label, why-with-evidence, remedy, in
 * that order, and it is the only card chrome the instrument has.
 *
 * The order is markup, not a prop. Three components each drawing their own
 * arrangement is how the app arrived at `MarkHoverCard`, the loupe read-out and
 * ~85 `title=` attributes answering the same question three different ways
 * (prd-30 *Evidence*); a card whose order could be configured would be that
 * again with extra steps.
 *
 * **It renders `disclosureLines` and composes nothing.** Every string on screen
 * comes back from that one function, so a condition reads identically on the
 * scene, in a panel and in the drawer — and so the *only* way to disclose
 * something without evidence is to not disclose it at all: `disclosureLines`
 * throws, and this throws with it. That is deliberate. Rendering a degraded
 * card on a bad disclosure would put back exactly the bare "no data" that this
 * component exists to make impossible, and it would do it in the one place
 * nobody is looking.
 *
 * **Type register.** Reading, not instrument — prd-32's ramp names "disclosure
 * cards" in the reading register by name (`theme.css`, `--text-read-body`).
 * This is prose a person reads once, not a figure they compare down a column.
 *
 * **`data-disclosure-card` is the law's handle.** `one-card-law.test.ts`
 * asserts the attribute appears nowhere outside this directory, so a surface
 * that reimplements the card instead of importing it fails the suite.
 */
export interface DisclosureCardProps {
  disclosure: DisclosureContent
  /** Set by {@link Disclosure} so its trigger can point `aria-describedby` here. */
  id?: string
}

export function DisclosureCard({ disclosure, id }: DisclosureCardProps): ReactElement {
  const lines = disclosureLines(disclosure)

  return (
    <div
      role="tooltip"
      id={id}
      data-disclosure-card=""
      data-testid="disclosure-card"
      className="w-max max-w-xs rounded border border-(--surface-line) bg-(--surface-panel) px-2 py-1.5 text-read-body leading-snug"
    >
      <p data-testid="disclosure-label" className="heading text-(--ink-primary)">
        {lines.label}
      </p>
      <p data-testid="disclosure-why" className="text-(--ink-body)">
        {lines.why}
      </p>
      <p data-testid="disclosure-remedy" className="text-(--ink-dim)">
        {lines.remedy}
        {lines.command === null ? null : (
          <>
            {' '}
            {/*
              The command is its own element rather than more prose, so the
              copy affordance wave 3 seats here (the `AttachButton` idiom, which
              always shows what it copied and never toasts) has something to
              wrap. It reads as a command in the meantime.
            */}
            <code data-testid="disclosure-command" className="figures text-(--ink-body)">
              {lines.command}
            </code>
          </>
        )}
      </p>
    </div>
  )
}
