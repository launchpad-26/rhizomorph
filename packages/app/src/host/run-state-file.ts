import path from 'node:path'
import { NEW_RUN_STATE, readRunState, type RunState } from './first-run.js'
import { readJsonFile, writeJsonFile } from './json-file.js'

/**
 * WHAT THE SHELL REMEMBERS BETWEEN LAUNCHES (#565) — three facts, beside the
 * preferences and deliberately not among them.
 *
 * **First-run state is not a preference**, and keeping the two files apart is
 * how that stays true. A preference is a person's declared choice, enumerable
 * on a settings page (prd-35's whole problem statement); `seenDemo` is a fact
 * about history that nobody chose and nobody should be offered a switch for.
 * Merging them would put "have you seen the demo" one honest-looking feature
 * request away from becoming a toggle — and the simulated/real distinction is
 * on ruling 2's never-configurable list.
 */

export const RUN_STATE_FILE = 'first-run.json'

export function runStatePath(userDataDir: string): string {
  return path.join(userDataDir, RUN_STATE_FILE)
}

export interface LoadedRunState {
  state: RunState
  problem: string | null
}

export function loadRunState(userDataDir: string): LoadedRunState {
  const read = readJsonFile(runStatePath(userDataDir))
  if (read.value === undefined) return { state: { ...NEW_RUN_STATE }, problem: read.problem }
  return { state: readRunState(read.value), problem: read.problem }
}

export function saveRunState(userDataDir: string, state: RunState): string | null {
  return writeJsonFile(userDataDir, runStatePath(userDataDir), state)
}
