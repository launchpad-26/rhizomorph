import { beforeEach, describe, expect, it } from 'vitest'
import { adoptRepoScope, readRecordOverlay, subscribeToPreferences, writePreference } from '../../settings/registry.js'
import { LAB_MODELS_PREFERENCE, OTHER_MODEL, offeredModels, offerModel } from './models.js'

/**
 * The list the select reads, and the one way a name joins it (prd-55 ruling
 * 5). Every test starts from a fresh repo bucket: the registry is module state
 * behind `localStorage`, so a name offered in one test would otherwise be on
 * offer in the next.
 */
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  adoptRepoScope(null)
  localStorage.clear()
})

describe("offeredModels — the keys of lab.models that are on, in the map's order", () => {
  it('offers the three aliases from a fresh repo', () => {
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('offers only the keys that are on — a key switched off leaves the list, a key added joins it', () => {
    writePreference(LAB_MODELS_PREFERENCE, { sonnet: false, 'claude-opus-5': true })
    expect(offeredModels()).toEqual(['opus', 'haiku', 'claude-opus-5'])
  })

  it('follows the repo — a model offered in one repo is not on offer in another (ruling 3)', () => {
    adoptRepoScope('/repos/a')
    offerModel('claude-opus-5')
    expect(offeredModels()).toContain('claude-opus-5')

    adoptRepoScope('/repos/b')
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku'])
  })
})

describe('offerModel — other… writes the typed name into the map as an offered key', () => {
  it('stores the name trimmed, on, and reports what it stored', () => {
    expect(offerModel('  claude-opus-5  ')).toBe('claude-opus-5')
    expect(readRecordOverlay(LAB_MODELS_PREFERENCE)).toEqual({ 'claude-opus-5': true })
    expect(offeredModels()).toEqual(['opus', 'sonnet', 'haiku', 'claude-opus-5'])
  })

  it('refuses whitespace — nothing is stored and nothing is reported', () => {
    expect(offerModel('   ')).toBeNull()
    expect(readRecordOverlay(LAB_MODELS_PREFERENCE)).toEqual({})
  })

  it('a name already offered is no write at all — the registry hears nothing', () => {
    let heard = 0
    const stop = subscribeToPreferences(() => {
      heard += 1
    })
    try {
      expect(offerModel('opus')).toBe('opus')
      expect(heard).toBe(0)
      // …and a name switched off is switched back on, which IS a write.
      writePreference(LAB_MODELS_PREFERENCE, { opus: false })
      heard = 0
      expect(offerModel('opus')).toBe('opus')
      expect(heard).toBe(1)
      expect(offeredModels()).toContain('opus')
    } finally {
      stop()
    }
  })

  it('is a list and never a gate — a name the server would refuse is still stored, and the server answers for it', () => {
    // `MODEL_GRAMMAR` (`packages/server/src/lab/fork.ts`, `api/lab.ts`) refuses
    // the space; this module does not, on purpose: the refusal belongs to the
    // launch route, which prints it verbatim, not to a preference.
    expect(offerModel('not a model')).toBe('not a model')
    expect(offeredModels()).toContain('not a model')
  })
})

describe('OTHER_MODEL — the escape value can never be a model', () => {
  it("carries a character the server's model grammar does not admit, so no real model can collide with it", () => {
    // The grammar as `api/lab.ts` spells it — letters, digits, and . _ : -
    // only. Pinned here so the escape cannot quietly become a legal name.
    expect(/^[A-Za-z0-9._:-]+$/.test(OTHER_MODEL)).toBe(false)
    expect(OTHER_MODEL).toBe('other…')
  })
})
