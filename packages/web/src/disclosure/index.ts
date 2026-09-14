/**
 * `web/src/disclosure/` — the one card the instrument explains itself with
 * (prd-30 ruling 1, S1 · #554).
 *
 * **Adoption has happened.** This paragraph used to say the opposite — "wave 1
 * builds the card and nothing else, adoption is later waves' work" — and it
 * stayed that way after the sweep, so the module's own entry point told every
 * reader the re-seat was still pending. It is not: the `title=` sites retired
 * (#220), `MarkHoverCard` and the loupe read-out stopped being separate card
 * chrome so `one-card-law.test.ts` could widen to its full sentence with an
 * empty allowlist (#221), and focus parity became a per-file declaration
 * (#334, ADR-0045), and the last twelve tooltips retired from `scene/`,
 * `replay/` and `concierge/` — which let the residue law **remove** its
 * exemption list rather than empty one (#389). No directory is carved out of
 * it now.
 *
 * The wave numbers this docstring used are PRIOR-TRACKER numbers, like the
 * `#554` above — they are not this repo's prd30 w1/w2, which is why they are
 * gone rather than corrected. `docs/prds/done/prd-30-the-open-hand.md`'s 2026-09-10
 * amendment declares the waves as executed; read that, not a number here.
 *
 * Import the affordance ({@link Disclosure}) rather than the card when you
 * have a mark to wrap; the card is exported for a surface that already owns
 * its own trigger and needs only the chrome.
 *
 * The teach affordance (#561) lives *on the card*, not beside it. There is no
 * `Teach` export here and there must not be one: prd-30
 * ruling 4 says the first hover is the tutorial and there is no other one, so a
 * second teaching surface a caller could mount on its own would be the tour
 * this PRD refused. A selector that has more to show fills in
 * {@link Derivation}; the card grows a control. Nothing else changes.
 */
export { Disclosure, type DisclosureProps } from './Disclosure.js'
export { DisclosureCard, type DisclosureCardProps } from './DisclosureCard.js'
export {
  DisclosureError,
  disclosureLines,
  unknownDisclosure,
  type Derivation,
  type DisclosureContent,
  type DisclosureLines,
  type Evidence,
  type Remedy,
  type UnknownDisclosureInput,
  type Why,
} from './vocabulary.js'
