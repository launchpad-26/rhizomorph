/**
 * `web/src/disclosure/` — the one card the instrument explains itself with
 * (prd-30 ruling 1, S1 · #554).
 *
 * Wave 1 builds the card and nothing else. **Adoption is later waves' work**
 * and deliberately so: `MarkHoverCard`, the loupe read-out and ~85 `title=`
 * sites re-seat here across 25 files, which collides with every other lane in
 * the era if it runs now (prd-30, *sequencing*, wave 3).
 *
 * Import the affordance ({@link Disclosure}) rather than the card when you
 * have a mark to wrap; the card is exported for a surface that already owns
 * its own trigger and needs only the chrome.
 */
export { Disclosure, type DisclosureProps } from './Disclosure.js'
export { DisclosureCard, type DisclosureCardProps } from './DisclosureCard.js'
export {
  DisclosureError,
  disclosureLines,
  unknownDisclosure,
  type DisclosureContent,
  type DisclosureLines,
  type Evidence,
  type Remedy,
  type UnknownDisclosureInput,
  type Why,
} from './vocabulary.js'
