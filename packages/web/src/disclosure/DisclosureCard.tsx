import { useId, useState, type ReactElement } from 'react'
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
 *
 * ---
 *
 * **THE TEACH AFFORDANCE (prd-30 ruling 4 and S2 · #561) — one control, on this
 * card, and it is the whole of the instrument's teaching.**
 *
 * Ruling 4: the first hover *is* the tutorial. There is no tour, no annotated
 * overlay, no "learn the interface" page to drift from the interface — so the
 * beginner's depth has to be here, on the mark, at the moment of the question.
 * The control expands the same triple with the facts it was derived from
 * (`lines.derivation`); it introduces no second voice, because it has no
 * strings of its own to introduce one with.
 *
 * Four disciplines, and each one is a test in `teach-law.test.tsx`, because
 * "helpful" is one careless commit away from the failure #602 is the live
 * example of — 282 lines of individually-correct prose burying a page:
 *
 * 1. **On demand.** The card opens collapsed. The derivation is not in the DOM
 *    at all until a reader asks for it, so it cannot be skimmed past, read
 *    aloud by a screen reader, or found by an in-page search unbidden.
 * 2. **Dismissible.** The same control closes it; `Escape` closes the card
 *    around it.
 * 3. **Never repeated at the reader.** `expanded` is this card instance's own
 *    state and this card unmounts when the disclosure closes — so the expansion
 *    is not remembered across openings, and expanding one mark's card does not
 *    expand another's. That is S2's "not remembered per condition by default",
 *    and it is structural rather than asserted: there is nowhere for the memory
 *    to live.
 * 4. **Offered only when there is something to show.** No derivation, no
 *    control. A control that expands to nothing is the noise, not the fix.
 *
 * **The control's own text never changes.** The caret rotates, `aria-expanded`
 * flips, and the word stays `evidence` — which is what lets the law test assert
 * the expanded card's text is the collapsed card's text plus the derivation
 * lines and *nothing else*. A control that read "show evidence" / "hide
 * evidence" would smuggle a string past that assertion, and the next one after
 * it would be prose.
 */
export interface DisclosureCardProps {
  disclosure: DisclosureContent
  /** Set by {@link Disclosure} so its trigger can point `aria-describedby` here. */
  id?: string
}

export function DisclosureCard({ disclosure, id }: DisclosureCardProps): ReactElement {
  const lines = disclosureLines(disclosure)
  const derivationId = useId()
  const [expanded, setExpanded] = useState(false)

  // The selector had nothing further to show, so there is nothing to teach and
  // no control to offer. See discipline 4 above.
  const teachable = lines.derivation.length > 0

  return (
    <div
      role="tooltip"
      id={id}
      data-disclosure-card=""
      data-testid="disclosure-card"
      className="w-max max-w-xs rounded-none border border-(--surface-line) bg-(--surface-panel) px-2 py-1.5 text-read-body leading-snug shadow-(--elev-overlay)"
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
      {teachable ? (
        <>
          <button
            type="button"
            data-testid="disclosure-teach"
            data-expanded={expanded}
            aria-expanded={expanded}
            // Only while the region exists: `aria-controls` pointing at an id
            // that is not in the document is a dangling reference, and the
            // region is genuinely absent when collapsed rather than hidden.
            aria-controls={expanded ? derivationId : undefined}
            className="focus-ring mt-1 flex items-center gap-1 text-read-floor text-(--ink-dim) hover:text-(--ink-body)"
            onClick={() => {
              setExpanded((open) => !open)
            }}
          >
            <span aria-hidden="true" className={expanded ? 'rotate-90' : undefined}>
              ▸
            </span>
            evidence
          </button>
          {expanded ? (
            <ul id={derivationId} data-testid="disclosure-derivation" className="mt-0.5 space-y-0.5">
              {lines.derivation.map((line, index) => (
                <li
                  // The lines are the selector's, in the selector's order, and
                  // two identical observations at the same age are a legitimate
                  // pair — so position is the only honest identity here. The
                  // list is never reordered or filtered.
                  key={`${String(index)}:${line}`}
                  data-testid="disclosure-derivation-line"
                  className="figures text-read-floor text-(--ink-dim)"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
