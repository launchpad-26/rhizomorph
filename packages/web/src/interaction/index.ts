/**
 * `web/src/interaction/` — the interaction card (prd-31 ruling 6, S1 · #556).
 *
 * The unit of reading in a conversation: one prompt→response cycle with its
 * tool tree, time-shaped, quoting the agent's own words and sourcing every
 * fact it shows. {@link buildInteractionCards} is the whole derivation and is
 * pure over `SessionState`; {@link InteractionCard} draws it and computes
 * nothing.
 *
 * **Nothing in here sends anything anywhere.** No model call, no summary, no
 * outbound request of any kind — `no-model-call-law.test.ts` greps this
 * directory and fails by diff if one appears.
 */
export { InteractionCard, type InteractionCardProps } from './InteractionCard.js'
export {
  buildCard,
  buildInteractionCards,
  costFor,
  firstSentence,
  phaseFor,
  quoteFor,
  sumLeafDurations,
  type BuildInteractionOptions,
  type InteractionCardModel,
  type InteractionCost,
  type InteractionFacts,
  type InteractionPhase,
  type InteractionQuote,
  type InteractionRefusal,
  type InteractionSubagent,
  type WorkPhase,
} from './model.js'
