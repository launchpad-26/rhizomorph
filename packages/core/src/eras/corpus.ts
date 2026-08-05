import era1Recording from './era-1/recording.jsonl?raw'
import era1Snapshot from './era-1/session-state.snapshot.json?raw'
import { ERAS, type EraRecording } from './fold.js'

/**
 * THE CORPUS, WITH ITS BYTES — the only part of the era corpus that touches
 * files, and it does so at import time rather than at run time.
 *
 * `fold.ts` holds the registry and the arithmetic and stays pure; this module
 * binds each era's two files in as text via Vite's `?raw`. That split is what
 * lets core keep having no `node:*` anywhere (it has no Node types in scope —
 * see `fold.ts`) while a test still compares committed bytes to a fresh fold.
 *
 * The texts are **verbatim file contents**, which is the whole point: the
 * snapshot law is byte equality, and a parsed-then-restringified snapshot would
 * compare our serializer against itself instead of against what is committed.
 */
export interface LoadedEra extends EraRecording {
  /** `recordingFile`'s exact contents. */
  recordingText: string
  /** `snapshotFile`'s exact contents — the committed fold, byte for byte. */
  snapshotText: string
}

const TEXTS: Readonly<Record<string, { recordingText: string; snapshotText: string }>> = {
  'era-1': { recordingText: era1Recording, snapshotText: era1Snapshot },
}

/**
 * Every era in {@link ERAS}, with its bytes. Throws at import time for an era
 * declared in the registry but never bound here — a corpus with a registry
 * entry nothing reads is a law that silently covers one fewer era, which is
 * exactly the kind of quiet gap this whole ruling is about.
 */
export const ERA_CORPUS: readonly LoadedEra[] = ERAS.map((era) => {
  const texts = TEXTS[era.name]
  if (texts === undefined) {
    throw new Error(
      `era "${era.name}" is in the registry but its files are not imported in corpus.ts — add them`,
    )
  }
  return { ...era, ...texts }
})

/** The era every other test reaches for when it wants a real recording. Era 1 is the oldest we hold. */
export function eraCorpusEntry(name: string): LoadedEra {
  const found = ERA_CORPUS.find((era) => era.name === name)
  if (found === undefined) throw new Error(`no era named "${name}" in the corpus`)
  return found
}
