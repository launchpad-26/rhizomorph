import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AdapterCapabilities,
  BEACON_ATTENTION_KINDS,
  BEACON_LAPSE_MS,
  type CollectorContext,
  createCollectorContext,
  type DeclaredAttention,
  deriveRung,
  type EventOf,
  mergeCapabilities,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_HOOK_EVENTS } from '../../cli/env.js'
import { canonicalize } from '../../paths/containment.js'
import { withResilience } from '../resilience.js'
import { SESSIONLOG_CAPABILITIES } from '../sessionlog/collector.js'
import { WORKMUX_CAPABILITIES } from '../workmux/collector.js'
import { BEACON_CAPABILITIES, beaconCapabilitiesFor, createBeaconCollector } from './collector.js'
import { parseBeaconLine } from './parse-beacon-line.js'
import { beaconDirFor, installationBeaconDir } from './paths.js'

/**
 * One injectable read fault, for the "present but unreadable this tick" case.
 *
 * The first form of that test made the file unreadable with `chmod 0o000`,
 * which proves nothing on win32: Node's chmod there toggles the read-only
 * attribute and the file opens fine, so the leg read four beacons where the
 * test expected none (EXECUTED on #267's windows-suite run). The fault class
 * the collector guards against — EACCES while a writer re-permissions, EMFILE,
 * a share lock — is a *failed open of a file that is still there*, and the
 * honest way to produce exactly that on every OS is to fail the read once at
 * the seam the collector already goes through. Everything else in this file
 * reaches the real filesystem; the passthrough below is the real function.
 */
const readFault = vi.hoisted(() => ({ armed: false }))
vi.mock('./read-beacon-lines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./read-beacon-lines.js')>()
  return {
    ...actual,
    readBeaconLines: async (...args: Parameters<typeof actual.readBeaconLines>) => {
      if (readFault.armed) {
        readFault.armed = false
        const error = new Error('EMFILE: too many open files') as NodeJS.ErrnoException
        error.code = 'EMFILE'
        throw error
      }
      return actual.readBeaconLines(...args)
    },
  }
})

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'claude-hook.jsonl')
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8')
// The capture has at least four lines: one per hook event (#282). The first
// three keep standing in for "an arbitrary well-formed line" everywhere below
// that does not care which hook produced it.
const FIXTURE_LINES = FIXTURE.split('\n').filter((line) => line.length > 0)
const [LINE1, LINE2, LINE3] = FIXTURE_LINES as [string, string, string]

function sha256(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex')
}

const atOf = (line: string): number => (JSON.parse(line) as { at: number }).at

// The hand-written fixture's lines 2 and 3 before #282 replaced it with a
// capture — kept verbatim so the two contract cases they proved (an extra
// key is digested but not carried; an absent lane reads back as null) still
// have coverage now that the emitter never writes either shape itself.
const EXTRA_LITERAL =
  '{"v":1,"at":1725000001000,"writer":"claude-hook","kind":"working","lane":"2-core","extra":"ignored but digested"}'
const BARE_LITERAL = '{"v":1,"at":1725000002000,"writer":"claude-hook","kind":"stopped"}'

/** The beacon collector never execs; a context whose exec throws proves it. */
function context(repoPath = '/repo', now = 2_000): CollectorContext {
  let next = 0
  return createCollectorContext({
    repoPath,
    now,
    exec: async () => {
      throw new Error('the beacon collector must never exec')
    },
    nextId: () => `beacon-${(next += 1)}`,
  })
}

function ofType<T extends RhizomorphEvent['type']>(events: readonly RhizomorphEvent[], type: T): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type)
}

/** Every file's bytes under `dir`, keyed by basename — the read-only witness. */
async function bytesOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name)
    try {
      out[name] = await readFile(full, 'utf8')
    } catch {
      out[name] = '<directory>'
    }
  }
  return out
}

