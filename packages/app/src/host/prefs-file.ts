import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, readPreferences, type HostPreferences } from './prefs.js'

/**
 * WHERE THE SHELL'S PREFERENCES LIVE (#564).
 *
 * One JSON file in the app's own `userData` directory — the OS's per-user
 * per-app location, which is the one place a desktop app may write without
 * asking. Deliberately **not** in the instrument's data root: that directory
 * belongs to the observer's own recordings (the constitution's
 * observer-owns-its-data-dir law), and a shell preference is not a recording.
 *
 * **A missing or unreadable file is not an error.** First launch has no file;
 * a half-written one is what a power cut leaves behind. Both resolve to the
 * declared defaults, because an app that will not start until you fix its
 * config file is an app that has confused its own convenience for yours.
 *
 * The write is atomic — a temp file and a rename — for the case that produced
 * the unreadable file in the first place. A rename is atomic on both
 * filesystems this ships to, so a reader sees the old file or the new one and
 * never half of either.
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
  const file = preferencesPath(userDataDir)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { preferences: { ...DEFAULT_PREFERENCES }, problem: null }
    return { preferences: { ...DEFAULT_PREFERENCES }, problem: `${file} could not be read: ${messageOf(error)}` }
  }

  try {
    return { preferences: readPreferences(JSON.parse(raw)), problem: null }
  } catch (error) {
    return {
      preferences: { ...DEFAULT_PREFERENCES },
      problem: `${file} is not readable JSON (${messageOf(error)}) — the defaults are in use and the file is left alone`,
    }
  }
}

/** Writes atomically. Returns the problem rather than throwing: a failed save must not take the app down. */
export function savePreferences(userDataDir: string, preferences: HostPreferences): string | null {
  const file = preferencesPath(userDataDir)
  const temporary = `${file}.tmp`
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return null
  } catch (error) {
    return `${file} could not be written: ${messageOf(error)}`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
