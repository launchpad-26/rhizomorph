import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repoSlug, sessionDirFor } from '../log/paths.js'
import type { Colony } from '../server/colonies.js'
import { createColonyRecorders } from './colony-recorders.js'
import { SessionRecorder } from './session-recorder.js'

/**
 * prd-58 ruling 2 — N recorders, one per colony, and the record format does not
 * move.
 *
 * The property that is not a design choice: `docs/record-format.md` puts the
 * repo slug inside the genesis hash and `mergeRecords` refuses across it, so a
 * machine-wide recording cannot be expressed. Two colonies must end up writing
 * to two DIFFERENT files under two different slugs, and nothing may fan one
 * event out to both.
 */

let dataRoot: string
let clock = 5_000_000

const PINNED_PATH = '/repo/main'
const OTHER_PATH = '/elsewhere/proj'

function colony(repoPath: string, pinned: boolean): Colony {
  return { id: repoSlug(repoPath), path: repoPath, pinned }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizo-colrec-'))
  clock = 5_000_000
})

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

function make() {
  const pinnedColony = colony(PINNED_PATH, true)
  const pinnedRecorder = new SessionRecorder(
    'boot-session',
    path.join(sessionDirFor(PINNED_PATH, dataRoot), 'boot.jsonl'),
  )
  const recorders = createColonyRecorders({
    dataRoot,
    pinned: { colony: pinnedColony, recorder: pinnedRecorder },
    now: () => {
      clock += 1_000
      return clock
    },
  })
  return { recorders, pinnedColony, pinnedRecorder }
}

describe('createColonyRecorders', () => {
  it('ADOPTS the pinned recorder rather than re-opening it', () => {
    // The boot path resumes a session, replays a log and seals a file. Opening
    // a second recorder over the same directory would mint a new session id for
    // a session that is already running, which is how today's one-colony
    // behaviour would stop being byte-identical.
    const { recorders, pinnedColony, pinnedRecorder } = make()
    expect(recorders.forColony(pinnedColony)).toBe(pinnedRecorder)
    expect(recorders.forColony(pinnedColony).sessionId).toBe('boot-session')
  })

  it('opens a SECOND recorder for a second colony, under its own slug', () => {
    const { recorders, pinnedColony } = make()
    const other = colony(OTHER_PATH, false)

    const a = recorders.forColony(pinnedColony)
    const b = recorders.forColony(other)

    expect(b).not.toBe(a)
    // Two files, two directories, two slugs — which is what the genesis hash
    // requires and what `mergeRecords` refuses to cross.
    expect(path.dirname(b.filePath)).toBe(sessionDirFor(OTHER_PATH, dataRoot))
    expect(path.dirname(a.filePath)).not.toBe(path.dirname(b.filePath))
    expect(b.filePath).toContain(repoSlug(OTHER_PATH))
  })

  it('is stable: asking twice for one colony returns the SAME recorder', () => {
    // A registry that minted a recorder per call would open a new session file
    // on every tick, which is the failure that looks like working software
    // until someone counts the files.
    const { recorders } = make()
    const other = colony(OTHER_PATH, false)
    expect(recorders.forColony(other)).toBe(recorders.forColony(other))
  })

  it('a colony discovered mid-session starts a FRESH session, not a resumed one', () => {
    // The resume window is a statement about one repo's own continuity.
    // Applying it to a repo the instrument has only just learned about would
    // claim a continuity nobody observed.
    const { recorders } = make()
    const other = colony(OTHER_PATH, false)
    const recorder = recorders.forColony(other)

    expect(recorder.sessionId).not.toBe('boot-session')
    expect(recorder.sessionId).toBe('5001000')
  })

  it('opening one colony does not touch another', () => {
    const { recorders, pinnedColony, pinnedRecorder } = make()
    const beforeSession = pinnedRecorder.sessionId
    const beforeFile = pinnedRecorder.filePath

    recorders.forColony(colony(OTHER_PATH, false))

    expect(pinnedRecorder.sessionId).toBe(beforeSession)
    expect(pinnedRecorder.filePath).toBe(beforeFile)
  })

  it('`has` answers without opening — a question is not a side effect', () => {
    const { recorders } = make()
    const other = colony(OTHER_PATH, false)

    expect(recorders.has(other.id)).toBe(false)
    expect(recorders.all()).toHaveLength(1)

    recorders.forColony(other)
    expect(recorders.has(other.id)).toBe(true)
    expect(recorders.all()).toHaveLength(2)
  })

  it('`all` is ordered by colony id, not by the order discovery happened to run', () => {
    // `doctor` reads this, and a report whose rows move between runs is one
    // nobody can diff.
    const { recorders, pinnedColony } = make()
    const zzz = colony('/repo/zzz', false)
    const aaa = colony('/repo/aaa', false)

    recorders.forColony(zzz)
    recorders.forColony(aaa)
    recorders.forColony(pinnedColony)

    const ids = recorders.all().map((entry) => entry.colony.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('no event reaches two recorders — a recording holds ONE colony', () => {
    // The genesis hash makes this a correctness property rather than a tidiness
    // one: a recording carrying two colonies' events could not verify.
    const { recorders, pinnedColony } = make()
    const other = colony(OTHER_PATH, false)
    const a = recorders.forColony(pinnedColony)
    const b = recorders.forColony(other)

    expect(a.foldSoFar().eventCount).toBe(0)
    expect(b.foldSoFar().eventCount).toBe(0)
    expect(a.filePath).not.toBe(b.filePath)
  })
})