describe('createBeaconCollector (ADR-0036, prd-27 w1)', () => {
  let root: string
  let dir: string
  let cursorKey: (name: string) => string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-collector-'))
    dir = beaconDirFor('/repo', root)
    // The snapshot is keyed by the file's FULL path since prd-57 ruling 6,
    // because two doors can hold a file of the same name and a shared key
    // would make one file's cursor resume the other's.
    cursorKey = (name: string) => path.join(dir, name)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('a missing directory is the ordinary state, not a fault', () => {
    it('three polls with no directory: no events, never disabled, no files tracked', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      let snapshot = collector.initialSnapshot()
      for (let i = 0; i < 3; i += 1) {
        const result = await collector.poll(snapshot, context())
        expect(result.events).toEqual([])
        expect(result.nextSnapshot).toEqual({ disabled: false, files: {} })
        snapshot = result.nextSnapshot
      }
    })

    it('an empty directory reads the same way', async () => {
      await mkdir(dir, { recursive: true })
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(result.events).toEqual([])
      expect(result.nextSnapshot).toEqual({ disabled: false, files: {} })
    })

    it('never creates the directory it reads', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      await collector.poll(collector.initialSnapshot(), context())
      await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  /**
   * THE CWD IS CANONICALISED HERE, and the join in `packages/core` depends on
   * it being so.
   *
   * prd-57 ruling 3 compares this value against `process.seen`'s
   * `worktreePath` for plain string equality, in a package `node:fs` cannot
   * enter (ADR-0003). `placementOf` canonicalises its side; this collector
   * wrote the harness's string verbatim, so any spelling difference — a repo
   * reached through a symlink, #217's standing macOS case — made every
   * lane-less beacon decline, permanently and silently.
   *
   * Pinned with `..` rather than a symlink so it runs on every platform:
   * Windows needs elevation to create one, and the point is that the value is
   * RESOLVED, not which resolver step did it.
   */
  describe("the line's cwd is canonicalised before it leaves (prd-57 ruling 3, #589)", () => {
    it('resolves a cwd written with .. to the directory it names', async () => {
      const inner = path.join(root, 'wt-a')
      await mkdir(inner, { recursive: true })
      await mkdir(dir, { recursive: true })
      // Built by concatenation, not `path.join`: join NORMALISES, so it would
      // hand the collector an already-resolved path and the pin would prove
      // nothing. The harness writes whatever string it has.
      const written = `${inner}${path.sep}..${path.sep}wt-a`
      await writeFile(
        path.join(dir, 'claude-hook.jsonl'),
        `${JSON.stringify({ v: 1, at: 1_000, writer: 'claude-hook', kind: 'working', cwd: written, pid: 4321 })}\n`,
      )

      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const [beacon] = ofType(result.events, 'beacon.received')

      expect(beacon?.payload.cwd).toBe(canonicalize(inner))
      expect(beacon?.payload.cwd).not.toBe(written)
    })

    it('resolves a cwd whose directory is GONE, through the ancestor that is still there', async () => {
      /**
       * A worktree removed since the hook fired. `canonicalize` handles this
       * itself — it walks up to the nearest existing ancestor and re-joins the
       * tail — so the value is still canonical and still comparable against a
       * `worktreePath` recorded while the directory existed.
       *
       * The first version of this case was titled "keeps a cwd it cannot
       * resolve", which is not what a missing directory is: `canonicalize`
       * throws only on ELOOP or EACCES. It passed while exercising nothing of
       * the sort — the same shape this PRD keeps meeting, a test naming a
       * behaviour it does not reach.
       */
      await mkdir(dir, { recursive: true })
      const gone = path.join(root, 'vanished')
      await writeFile(
        path.join(dir, 'claude-hook.jsonl'),
        `${JSON.stringify({ v: 1, at: 1_000, writer: 'claude-hook', kind: 'working', cwd: gone, pid: 4321 })}\n`,
      )

      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const [beacon] = ofType(result.events, 'beacon.received')

      expect(beacon?.payload.cwd).toBe(canonicalize(gone))
      // NOT a pin on the canonicalisation itself: `os.tmpdir()` resolves to
      // itself on Linux and on most Windows hosts, so `canonicalize(gone)`
      // equals `gone` there and this passes with the canonicalisation removed.
      // The case above is what pins that. This one pins the gone-directory
      // behaviour, which is what it is named for.
      expect(beacon?.payload.cwd?.endsWith('vanished')).toBe(true)
    })
  })

  describe('one file, the fixture', () => {
    beforeEach(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), FIXTURE)
    })

    it('emits one beacon.received per line, in file order, with the writer clock as ts', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const beacons = ofType(result.events, 'beacon.received')
      expect(result.events).toHaveLength(FIXTURE_LINES.length)
      expect(beacons.map((event) => event.ts)).toEqual(FIXTURE_LINES.map(atOf))
    })

    it('the first event is exact: payload, digest of the raw line, file and offset 0', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const first = JSON.parse(LINE1) as { writer: string; kind: string; lane: string | null; detail?: string }
      expect(first.writer).toBe('claude-hook')
      expect(BEACON_ATTENTION_KINDS).toContain(first.kind)
      expect(result.events[0]).toEqual({
        id: 'beacon-1',
        ts: atOf(LINE1),
        source: 'beacon',
        type: 'beacon.received',
        payload: {
          writer: first.writer,
          kind: first.kind,
          lane: first.lane,
          detail: first.detail,
          digest: sha256(LINE1),
          file: 'claude-hook.jsonl',
          offset: 0,
        },
      })
    })

    it('the second event starts where the first line ended, and every later offset is the byte sum of the lines before it', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const [, second, third] = ofType(result.events, 'beacon.received')
      expect(second?.payload.offset).toBe(Buffer.byteLength(`${LINE1}\n`))
      expect(second?.payload.digest).toBe(sha256(LINE2))
      expect(third?.payload.offset).toBe(Buffer.byteLength(`${LINE1}\n${LINE2}\n`))
    })

    it('contract cases the emitter never writes: an extra key is digested not carried, an absent lane reads null', async () => {
      await writeFile(path.join(dir, 'extra.jsonl'), `${EXTRA_LITERAL}\n`)
      await writeFile(path.join(dir, 'bare.jsonl'), `${BARE_LITERAL}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const beacons = ofType(result.events, 'beacon.received')
      const extraEvent = beacons.find((event) => event.payload.file === 'extra.jsonl')
      const bareEvent = beacons.find((event) => event.payload.file === 'bare.jsonl')

      expect(extraEvent?.payload.digest).toBe(sha256(EXTRA_LITERAL))
      expect(extraEvent?.payload).not.toHaveProperty('extra')

      expect(bareEvent?.payload.lane).toBeNull()
      expect(bareEvent?.payload).not.toHaveProperty('detail')
    })

    it('the digest is over the line as written, not the parsed object', async () => {
      // Same JSON, different bytes: a digest over the parsed object would not tell these apart.
      await writeFile(path.join(dir, 'spaced.jsonl'), `${LINE3.replaceAll(':', ': ')}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const spaced = ofType(result.events, 'beacon.received').find((event) => event.payload.file === 'spaced.jsonl')
      expect(spaced?.payload.digest).toBe(sha256(LINE3.replaceAll(':', ': ')))
      expect(spaced?.payload.digest).not.toBe(sha256(LINE3))
    })

    it('is idempotent: three more polls with no writes emit nothing and move no cursor', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      const cursor = first.nextSnapshot.files[cursorKey('claude-hook.jsonl')]
      expect(cursor?.offset).toBe(Buffer.byteLength(FIXTURE))
      expect(cursor?.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) })

      let snapshot = first.nextSnapshot
      for (let i = 0; i < 3; i += 1) {
        const result = await collector.poll(snapshot, context())
        expect(result.events).toEqual([])
        expect(result.nextSnapshot.files[cursorKey('claude-hook.jsonl')]).toEqual(cursor)
        snapshot = result.nextSnapshot
      }
    })

    it('an appended line arrives once, and the cursor advances by exactly its bytes', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      const appended = '{"v":1,"at":1725000003000,"writer":"claude-hook","kind":"waiting","lane":"2-core"}'
      await writeFile(path.join(dir, 'claude-hook.jsonl'), `${appended}\n`, { flag: 'a' })

      const second = await collector.poll(first.nextSnapshot, context())
      expect(second.events).toHaveLength(1)
      expect(second.events[0]).toMatchObject({
        type: 'beacon.received',
        ts: 1_725_000_003_000,
        payload: { offset: Buffer.byteLength(FIXTURE), digest: sha256(appended) },
      })
      expect(second.nextSnapshot.files[cursorKey('claude-hook.jsonl')]?.offset).toBe(Buffer.byteLength(FIXTURE) + Buffer.byteLength(appended) + 1)

      const third = await collector.poll(second.nextSnapshot, context())
      expect(third.events).toEqual([])
    })

    it('a partial trailing line is left alone until it completes, then emitted exactly once', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      const file = path.join(dir, 'claude-hook.jsonl')

      await writeFile(file, '{"v":1,"at":', { flag: 'a' })
      const second = await collector.poll(first.nextSnapshot, context())
      expect(second.events).toEqual([])
      expect(second.nextSnapshot.files[cursorKey('claude-hook.jsonl')]?.offset).toBe(Buffer.byteLength(FIXTURE))

      await writeFile(file, '1725000004000,"writer":"claude-hook","kind":"stopped"}\n', { flag: 'a' })
      const third = await collector.poll(second.nextSnapshot, context())
      expect(ofType(third.events, 'beacon.received').map((event) => event.ts)).toEqual([1_725_000_004_000])
      const fourth = await collector.poll(third.nextSnapshot, context())
      expect(fourth.events).toEqual([])
    })

    it('a rotated file (new inode at the same path) is read from byte 0', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      const file = path.join(dir, 'claude-hook.jsonl')
      await unlink(file)
      const fresh = '{"v":1,"at":1725000009000,"writer":"claude-hook","kind":"working"}'
      await writeFile(file, `${fresh}\n`)

      const second = await collector.poll(first.nextSnapshot, context())
      expect(second.events).toHaveLength(1)
      expect(second.events[0]).toMatchObject({ type: 'beacon.received', ts: 1_725_000_009_000, payload: { offset: 0 } })
    })

    it('a removed file drops out of the snapshot with no events', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      await unlink(path.join(dir, 'claude-hook.jsonl'))
      const second = await collector.poll(first.nextSnapshot, context())
      expect(second.events).toEqual([])
      expect(second.nextSnapshot.files).toEqual({})
    })

    it('a file that is present but unreadable for one tick keeps its cursor, so nothing is re-emitted', async () => {
      // The sibling of the case above. A vanished file and a file that merely
      // could not be opened this tick both land in the same catch, but only
      // one of them is gone: dropping the cursor for the other made the next
      // successful tick read from byte 0 and re-emit every beacon already on
      // the log. EXECUTED before the fix: three duplicates beside the one new
      // beacon.
      const file = path.join(dir, 'claude-hook.jsonl')
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      expect(ofType(first.events, 'beacon.received')).toHaveLength(FIXTURE_LINES.length)

      const fourth = '{"v":1,"at":1725000003000,"writer":"claude-hook","kind":"landed"}'
      await appendFile(file, `${fourth}\n`)
      readFault.armed = true // the next open of a beacon file fails, once — see the mock at the top of this file
      const second = await collector.poll(first.nextSnapshot, context())
      expect(readFault.armed).toBe(false) // the fault was actually consumed by this tick
      expect(second.events).toEqual([])
      expect(second.nextSnapshot.files[cursorKey('claude-hook.jsonl')]?.offset).toBe(first.nextSnapshot.files[cursorKey('claude-hook.jsonl')]?.offset)

      const third = await collector.poll(second.nextSnapshot, context())
      const beacons = ofType(third.events, 'beacon.received')
      expect(beacons).toHaveLength(1)
      expect(beacons[0]?.payload.kind).toBe('landed')
      expect(beacons[0]?.payload.offset).toBe(Buffer.byteLength(FIXTURE))
    })
  })

  describe('the directory', () => {
    it('reads two writers, grouped by sorted basename, each event naming its own file', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'gate.jsonl'), '{"v":1,"at":10,"writer":"gate","kind":"landed","lane":"2-core"}\n')
      await writeFile(path.join(dir, 'claude-hook.jsonl'), `${LINE1}\n${LINE3}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(ofType(result.events, 'beacon.received').map((event) => [event.payload.file, event.payload.writer])).toEqual([
        ['claude-hook.jsonl', 'claude-hook'],
        ['claude-hook.jsonl', 'claude-hook'],
        ['gate.jsonl', 'gate'],
      ])
      // Keys are full paths; the EVENTS still name the basename, which is what
      // a reader recognises. Asserted as a pair so a change to either is loud.
      expect(Object.keys(result.nextSnapshot.files).sort()).toEqual(
        [cursorKey('claude-hook.jsonl'), cursorKey('gate.jsonl')].sort(),
      )
    })

    it('ignores anything that is not a *.jsonl file: notes, a subdirectory, a temp file', async () => {
      await mkdir(path.join(dir, 'old'), { recursive: true })
      await writeFile(path.join(dir, 'notes.txt'), `${LINE1}\n`)
      await writeFile(path.join(dir, 'partial.jsonl.tmp'), `${LINE1}\n`)
      await writeFile(path.join(dir, 'old', 'archived.jsonl'), `${LINE1}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(result.events).toEqual([])
      expect(result.nextSnapshot.files).toEqual({})
    })

    it('retarget-safety: the directory is derived from the tick\'s repoPath, so a new repoPath reads a new directory', async () => {
      const otherDir = beaconDirFor('/other', root)
      await mkdir(dir, { recursive: true })
      await mkdir(otherDir, { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), `${LINE1}\n`)
      await writeFile(path.join(otherDir, 'gate.jsonl'), '{"v":1,"at":10,"writer":"gate","kind":"landed"}\n')

      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context('/repo'))
      expect(ofType(first.events, 'beacon.received').map((event) => event.payload.file)).toEqual(['claude-hook.jsonl'])

      // A retarget resets snapshots, as POST /api/retarget does; the next tick reads the adopted repo's directory.
      const second = await collector.poll(collector.initialSnapshot(), context('/other'))
      expect(ofType(second.events, 'beacon.received').map((event) => event.payload.file)).toEqual(['gate.jsonl'])
    })
  })

  describe('a malformed line is survived, counted and named — never fatal', () => {
    it('one beacon.received for the valid line and exactly one collector.error for the file, count 2', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'bad.jsonl'), ['not json', '{"v":2,"at":5,"writer":"hook","kind":"waiting"}', LINE1].join('\n') + '\n')
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())

      expect(ofType(result.events, 'beacon.received')).toHaveLength(1)
      const errors = ofType(result.events, 'collector.error')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.payload).toEqual({
        collector: 'beacon',
        message: 'malformed beacon line skipped in bad.jsonl',
        detail: 'beacon line is not valid JSON (first at byte 0)',
        count: 2,
      })
      expect(result.nextSnapshot.disabled).toBe(false)
      expect(ofType(result.events, 'collector.disabled')).toEqual([])
    })

    it('the fault is not re-reported: a later poll with no new bytes emits nothing', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'bad.jsonl'), 'not json\n')
      const collector = createBeaconCollector({ dataRoot: root })
      const first = await collector.poll(collector.initialSnapshot(), context())
      expect(ofType(first.events, 'collector.error')).toHaveLength(1)
      const second = await collector.poll(first.nextSnapshot, context())
      expect(second.events).toEqual([])
    })

    it('a blank line is a malformed line: reported, counted, and the next beacon keeps its true offset (#217 verify)', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), `\n${LINE1}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())

      const beacons = ofType(result.events, 'beacon.received')
      expect(beacons).toHaveLength(1)
      expect(beacons[0]?.payload.offset).toBe(1)
      expect(beacons[0]?.payload.digest).toBe(sha256(LINE1))

      const errors = ofType(result.events, 'collector.error')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.payload).toMatchObject({ count: 1, detail: 'beacon line is not valid JSON (first at byte 0)' })
    })

    it('a blank line in the middle shifts nothing: every later offset points at real bytes', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), `${LINE1}\n\n${LINE3}\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const offsets = ofType(result.events, 'beacon.received').map((event) => event.payload.offset)
      expect(offsets).toEqual([0, Buffer.byteLength(`${LINE1}\n\n`)])
      expect(ofType(result.events, 'collector.error')[0]?.payload.detail).toBe(
        `beacon line is not valid JSON (first at byte ${Buffer.byteLength(`${LINE1}\n`)})`,
      )
    })

    it('the first reason and its offset are the ones reported when several lines are bad', async () => {
      await mkdir(dir, { recursive: true })
      const bad1 = '{"v":1,"at":1,"writer":"hook","kind":"waiting","lane":""}'
      await writeFile(path.join(dir, 'bad.jsonl'), `${LINE1}\n${bad1}\n[1]\n`)
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(ofType(result.events, 'collector.error')[0]?.payload).toMatchObject({
        count: 2,
        detail: `beacon "lane" is empty or too long (first at byte ${Buffer.byteLength(`${LINE1}\n`)})`,
      })
    })
  })

  describe("through the resilience wrapper — a line fault and a tick fault are two different things", () => {
    it('a malformed line under withResilience is one error and no degrade', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'bad.jsonl'), `not json\n${LINE1}\n`)
      const wrapped = withResilience(createBeaconCollector({ dataRoot: root }))
      const result = await wrapped.poll(wrapped.initialSnapshot(), context())
      expect(ofType(result.events, 'beacon.received')).toHaveLength(1)
      expect(ofType(result.events, 'collector.error')).toHaveLength(1)
      expect(ofType(result.events, 'collector.degraded')).toEqual([])
      expect(ofType(result.events, 'collector.disabled')).toEqual([])
    })

    it('a file where the directory should be is a tick fault: collector.disabled naming the path, disabled: true', async () => {
      await mkdir(path.dirname(dir), { recursive: true })
      await writeFile(dir, '')
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toMatchObject({
        type: 'collector.disabled',
        payload: { collector: 'beacon', reason: `beacon path is not a directory: ${dir}` },
      })
      expect(result.nextSnapshot.disabled).toBe(true)
    })

    it('…and under withResilience that degrades twice, then disables on the third tick', async () => {
      await mkdir(path.dirname(dir), { recursive: true })
      await writeFile(dir, '')
      const wrapped = withResilience(createBeaconCollector({ dataRoot: root }), { failureThreshold: 3 })
      let snapshot = wrapped.initialSnapshot()
      const seen: string[] = []
      for (let tick = 1; tick <= 3; tick += 1) {
        const result = await wrapped.poll(snapshot, context('/repo', tick * 1_000))
        seen.push(...result.events.map((event) => event.type))
        snapshot = result.nextSnapshot
      }
      expect(seen).toEqual(['collector.degraded', 'collector.degraded', 'collector.disabled'])
    })

    it('a disabled snapshot handed straight back polls as a no-op (the latch the wrapper releases)', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll({ disabled: true, files: {} }, context())
      expect(result).toEqual({ nextSnapshot: { disabled: true, files: {} }, events: [] })
    })
  })

  describe('the collector reads and nothing else', () => {
    it('never writes a byte to the directory and never execs, across a full scenario', async () => {
      await mkdir(path.join(dir, 'old'), { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), FIXTURE)
      await writeFile(path.join(dir, 'bad.jsonl'), `not json\n\n${LINE1}\n`)
      await writeFile(path.join(dir, 'notes.txt'), 'hello\n')
      const before = await bytesOf(dir)

      const collector = createBeaconCollector({ dataRoot: root })
      let snapshot = collector.initialSnapshot()
      for (let i = 0; i < 3; i += 1) {
        snapshot = (await collector.poll(snapshot, context())).nextSnapshot // context's exec throws if called
      }

      expect(await bytesOf(dir)).toEqual(before)
    })
  })

  describe('the fixture is a capture (#282)', () => {
    it('is newline-terminated', () => {
      expect(FIXTURE.endsWith('\n')).toBe(true)
    })

    it('every line parses as a v1 beacon signed claude-hook for lane 2-core', () => {
      for (const line of FIXTURE_LINES) {
        const parsed = parseBeaconLine(line)
        expect(parsed.kind).toBe('beacon')
        if (parsed.kind !== 'beacon') continue
        expect(parsed.payload.writer).toBe('claude-hook')
        expect(parsed.payload.lane).toBe('2-core')
      }
    })

    it('every kind is in the ruled vocabulary, and all three kinds occur', () => {
      const kinds = new Set(FIXTURE_LINES.map((line) => (JSON.parse(line) as { kind: string }).kind))
      for (const kind of kinds) {
        expect(BEACON_ATTENTION_KINDS as readonly string[]).toContain(kind)
      }
      for (const kind of BEACON_ATTENTION_KINDS) {
        expect(kinds.has(kind)).toBe(true)
      }
    })

    it("every detail names the hook that fired, and the (event → kind) pairs match the emitter's table", () => {
      for (const line of FIXTURE_LINES) {
        const parsed = JSON.parse(line) as { kind: string; detail?: string }
        expect(parsed.detail).toMatch(/^hook: (Notification|Stop|UserPromptSubmit|PostToolUse)$/)
        const event = parsed.detail?.replace(/^hook: /, '')
        const expectedKind = CLAUDE_HOOK_EVENTS.find(([e]) => e === event)?.[1]
        expect(parsed.kind).toBe(expectedKind)
      }
    })

    it('every at is a whole second in milliseconds — the printed command\'s clock, not a hand', () => {
      let previous = -Infinity
      for (const line of FIXTURE_LINES) {
        const at = atOf(line)
        expect(at % 1000).toBe(0)
        expect(at).toBeGreaterThanOrEqual(previous)
        previous = at
      }
    })
  })

  describe('the manifest', () => {
    it('declares attention partial and signs it beacon, with ruling 3 as the reason', () => {
      const attention = BEACON_CAPABILITIES.attention
      expect(attention.level).toBe('partial')
      expect(attention.witness).toBe('beacon')
      expect(attention.level !== 'provided' && attention.reason).toContain('ruling 3')
    })

    it('a configured-but-silent beacon does NOT read as the PTY rung — the false rung ADR-0036 recorded, closed by type', () => {
      // `partial` attention + `absent` telemetry was L3 before #218. The
      // witness is what keeps it off that rung; nothing else about this
      // manifest changed to earn L0.
      expect(BEACON_CAPABILITIES.telemetry.level).toBe('absent')
      expect(deriveRung(BEACON_CAPABILITIES)).toBe('L0')
    })

    it('adding the silent beacon to a fleet changes no signal the transcript organ already has', () => {
      const merged = mergeCapabilities([SESSIONLOG_CAPABILITIES, BEACON_CAPABILITIES])
      for (const signal of Object.keys(SESSIONLOG_CAPABILITIES) as (keyof AdapterCapabilities)[]) {
        expect(merged[signal]).toEqual(SESSIONLOG_CAPABILITIES[signal])
      }
      expect(deriveRung(merged)).toBe(deriveRung(SESSIONLOG_CAPABILITIES))
    })

    it('every signal in the static manifest says why it is at its level and what would raise it — nothing there is provided', () => {
      for (const detail of Object.values(BEACON_CAPABILITIES)) {
        expect(detail.level).not.toBe('provided')
        if (detail.level === 'provided') continue // narrows the union; unreachable after the assertion above
        expect(detail.reason.length).toBeGreaterThan(0)
        expect(detail.remedy).toBeDefined()
        expect(detail.remedy?.length).toBeGreaterThan(0)
      }
    })
  })

  describe('the live manifest — beaconCapabilitiesFor (prd-27 ruling 3, #218)', () => {
    const declared: DeclaredAttention = {
      kind: 'waiting',
      at: 1_000,
      joinedBy: 'lane',
      writer: 'claude-hook',
      digest: 'a'.repeat(64),
      file: 'claude-hook.jsonl',
      offset: 0,
    }

    it('is the static configured-but-silent manifest, unchanged, when no lane has been declared for', () => {
      expect(beaconCapabilitiesFor({})).toBe(BEACON_CAPABILITIES)
    })

    it('provides attention — signed beacon — once any lane has been declared for, and sits at L2', () => {
      const live = beaconCapabilitiesFor({ '2-core': declared })
      expect(live.attention).toEqual({ level: 'provided', witness: 'beacon' })
      expect(deriveRung(live)).toBe('L2')
    })

    it('raises no signal but attention — the organ still carries no tokens, dollars or heartbeat', () => {
      const live = beaconCapabilitiesFor({ '2-core': declared })
      for (const signal of ['identity', 'liveness', 'activity', 'telemetry', 'cost'] as const) {
        expect(live[signal]).toEqual(BEACON_CAPABILITIES[signal])
      }
    })

    it('yields the rig the tie: a fleet witnessed by both the hook and workmux reads L4, in either input order', () => {
      const live = beaconCapabilitiesFor({ '2-core': declared })
      expect(deriveRung(mergeCapabilities([live, WORKMUX_CAPABILITIES]))).toBe('L4')
      expect(deriveRung(mergeCapabilities([WORKMUX_CAPABILITIES, live]))).toBe('L4')
    })
  })

  /**
   * prd-27 ruling 6's amendment — *the mechanism is ruled, the number is
   * measured* — enforced from both sides. A `BEACON_LAPSE_MS ± 1` pair in
   * `packages/core/src/selectors/lapse.test.ts` passes at any interval; this
   * is the law that makes the interval itself falsifiable, by holding the
   * constant to the note that derived it. Changing either alone reddens here.
   *
   * It lives in `server` rather than beside the selector because `core` is
   * browser-safe (ADR-0003) and cannot read a file outside its own package
   * root. `REPO_ROOT` is derived the way `corpus-eol-law.test.ts` derives it.
   */
  describe('the lapse interval is measured, and the note is the source of truth (#218)', () => {
    const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const NOTE_PATH = path.join(REPO_ROOT, 'docs', 'design-notes', 'beacon-lapse-interval.md')
    // The note is prose under docs/, not a pinned fixture: a CRLF checkout (the windows-suite leg) must read the same bytes-as-text this law was written against.
    const NOTE = readFileSync(NOTE_PATH, 'utf8').replace(/\r\n/g, '\n')

    it('states the same number the code holds', () => {
      const match = /BEACON_LAPSE_MS = (\d+)/.exec(NOTE)
      expect(match, `no "BEACON_LAPSE_MS = <n>" line in ${NOTE_PATH}`).not.toBeNull()
      expect(Number(match![1])).toBe(BEACON_LAPSE_MS)
    })

    it('carries a measurement, not prose — a raw capture of real beacon lines the parser accepts', () => {
      expect(NOTE).toContain('## The measurement')
      const block = /```jsonl\n([\s\S]*?)```/.exec(NOTE)
      expect(block, 'no ```jsonl raw-capture block in the note').not.toBeNull()
      const lines = block![1]!.split('\n').filter((line) => line.length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(20)
      for (const line of lines) {
        expect(parseBeaconLine(line).kind, line).toBe('beacon')
      }
    })
  })
})

