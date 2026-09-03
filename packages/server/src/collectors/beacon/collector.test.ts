import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AdapterCapabilities,
  type CollectorContext,
  createCollectorContext,
  deriveRung,
  type EventOf,
  mergeCapabilities,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withResilience } from '../resilience.js'
import { SESSIONLOG_CAPABILITIES } from '../sessionlog/collector.js'
import { BEACON_CAPABILITIES, createBeaconCollector } from './collector.js'
import { beaconDirFor } from './paths.js'

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'claude-hook.jsonl')
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8')
const [LINE1, LINE2, LINE3] = FIXTURE.split('\n') as [string, string, string]

function sha256(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex')
}

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

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'beacon-collector-'))
    dir = beaconDirFor('/repo', root)
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

  describe('one file, the fixture', () => {
    beforeEach(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'claude-hook.jsonl'), FIXTURE)
    })

    it('emits one beacon.received per line, in file order, with the writer clock as ts', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const beacons = ofType(result.events, 'beacon.received')
      expect(result.events).toHaveLength(3)
      expect(beacons.map((event) => event.ts)).toEqual([1_725_000_000_000, 1_725_000_001_000, 1_725_000_002_000])
    })

    it('the first event is exact: payload, digest of the raw line, file and offset 0', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      expect(result.events[0]).toEqual({
        id: 'beacon-1',
        ts: 1_725_000_000_000,
        source: 'beacon',
        type: 'beacon.received',
        payload: {
          writer: 'claude-hook',
          kind: 'waiting',
          lane: '2-core',
          detail: 'permission: Bash',
          digest: sha256(LINE1),
          file: 'claude-hook.jsonl',
          offset: 0,
        },
      })
    })

    it('the second event starts where the first line ended, and its digest covers the extra key', async () => {
      const collector = createBeaconCollector({ dataRoot: root })
      const result = await collector.poll(collector.initialSnapshot(), context())
      const [, second, third] = ofType(result.events, 'beacon.received')
      expect(second?.payload.offset).toBe(Buffer.byteLength(`${LINE1}\n`))
      expect(second?.payload.digest).toBe(sha256(LINE2))
      expect(second?.payload).not.toHaveProperty('extra')
      expect(third?.payload.offset).toBe(Buffer.byteLength(`${LINE1}\n${LINE2}\n`))
      expect(third?.payload.lane).toBeNull()
      expect(third?.payload).not.toHaveProperty('detail')
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
      const cursor = first.nextSnapshot.files['claude-hook.jsonl']
      expect(cursor?.offset).toBe(Buffer.byteLength(FIXTURE))
      expect(cursor?.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) })

      let snapshot = first.nextSnapshot
      for (let i = 0; i < 3; i += 1) {
        const result = await collector.poll(snapshot, context())
        expect(result.events).toEqual([])
        expect(result.nextSnapshot.files['claude-hook.jsonl']).toEqual(cursor)
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
      expect(second.nextSnapshot.files['claude-hook.jsonl']?.offset).toBe(Buffer.byteLength(FIXTURE) + Buffer.byteLength(appended) + 1)

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
      expect(second.nextSnapshot.files['claude-hook.jsonl']?.offset).toBe(Buffer.byteLength(FIXTURE))

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
      expect(Object.keys(result.nextSnapshot.files).sort()).toEqual(['claude-hook.jsonl', 'gate.jsonl'])
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

  describe('the manifest', () => {
    it('declares attention absent, with ruling 3 as the reason, so this wave promises no rung', () => {
      const attention = BEACON_CAPABILITIES.attention
      expect(attention.level).toBe('absent')
      expect(attention.level !== 'provided' && attention.reason).toContain('ruling 3')
      expect(deriveRung(BEACON_CAPABILITIES)).toBe('L0')
    })

    it('adding the beacon to a fleet changes no signal the transcript organ already has', () => {
      const merged = mergeCapabilities([SESSIONLOG_CAPABILITIES, BEACON_CAPABILITIES])
      for (const signal of Object.keys(SESSIONLOG_CAPABILITIES) as (keyof AdapterCapabilities)[]) {
        expect(merged[signal]).toEqual(SESSIONLOG_CAPABILITIES[signal])
      }
      expect(deriveRung(merged)).toBe(deriveRung(SESSIONLOG_CAPABILITIES))
    })

    it('every signal says why it is at its level and what would raise it — nothing here is provided', () => {
      for (const detail of Object.values(BEACON_CAPABILITIES)) {
        expect(detail.level).not.toBe('provided')
        if (detail.level === 'provided') continue // narrows the union; unreachable after the assertion above
        expect(detail.reason.length).toBeGreaterThan(0)
        expect(detail.remedy).toBeDefined()
        expect(detail.remedy?.length).toBeGreaterThan(0)
      }
    })
  })
})
