import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * THE SHELL'S OWN LITTLE FILES — the read and the write both `prefs-file.ts`
 * and `run-state-file.ts` need, and neither should have its own copy of.
 *
 * Everything the shell persists lives in the app's `userData` directory: the
 * OS's per-user per-app location, the one place a desktop app may write without
 * asking. Deliberately **not** the instrument's data root — that belongs to the
 * observer's own recordings (the constitution's observer-owns-its-data-dir
 * law), and neither a preference nor a first-run flag is a recording.
 *
 * Two rules, and both are about not making a person's day worse than the bug
 * already did:
 *
 * - **A missing or unreadable file is not an error.** First launch has no file;
 *   a power cut leaves a half-written one. Both resolve to the caller's
 *   defaults, because an app that will not start until you fix its config file
 *   has confused its convenience for yours. The *problem* is still reported, so
 *   a silently-reverted setting is never silent.
 * - **The write is atomic** — a temp file and a rename — which is the fix for
 *   the half-written file above rather than a general principle. A rename is
 *   atomic on both filesystems this ships to, so a reader sees the old file or
 *   the new one and never half of either.
 */

export interface JsonRead {
  /** The parsed value, or `undefined` when there was nothing usable to read. */
  value: unknown
  /** What went wrong, or null. Null for a file that has never existed — that is not a fault. */
  problem: string | null
}

export function readJsonFile(file: string): JsonRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { value: undefined, problem: null }
    return { value: undefined, problem: `${file} could not be read: ${messageOf(error)}` }
  }

  try {
    return { value: JSON.parse(raw), problem: null }
  } catch (error) {
    return {
      value: undefined,
      problem: `${file} is not readable JSON (${messageOf(error)}) — the defaults are in use and the file is left alone`,
    }
  }
}

/** Writes atomically. Returns the problem rather than throwing: a failed save must not take the app down. */
export function writeJsonFile(directory: string, file: string, value: unknown): string | null {
  const temporary = `${file}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return null
  } catch (error) {
    return `${file} could not be written: ${messageOf(error)}`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
