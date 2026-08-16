import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPreferences, preferencesPath, savePreferences } from './prefs-file.js'
import { DEFAULT_PREFERENCES, HOST_PREFS, readPreferences, withPreference } from './prefs.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'rhizomorph-prefs-'))
}

describe('the declared set', () => {
  it('declares every key the preferences object has, and no other', () => {
    expect(HOST_PREFS.map((entry) => entry.id).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort())
  })

  it('has a label and a reason for each — a settings surface renders both', () => {
    for (const entry of HOST_PREFS) {
      expect(entry.label.length).toBeGreaterThan(3)
      expect(entry.what.length).toBeGreaterThan(20)
    }
  })

  it('offers all four notifications, individually', () => {
    const ids = HOST_PREFS.map((entry) => entry.id)
    expect(ids).toContain('notifications.needsHuman')
    expect(ids).toContain('notifications.died')
    expect(ids).toContain('notifications.landed')
    expect(ids).toContain('notifications.spend')
  })

  /**
   * prd-35 ruling 2's never-configurable list, and the one entry on it this
   * package could plausibly have violated: the simulated/real distinction. Demo
   * mode is an ACT in the tray, never a setting — so there must be nothing here
   * that could dim its chrome, hide its banner or make it default.
   */
  it('declares nothing that could weaken the simulated/real distinction', () => {
    const spelled = HOST_PREFS.map((entry) => `${entry.id} ${entry.label} ${entry.what}`).join(' ')
    expect(spelled).not.toMatch(/simulat|\bdemo\b|\bfixture\b|synthetic|sample fleet/i)
  })
})

describe('the defaults are decisions', () => {
  it('turns all four notifications on — a daemon that says nothing has no reason to exist', () => {
    expect(DEFAULT_PREFERENCES['notifications.needsHuman']).toBe(true)
    expect(DEFAULT_PREFERENCES['notifications.died']).toBe(true)
    expect(DEFAULT_PREFERENCES['notifications.landed']).toBe(true)
    expect(DEFAULT_PREFERENCES['notifications.spend']).toBe(true)
  })

  it('offers launch-on-login rather than imposing it (ruling 2)', () => {
    expect(DEFAULT_PREFERENCES['application.launchOnLogin']).toBe(false)
  })

  it('leaves the window closing to the tray, and the threshold unset', () => {
    expect(DEFAULT_PREFERENCES['application.closeToTray']).toBe(true)
    expect(DEFAULT_PREFERENCES['notifications.spendThresholdUsd']).toBeNull()
  })
})

describe('reading a stored file', () => {
  it('keeps stored values and fills the rest from the defaults', () => {
    const merged = readPreferences({ 'notifications.died': false, 'notifications.spendThresholdUsd': 25 })
    expect(merged['notifications.died']).toBe(false)
    expect(merged['notifications.spendThresholdUsd']).toBe(25)
    expect(merged['notifications.landed']).toBe(true)
  })

  it('discards a value of the wrong shape rather than refusing to start', () => {
    const merged = readPreferences({ 'notifications.died': 'false', 'application.launchOnLogin': 1 })
    expect(merged['notifications.died']).toBe(true)
    expect(merged['application.launchOnLogin']).toBe(false)
  })

  it('ignores a key it does not know', () => {
    expect(readPreferences({ 'something.else': true })).toEqual(DEFAULT_PREFERENCES)
  })

  it('refuses a zero threshold — it would fire on the first request of every session', () => {
    expect(readPreferences({ 'notifications.spendThresholdUsd': 0 })['notifications.spendThresholdUsd']).toBeNull()
    expect(readPreferences({ 'notifications.spendThresholdUsd': -5 })['notifications.spendThresholdUsd']).toBeNull()
  })

  it('accepts an explicit null as unsetting the threshold', () => {
    const set = readPreferences({ 'notifications.spendThresholdUsd': 30 })
    expect(readPreferences({ ...set, 'notifications.spendThresholdUsd': null })['notifications.spendThresholdUsd']).toBeNull()
  })

  it('survives a file that is not an object at all', () => {
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(readPreferences('nope')).toEqual(DEFAULT_PREFERENCES)
  })
})

describe('changing one', () => {
  it('returns a new object, changed', () => {
    const result = withPreference(DEFAULT_PREFERENCES, 'notifications.died', false)
    expect(result.refused).toBeNull()
    expect(result.changed).toBe(true)
    expect(result.preferences['notifications.died']).toBe(false)
    // The original is untouched — the caller persists what it is handed.
    expect(DEFAULT_PREFERENCES['notifications.died']).toBe(true)
  })

  it('says so when nothing actually changed', () => {
    expect(withPreference(DEFAULT_PREFERENCES, 'notifications.died', true).changed).toBe(false)
  })

  it('refuses an unknown id, by name', () => {
    const result = withPreference(DEFAULT_PREFERENCES, 'alarms.quieter', true)
    expect(result.refused).toContain('alarms.quieter')
    expect(result.preferences).toBe(DEFAULT_PREFERENCES)
  })

  it('refuses a value of the wrong kind, and says which kind it wanted', () => {
    expect(withPreference(DEFAULT_PREFERENCES, 'notifications.died', 'yes').refused).toContain('true or false')
    expect(withPreference(DEFAULT_PREFERENCES, 'notifications.spendThresholdUsd', 'ten').refused).toContain(
      'positive amount',
    )
    expect(withPreference(DEFAULT_PREFERENCES, 'notifications.spendThresholdUsd', 0).refused).toContain(
      'positive amount',
    )
  })
})

describe('the file on disk', () => {
  it('round-trips', () => {
    const dir = scratch()
    try {
      const changed = withPreference(DEFAULT_PREFERENCES, 'notifications.landed', false).preferences
      expect(savePreferences(dir, changed)).toBeNull()
      expect(loadPreferences(dir)).toEqual({ preferences: changed, problem: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a first launch as defaults, not as a fault', () => {
    const dir = scratch()
    try {
      expect(loadPreferences(dir)).toEqual({ preferences: DEFAULT_PREFERENCES, problem: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the problem when the file is unreadable, and starts anyway', () => {
    const dir = scratch()
    try {
      writeFileSync(preferencesPath(dir), '{ not json', 'utf8')
      const loaded = loadPreferences(dir)
      expect(loaded.preferences).toEqual(DEFAULT_PREFERENCES)
      expect(loaded.problem).toContain('not readable JSON')
      expect(loaded.problem).toContain('left alone')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates the directory rather than failing on a fresh profile', () => {
    const dir = path.join(scratch(), 'nested', 'userData')
    try {
      expect(savePreferences(dir, DEFAULT_PREFERENCES)).toBeNull()
      expect(loadPreferences(dir).preferences).toEqual(DEFAULT_PREFERENCES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failed write instead of throwing out of a settings change', () => {
    // A path that cannot be a directory: the file itself is in the way.
    const dir = scratch()
    try {
      writeFileSync(path.join(dir, 'blocked'), 'x', 'utf8')
      const problem = savePreferences(path.join(dir, 'blocked'), DEFAULT_PREFERENCES)
      expect(problem).toContain('could not be written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
