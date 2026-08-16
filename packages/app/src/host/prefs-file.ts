import path from 'node:path'
import { readJsonFile, writeJsonFile } from './json-file.js'
import { DEFAULT_PREFERENCES, readPreferences, type HostPreferences } from './prefs.js'

/**
 * WHERE THE SHELL'S PREFERENCES LIVE (#564) — one JSON file in the app's own
 * `userData` directory. The read/write rules, and why a bad file must never
 * stop the app from starting, are in `json-file.ts`.
 */

export const PREFERENCES_FILE = 'preferences.json'

export function preferencesPath(userDataDir: string): string {
  return path.join(userDataDir, PREFERENCES_FILE)
}

export interface LoadedPreferences {
  preferences: HostPreferences
  /**
   * What went wrong reading the file, when something did. Null on a clean read
   * AND on a first launch — a file that has never existed is not a fault.
   * Surfaced so the shell can say it rather than silently reverting a person's
   * settings to the defaults, which is the loud-degradation rule (D43) applied
   * to the smallest thing this app owns.
   */
  problem: string | null
}

export function loadPreferences(userDataDir: string): LoadedPreferences {
  const read = readJsonFile(preferencesPath(userDataDir))
  if (read.value === undefined) return { preferences: { ...DEFAULT_PREFERENCES }, problem: read.problem }
  return { preferences: readPreferences(read.value), problem: read.problem }
}

export function savePreferences(userDataDir: string, preferences: HostPreferences): string | null {
  return writeJsonFile(userDataDir, preferencesPath(userDataDir), preferences)
}
