import path from 'node:path'
import { sessionDirFor, sessionFileName } from '../log/paths.js'
import type { Colony } from '../server/colonies.js'
import { SessionRecorder } from './session-recorder.js'

/**
 * ONE RECORDER PER COLONY — prd-58 ruling 2.
 *
 * **This is not a design choice, and the PRD says so.**
 * `docs/record-format.md` builds a recording's genesis as
 * `sha256hex('rhizomorph-record:<schemaVersion>:<repoSlug>:<actor.instance>')`,
 * with the repo slug **inside the hash chain**, and `mergeRecords` refuses
 * across it. A machine-wide recording cannot be expressed in this format. N
 * repos means N recorders, and the alternative was never available.
 *
 * The machinery was already per-slug before this existed: prd-16 writes under
 * `~/.local/share/rhizomorph/<repo-slug>/`, and rotation, retention and
 * `rhizomorph archive` are per recorder. This holds several of them; it does
 * not change what any one of them does, which is why Success 4 can say
 * `docs/record-format.md` and `packages/core/src/wire/protocol.ts` carry no
 * edit.
 *
 * **What it deliberately is not:** a fan-out. Nothing here writes one event to
 * two recorders. A colony's events go to that colony's recorder and nowhere
 * else, because a recording that held two colonies' events would be the very
 * thing the genesis hash refuses.
 */
export interface ColonyRecorders {
  /** The recorder for this colony, opened on first use. */
  forColony(colony: Colony): SessionRecorder
  /** Every recorder opened so far, in colony-id order. */
  all(): { colony: Colony; recorder: SessionRecorder }[]
  /** Whether this colony already has one — without opening it. */
  has(colonyId: string): boolean
}

export interface ColonyRecordersOptions {
  readonly dataRoot: string
  /**
   * The pinned colony's recorder, already open.
   *
   * The boot path opens one before anything is discovered — it resumes a
   * session, replays a log and seals a file, and none of that belongs here.
   * Adopting it rather than re-opening it is what keeps today's behaviour
   * **byte-identical** for the one-colony case: the same session id, the same
   * file, the same resume decision.
   */
  readonly pinned: { colony: Colony; recorder: SessionRecorder }
  /** Epoch ms, for a new colony's session id and file name. Injectable, never `Date.now()` inline. */
  readonly now: () => number
}

export function createColonyRecorders(options: ColonyRecordersOptions): ColonyRecorders {
  const { dataRoot, pinned, now } = options
  const byId = new Map<string, { colony: Colony; recorder: SessionRecorder }>([[pinned.colony.id, pinned]])

  return {
    has(colonyId: string): boolean {
      return byId.has(colonyId)
    },

    forColony(colony: Colony): SessionRecorder {
      const existing = byId.get(colony.id)
      if (existing !== undefined) return existing.recorder

      // A colony discovered mid-session gets a recorder without restarting the
      // others and without ending any session (#608's DoD). It starts a FRESH
      // session rather than resuming: the resume window is a statement about
      // one repo's own continuity, and applying it to a repo the instrument has
      // only just learned about would claim a continuity nobody observed.
      const ts = now()
      const sessionId = String(ts)
      const filePath = path.join(sessionDirFor(colony.path, dataRoot), sessionFileName(ts))
      const recorder = new SessionRecorder(sessionId, filePath)
      byId.set(colony.id, { colony, recorder })
      return recorder
    },

    all(): { colony: Colony; recorder: SessionRecorder }[] {
      // Sorted, so a reader — `doctor` above all — gets a stable order rather
      // than insertion order, which is the order discovery happened to run in.
      return [...byId.values()].sort((a, b) => (a.colony.id < b.colony.id ? -1 : a.colony.id > b.colony.id ? 1 : 0))
    },
  }
}
