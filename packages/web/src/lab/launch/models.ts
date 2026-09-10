import { useEffect, useState } from 'react'
import { readPreference, readRecordOverlay, subscribeToPreferences, writePreference } from '../../settings/registry.js'

/**
 * THE MODEL LIST IS THE OPERATOR'S (prd-55 ruling 5, wave 1). The launch
 * panel's per-arm model field is a `<select>` over the keys of `lab.models`
 * (`settings/registry.ts`) that are switched on, plus one escape — *other…* —
 * that takes free text and writes the typed name INTO that map as an offered
 * key, so the next launch finds it in the list. Repo-scoped, so the models one
 * project tries do not follow the operator into another (the registry's
 * ruling-3 buckets do that; nothing here knows which repo it is in).
 *
 * A convenience, not a gate — the registry entry's own comment says so before
 * anything reads it. A model absent from this list is still legal on the
 * command line (`rhizomorph lab fork --model`), and nothing here refuses one:
 * `MODEL_GRAMMAR` lives in the server, and the launch route answers for it in
 * its own words, which the panel prints verbatim. What this module decides is
 * only which names the select puts in front of a person. It is the one place
 * the lab reads or writes the map; the settings page surveys it (its state and
 * its default) and edits nothing.
 */

export const LAB_MODELS_PREFERENCE = 'lab.models'

/**
 * The select's escape value. Spelled with an ellipsis — U+2026 — on purpose:
 * a character the server's model grammar does not admit, so no real model name
 * can ever collide with it. A `<select>` value is the one place the panel
 * needs a name that is not a model.
 */
export const OTHER_MODEL = 'other…'

/** The keys of `lab.models` that are on, in the map's own order — the select's model options. */
export function offeredModels(): string[] {
  const record = readPreference(LAB_MODELS_PREFERENCE)
  if (typeof record !== 'object') return []
  return Object.entries(record)
    .filter(([, offered]) => offered === true)
    .map(([model]) => model)
}

/**
 * Write a typed model into the map as an offered key. Returns the name as
 * stored (trimmed), or null when there was nothing to store — whitespace is
 * not a model. A name already offered is no write at all, not a duplicate.
 * Whether the value PERSISTED is the registry's answer (`writePreference`
 * returns false when storage refused); the caller re-reads {@link offeredModels}
 * rather than trusting this return, so a refused write leaves the typed name
 * where it was typed and never in a list that does not hold it.
 */
export function offerModel(typed: string): string | null {
  const model = typed.trim()
  if (model.length === 0) return null
  // Judged against the MERGED view, not the stored overlay: `opus` is offered
  // by the entry's own fallback with nothing stored, and typing it under
  // other… is not a write. What is written is the overlay plus this one key,
  // so a declared default is never frozen into the operator's browser
  // (`readRecordOverlay`'s own reason for existing).
  if (!offeredModels().includes(model)) {
    writePreference(LAB_MODELS_PREFERENCE, { ...readRecordOverlay(LAB_MODELS_PREFERENCE), [model]: true })
  }
  return model
}

/**
 * The offered models as React state, following the registry's own change
 * signal — a name added under other… in one arm row is on offer in every
 * other row, and on the settings page, without anything being passed down.
 */
export function useOfferedModels(): string[] {
  const [models, setModels] = useState<string[]>(offeredModels)
  useEffect(() => {
    setModels(offeredModels())
    return subscribeToPreferences(() => setModels(offeredModels()))
  }, [])
  return models
}