describe('two repos share one door and neither folds into the other (prd-57 ruling 6, ADR-0055)', () => {
  /**
   * The law ruling 6 names, written as it names it: plant two repos' lines in
   * ONE door and assert neither reaches the other's session.
   *
   * ADR-0036's guarantee is unchanged — a beacon from one repo's swarm must
   * never fold into another repo's session. What ADR-0055 moves is where it is
   * enforced: from the shape of the directory to a routing rule, because a
   * per-repo door requires the WRITER to know the slug derivation the READER
   * uses, and a hook fires for whatever repo the agent happens to be in.
   */
  let root: string
  let sharedDir: string
  let repoA: string
  let repoB: string

  const lineFor = (cwd: string, lane: string) =>
    `${JSON.stringify({ v: 1, at: 1788591365000, writer: 'claude-hook', kind: 'working', lane, cwd })}\n`

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-door-'))
    sharedDir = installationBeaconDir(root)
    // Real directories, because containment is decided by `isInside`, which
    // canonicalises — a fabricated path that does not exist would be refused
    // for the wrong reason and the test would pass while proving nothing.
    repoA = await mkdtemp(path.join(tmpdir(), 'beacon-repo-a-'))
    repoB = await mkdtemp(path.join(tmpdir(), 'beacon-repo-b-'))
    await mkdir(sharedDir, { recursive: true })
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(repoA, { recursive: true, force: true }),
      rm(repoB, { recursive: true, force: true }),
    ])
  })

  async function pollFor(repoPath: string) {
    const collector = createBeaconCollector({ dataRoot: root })
    return collector.poll(collector.initialSnapshot(), context(repoPath))
  }

  it('a server watching A sees A’s line and not B’s, from the same file', async () => {
    await writeFile(path.join(sharedDir, 'claude-hook.jsonl'), lineFor(repoA, 'lane-a') + lineFor(repoB, 'lane-b'))

    const { events } = await pollFor(repoA)
    const lanes = events.filter((e) => e.type === 'beacon.received').map((e) => (e.payload as { lane: string }).lane)
    expect(lanes).toEqual(['lane-a'])
  })

  it('and a server watching B sees B’s and not A’s — the same bytes, the other way', async () => {
    // The mirror, which is what makes the case above evidence rather than a
    // filter that happens to drop the second line.
    await writeFile(path.join(sharedDir, 'claude-hook.jsonl'), lineFor(repoA, 'lane-a') + lineFor(repoB, 'lane-b'))

    const { events } = await pollFor(repoB)
    const lanes = events.filter((e) => e.type === 'beacon.received').map((e) => (e.payload as { lane: string }).lane)
    expect(lanes).toEqual(['lane-b'])
  })

  it('a line from a repo NOBODY watches is retained, and attributed to none', async () => {
    // Ruling 6's own words. The cursor must still advance past it, or every
    // later tick re-reads it forever; and no event may be emitted for it,
    // because this instrument has nowhere to put it.
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'beacon-unwatched-'))
    try {
      const file = path.join(sharedDir, 'claude-hook.jsonl')
      await writeFile(file, lineFor(elsewhere, 'lane-nowhere'))

      const result = await pollFor(repoA)
      expect(result.events.filter((e) => e.type === 'beacon.received')).toEqual([])
      // Retained: the bytes are still on disk, and the cursor has moved past
      // them so the next tick does not re-read what it already declined.
      expect(await readFile(file, 'utf8')).toContain('lane-nowhere')
      expect(result.nextSnapshot.files[file]?.offset).toBeGreaterThan(0)
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('a line with NO cwd is not folded — the honest unknown, never a guess', async () => {
    // A writer that does not say where it came from cannot be attributed by
    // containment. Guessing would be exactly the fold this rule prevents.
    const bare = `${JSON.stringify({ v: 1, at: 1788591365000, writer: 'claude-hook', kind: 'working', lane: 'lane-x' })}\n`
    await writeFile(path.join(sharedDir, 'claude-hook.jsonl'), bare)

    const { events } = await pollFor(repoA)
    expect(events.filter((e) => e.type === 'beacon.received')).toEqual([])
  })

  it('a cwd in a SUBDIRECTORY of the watched repo belongs to it — containment, not equality', async () => {
    // An agent runs in a worktree or a subdirectory far more often than at the
    // repo root, so equality would drop almost every real line.
    const nested = path.join(repoA, 'packages', 'server')
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(sharedDir, 'claude-hook.jsonl'), lineFor(nested, 'lane-nested'))

    const { events } = await pollFor(repoA)
    const lanes = events.filter((e) => e.type === 'beacon.received').map((e) => (e.payload as { lane: string }).lane)
    expect(lanes).toEqual(['lane-nested'])
  })

  it('the PER-REPO door is not routed — its lines predate cwd and are scoped by the directory', async () => {
    // ADR-0036's structural scoping still holds for its own door. Routing those
    // lines would drop every beacon the existing hooks have ever written, which
    // is a regression wearing a rule's clothes.
    const perRepo = beaconDirFor(repoA, root)
    await mkdir(perRepo, { recursive: true })
    const bare = `${JSON.stringify({ v: 1, at: 1788591365000, writer: 'claude-hook', kind: 'working', lane: 'lane-legacy' })}\n`
    await writeFile(path.join(perRepo, 'claude-hook.jsonl'), bare)

    const { events } = await pollFor(repoA)
    const lanes = events.filter((e) => e.type === 'beacon.received').map((e) => (e.payload as { lane: string }).lane)
    expect(lanes).toEqual(['lane-legacy'])
  })

  it('both doors are read in one tick, and a same-named file in each keeps its own cursor', async () => {
    // The reason the snapshot is keyed by full path. A shared key would make
    // one file's cursor resume the other's — re-emitting or skipping bytes
    // depending on which door was longer.
    const perRepo = beaconDirFor(repoA, root)
    await mkdir(perRepo, { recursive: true })
    await writeFile(path.join(sharedDir, 'claude-hook.jsonl'), lineFor(repoA, 'lane-shared'))
    await writeFile(
      path.join(perRepo, 'claude-hook.jsonl'),
      `${JSON.stringify({ v: 1, at: 1788591365000, writer: 'claude-hook', kind: 'working', lane: 'lane-perrepo' })}\n`,
    )

    const result = await pollFor(repoA)
    const lanes = result.events
      .filter((e) => e.type === 'beacon.received')
      .map((e) => (e.payload as { lane: string }).lane)
      .sort()
    expect(lanes).toEqual(['lane-perrepo', 'lane-shared'])
    expect(Object.keys(result.nextSnapshot.files).sort()).toEqual(
      [path.join(sharedDir, 'claude-hook.jsonl'), path.join(perRepo, 'claude-hook.jsonl')].sort(),
    )
  })
})
