import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type CollectorContext, createCollectorContext, createEvent, type EventOf } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBeaconCollector } from '../collectors/beacon/collector.js'
import { beaconDirFor } from '../collectors/beacon/paths.js'
import { deriveGateVerdict, MAX_GATE_VERDICT_LINE_BYTES, type SidecarDescriptor } from './gate-verdict-derivation.js'

/**
 * Lets a single test force the *next* `read()` on the *next*-opened handle to
 * reject with a real I/O error (EIO, not a crafted input) — round 4's review
 * finding 1: `gate-verdict-derivation.ts`'s bounded read had no catch of its
 * own. Mirrors `recorder/session-log-writer.test.ts`'s identical pattern for
 * `appendFile`: mutate the REAL handle's one method in place rather than
 * build a facade, so every other method (and every other test in this file
 * that never arms this) sees the genuine `FileHandle` untouched.
 */
const readFault = vi.hoisted(() => ({ armed: false }))

/**
 * The same trick for `close()` — round 5's review finding 1. A rejection
 * raised in a `finally` REPLACES whatever the `try`/`catch` was returning, so
 * before the fix an EIO here escaped `deriveGateVerdict` as a rejected
 * promise past both of its catches, breaking the same no-throw contract round
 * 4 had just restored one line above.
 */
const closeFault = vi.hoisted(() => ({ armed: false }))

/**
 * Truncates the file to `toBytes` between the derivation's `stat()` and its
 * `read()` — round 5's review finding 2. `stat` runs before `open`, so
 * hooking the read is exactly the window: the size the derivation is holding
 * is already stale by the time the bytes come back. This is an ordinary race
 * against a file another process appends to, not a crafted input.
 */
const truncateBeforeRead = vi.hoisted(() => ({ armed: false, target: '', toBytes: 0 }))

/**
 * The same trick for `stat()` — the ONE pre-open refusal the descriptor sweep
 * below could not otherwise reach. `stat` rejecting with anything but ENOENT
 * lands on a generic "could not be read" arm that is byte-identical to
 * `open()`'s, and mutating its `UNOPENED` to `closed` left all 100 tests
 * green: no row could construct a non-ENOENT `stat` failure without one of
 * these. EIO rather than a crafted input, for the same reason the read and
 * close faults use it — a failing mount is the case that matters.
 */
const statFault = vi.hoisted(() => ({ armed: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (statFault.armed) {
        statFault.armed = false
        const error = new Error('EIO: i/o error, stat') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return actual.stat(...args)
    }) as typeof actual.stat,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const originalRead = handle.read.bind(handle)
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        if (readFault.armed) {
          readFault.armed = false
          const error = new Error('EIO: i/o error, read') as NodeJS.ErrnoException
          error.code = 'EIO'
          throw error
        }
        if (truncateBeforeRead.armed) {
          truncateBeforeRead.armed = false
          await actual.truncate(truncateBeforeRead.target, truncateBeforeRead.toBytes)
        }
        return originalRead(...readArgs)
      }) as typeof handle.read
      const originalClose = handle.close.bind(handle)
      handle.close = (async () => {
        if (closeFault.armed) {
          closeFault.armed = false
          // Close the descriptor for real first — the fault under test is a
          // rejecting `close()`, never a leaked fd in the test process.
          await originalClose()
          const error = new Error('EIO: i/o error, close') as NodeJS.ErrnoException
          error.code = 'EIO'
          throw error
        }
        return originalClose()
      }) as typeof handle.close
      return handle
    }) as typeof actual.open,
  }
})

/** A context whose `exec` throws — this derivation, like the beacon collector it reads behind, never shells out. */
function context(repoPath = '/repo', now = 2_000): CollectorContext {
  let next = 0
  return createCollectorContext({
    repoPath,
    now,
    exec: async () => {
      throw new Error('deriveGateVerdict must never exec')
    },
    nextId: () => `beacon-${(next += 1)}`,
  })
}

const OUTPUT_DIGEST = 'a'.repeat(64)

/** The exact shape `emit_gate_verdict` in `scripts/gate.sh` writes (verified against the tracked script, not assumed). */
function gateLine(fields: {
  at: number
  lane?: string
  held: boolean
  reason: string
  outputDigest?: string
  loadBatches?: number
}): string {
  const line: Record<string, unknown> = {
    v: 1,
    at: fields.at,
    writer: 'gate',
    kind: 'gate.verdict',
    held: fields.held,
    reason: fields.reason,
  }
  if (fields.lane !== undefined) line.lane = fields.lane
  if (fields.outputDigest !== undefined) line.outputDigest = fields.outputDigest
  if (fields.loadBatches !== undefined) line.loadBatches = fields.loadBatches
  return JSON.stringify(line)
}

describe('deriveGateVerdict (prd17 w6, #280)', () => {
  let root: string
  let dir: string
  /** Temp dirs a row creates outside `root` (the symlink-escape target) — cleaned alongside it. */
  let extraDirs: string[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gate-verdict-derivation-'))
    dir = beaconDirFor('/repo', root)
    await mkdir(dir, { recursive: true })
    extraDirs = []
    readFault.armed = false
    closeFault.armed = false
    truncateBeforeRead.armed = false
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    for (const extra of extraDirs) await rm(extra, { recursive: true, force: true })
    readFault.armed = false
    closeFault.armed = false
    truncateBeforeRead.armed = false
  })

  /**
   * Writes `lines` to `gate.jsonl` and polls the REAL beacon collector for
   * their `beacon.received` events — so `file`, `offset` and `digest` are
   * exactly what a live landing would produce, never hand-computed here in a
   * way that could drift from `collector.ts`'s own arithmetic.
   */
  async function beaconsFor(lines: string[]): Promise<EventOf<'beacon.received'>[]> {
    await writeFile(path.join(dir, 'gate.jsonl'), lines.map((line) => `${line}\n`).join(''))
    const collector = createBeaconCollector({ dataRoot: root })
    const result = await collector.poll(collector.initialSnapshot(), context())
    return result.events.filter((event): event is EventOf<'beacon.received'> => event.type === 'beacon.received')
  }

  /** One line in, one `beacon.received` out — asserted, not just hoped, before the cast below trusts it. */
  async function oneBeaconFor(line: string): Promise<EventOf<'beacon.received'>> {
    const beacons = await beaconsFor([line])
    if (beacons.length !== 1) throw new Error(`expected exactly one beacon.received, got ${beacons.length}`)
    return beacons[0] as EventOf<'beacon.received'>
  }

  it('derives a clean, unheld verdict — handle, held, reason, digest and loadBatches all recovered', async () => {
    const beacon = await oneBeaconFor(
      gateLine({ at: 100, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST, loadBatches: 3 }),
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-1' })
    expect(result).toEqual({
      outcome: 'derived',
      event: {
        id: 'evt-derived-1',
        ts: 100,
        source: 'gate',
        type: 'gate.verdict',
        payload: { handle: 'feature', held: false, reason: 'clean', digest: OUTPUT_DIGEST, loadBatches: 3 },
      },
      descriptor: { state: 'closed' },
    })
  })

  it('derives a HELD verdict — a fixture whose landings all succeeded could not catch a hard-coded held:false', async () => {
    const beacon = await oneBeaconFor(
      gateLine({ at: 200, lane: 'feature', held: true, reason: 'suite-red', outputDigest: OUTPUT_DIGEST }),
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-2' })
    expect(result.outcome).toBe('derived')
    if (result.outcome !== 'derived') throw new Error('unreachable')
    expect(result.event.payload.held).toBe(true)
    // `reason` distinguishes this landing from the clean one above — a
    // hard-coded `reason: 'clean'` would satisfy the other test's assertion
    // and pass here silently if this line were absent (review of #280,
    // round 2 — EXECUTED: reddens with `reason` hard-coded, 7/7 without it).
    expect(result.event.payload.reason).toBe('suite-red')
    expect(result.event.payload.loadBatches).toBeUndefined()
  })

  it('an ordinary attention beacon is not a gate verdict at all — not an error, just inapplicable', async () => {
    const beacon = await oneBeaconFor('{"v":1,"at":50,"writer":"claude-hook","kind":"waiting","lane":"feature"}')
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-3' })
    expect(result).toEqual({ outcome: 'not-a-gate-verdict-beacon' })
  })

  it('a forged writer cannot pass as a gate verdict just because kind says so — the writer half of the discriminator is load-bearing', async () => {
    // The one case `kind` alone cannot catch: a non-"gate" writer producing a
    // literal `kind: "gate.verdict"` line — the forged-verdict shape the
    // `writer` check exists for (review of #280, round 2 — EXECUTED: reddens
    // with the `writer` check removed, 7/7 with it left in place).
    const beacon = await oneBeaconFor('{"v":1,"at":75,"writer":"claude-hook","kind":"gate.verdict","lane":"feature"}')
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-3b' })
    expect(result).toEqual({ outcome: 'not-a-gate-verdict-beacon' })
  })

  it('a null lane refuses — no handle to attribute the verdict to', async () => {
    const beacon = await oneBeaconFor(gateLine({ at: 300, held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }))
    expect(beacon.payload.lane).toBeNull()
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-4' })
    expect(result.outcome).toBe('refused')
  })

  it("an omitted outputDigest (the gate's tee never drained) fails schema validation rather than emitting an empty digest", async () => {
    const beacon = await oneBeaconFor(gateLine({ at: 400, lane: 'feature', held: false, reason: 'clean' }))
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-5' })
    expect(result.outcome).toBe('refused')
  })

  it('MUTATION: a sidecar tampered with after the beacon.received event was recorded produces no verdict', async () => {
    const beacon = await oneBeaconFor(
      gateLine({ at: 500, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
    )

    // Prove it derives cleanly first, against the untouched file — a test
    // that only ever sees a tampered file would pass even if the digest
    // check were skipped entirely.
    const before = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-6' })
    expect(before.outcome).toBe('derived')

    // Tamper the exact bytes the recorded event points at, after the fact.
    const filePath = path.join(dir, 'gate.jsonl')
    const original = await readFile(filePath, 'utf8')
    const tampered = original.replace('"reason":"clean"', '"reason":"tamperd-after-recording"')
    expect(tampered).not.toBe(original)
    await writeFile(filePath, tampered)

    const after = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-derived-7' })
    expect(after).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('does not match its recorded digest'),
      descriptor: { state: 'closed' },
    })
  })

  it('missing, empty, offset-past-end and truncated sidecars all refuse the same way', async () => {
    const beacons = await beaconsFor([
      '{"v":1,"at":50,"writer":"claude-hook","kind":"waiting","lane":"feature"}',
      gateLine({ at: 600, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
    ])
    if (beacons.length !== 2) throw new Error(`expected exactly two beacon.received, got ${beacons.length}`)
    const beacon = beacons[1] as EventOf<'beacon.received'>
    expect(beacon.payload.offset).toBeGreaterThan(0)
    const filePath = path.join(dir, 'gate.jsonl')
    const full = await readFile(filePath, 'utf8')

    await rm(filePath)
    const absent = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-a' })
    expect(absent.outcome).toBe('refused')

    await writeFile(filePath, '')
    const empty = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-b' })
    expect(empty.outcome).toBe('refused')

    await writeFile(filePath, full.slice(0, beacon.payload.offset))
    const offsetPastEnd = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-c' })
    expect(offsetPastEnd.outcome).toBe('refused')

    await writeFile(filePath, full.slice(0, beacon.payload.offset + 5))
    const truncated = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-d' })
    expect(truncated.outcome).toBe('refused')
  })

  describe('the traversal guard is containment, not just a basename check (round 3 hardening)', () => {
    /** Hand-built so `file` can carry a value no real collector would ever write — a `beacon.received` this derivation must still refuse safely. */
    function beaconWithFile(file: string): EventOf<'beacon.received'> {
      return createEvent(
        'beacon.received',
        { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file, offset: 0 },
        { id: 'beacon-crafted', ts: 900 },
      )
    }

    it("'..' and '.' pass path.basename() unchanged, and must still be refused", async () => {
      // Verified directly, not assumed: path.basename('..') === '..' and
      // path.basename('.') === '.', so a check that only compares against
      // path.basename(file) does not reject either value.
      expect(path.basename('..')).toBe('..')
      expect(path.basename('.')).toBe('.')

      for (const file of ['..', '.']) {
        const result = await deriveGateVerdict(beaconWithFile(file), { repoPath: '/repo', dataRoot: root, id: 'evt-dotdot' })
        expect(result).toEqual({
          outcome: 'refused',
          reason: expect.stringContaining('names a sidecar path, not a file'),
          descriptor: { state: 'unopened' },
        })
      }
    })

    it('a symlink inside the beacon directory whose target lies outside it is refused by containment, not merely followed', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'gate-verdict-outside-'))
      const outsideFile = path.join(outsideDir, 'escaped.jsonl')
      const line = gateLine({ at: 800, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })
      await writeFile(outsideFile, `${line}\n`)
      await symlink(outsideFile, path.join(dir, 'escape-link.jsonl'))

      // A digest that WOULD match the escaped file's real content — proving
      // the refusal below is the containment check, not an incidental
      // digest mismatch that would mask it (round 2's own lesson: verify the
      // thing you claim is caught, not something upstream of it).
      const matchingDigest = createHash('sha256').update(line, 'utf8').digest('hex')
      const beacon = createEvent(
        'beacon.received',
        { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: matchingDigest, file: 'escape-link.jsonl', offset: 0 },
        { id: 'beacon-escape', ts: 800 },
      )

      const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-escape' })
      expect(result).toEqual({
        outcome: 'refused',
        reason: expect.stringContaining('resolves outside the beacon directory'),
        descriptor: { state: 'unopened' },
      })

      await rm(outsideDir, { recursive: true, force: true })
    })
  })

  it('derives correctly with a large amount of unrelated content before the offset — the bounded-read regression this guards against', async () => {
    // A 2MB single "line" with no newline and no valid JSON in it: if the
    // read ever materialised bytes before the offset into the buffer this
    // derivation scans, that garbage would either shift the newline search
    // or leak into `lineText`. Neither happens here because the read starts
    // AT the offset (`read(buffer, 0, length, offset)`), never at byte 0.
    const garbagePrefix = 'x'.repeat(2_000_000)
    const beacons = await beaconsFor([
      garbagePrefix,
      gateLine({ at: 950, lane: 'feature', held: true, reason: 'suite-red', outputDigest: OUTPUT_DIGEST }),
    ])
    const beacon = beacons.find((event) => event.payload.writer === 'gate')
    if (!beacon) throw new Error('expected a gate beacon.received among the results')
    expect(beacon.payload.offset).toBeGreaterThan(garbagePrefix.length / 2)

    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-bounded' })
    expect(result).toEqual({
      outcome: 'derived',
      event: {
        id: 'evt-bounded',
        ts: 950,
        source: 'gate',
        type: 'gate.verdict',
        payload: { handle: 'feature', held: true, reason: 'suite-red', digest: OUTPUT_DIGEST },
      },
      descriptor: { state: 'closed' },
    })
  })

  it("a line with no newline inside MAX_GATE_VERDICT_LINE_BYTES of the offset refuses — the read is a WINDOW, not offset-to-EOF", async () => {
    // Longer than the cap and never terminated: if the read still went to
    // EOF (round 3's shape), this would just read more and, since there is
    // still no newline anywhere in the file, refuse the same way truncation
    // does. The distinguishing behaviour is that THIS refusal fires at the
    // cap regardless of how much more unterminated data follows.
    const filler = 'x'.repeat(MAX_GATE_VERDICT_LINE_BYTES + 1000)
    await writeFile(path.join(dir, 'no-newline.jsonl'), filler)
    const beacon = createEvent(
      'beacon.received',
      { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'no-newline.jsonl', offset: 0 },
      { id: 'beacon-no-newline', ts: 1_000 },
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-no-newline' })
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining(`no newline within ${MAX_GATE_VERDICT_LINE_BYTES} bytes`),
      descriptor: { state: 'closed' },
    })
  })

  it('an unresolvable path (a symlink loop) refuses rather than throwing ELOOP', async () => {
    // The exact self-referential-through-a-missing-directory shape
    // paths/containment.test.ts uses to prove `canonicalize` bounds its own
    // chase: `realpath` stats the missing directory, fails ENOENT, and never
    // gets far enough to detect an ordinary symlink loop — so the chase has
    // to bound itself, and this derivation has to survive that throw.
    const link = path.join(dir, 'loop.jsonl')
    await symlink(path.join('.', 'missing', '..', 'loop.jsonl'), link)
    const beacon = createEvent(
      'beacon.received',
      { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'loop.jsonl', offset: 0 },
      { id: 'beacon-loop', ts: 1_100 },
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-loop' })
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('could not be resolved'),
      descriptor: { state: 'unopened' },
    })
  })

  it('a directory sitting where the sidecar should be refuses (isFile(), not merely a size check)', async () => {
    // A FIFO would stat 0 bytes and refuse at `size <= offset` regardless —
    // the deceptive case, per round 4's review, is the one that stats a
    // nonzero, plausible size but is not a regular file at all: `handle.read`
    // on a directory raises EISDIR, not a graceful refusal, without this
    // check. Proven by mutation below, not just this green case.
    await mkdir(path.join(dir, 'a-directory.jsonl'))
    const beacon = createEvent(
      'beacon.received',
      { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'a-directory.jsonl', offset: 0 },
      { id: 'beacon-dir', ts: 1_200 },
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-dir' })
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('is not a regular file'),
      descriptor: { state: 'unopened' },
    })
  })

  it('an I/O error mid-read (EIO, a real disk fault, not a crafted input) refuses instead of throwing', async () => {
    // Everything about this beacon and sidecar is genuinely valid — the ONLY
    // difference from a clean derivation is the injected read fault, so a
    // pass here proves the catch this round adds, not some other refusal
    // arrived at by accident.
    const beacon = await oneBeaconFor(
      gateLine({ at: 1_300, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
    )
    readFault.armed = true
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-eio' })
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('could not be read'),
      descriptor: { state: 'closed' },
    })
  })

  it('an I/O error on close does not escape — and does not discard a verdict the digest already proved', async () => {
    // Round 5's review finding 1, the sibling of the round-4 fault above:
    // `close()` sits in the read's `finally`, and a rejection raised there
    // REPLACES the value the try/catch was returning — so this rejected out
    // of `deriveGateVerdict` past both catches, into `poll-loop.ts`'s
    // unguarded per-event seam.
    //
    // Everything here is a genuinely valid derivation; the injected close
    // fault is the only difference. Two assertions, and the second is the one
    // that says which fix was chosen: the verdict is still DERIVED. By close()
    // time the bytes are already in the buffer — the close is in the read's
    // `finally`, BEFORE the digest comparison further down, not after it — so
    // the fault cannot cost us the data, and the digest then runs on those
    // bytes regardless. A close fault therefore never gates verification, and
    // refusing over it would discard a verdict the digest is about to prove.
    const beacon = await oneBeaconFor(
      gateLine({ at: 1_350, lane: 'feature', held: true, reason: 'suite-red', outputDigest: OUTPUT_DIGEST }),
    )
    closeFault.armed = true
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-close-eio' })
    expect(result.outcome).toBe('derived')
    if (result.outcome !== 'derived') throw new Error('unreachable')
    expect(result.event.payload).toEqual({
      handle: 'feature',
      held: true,
      reason: 'suite-red',
      digest: OUTPUT_DIGEST,
    })
    // #391: it no longer escapes AND is no longer silent. The catch used to
    // be empty, so a persistently failing mount left no trace anywhere while
    // this fired for every beacon on every tick.
    expect(result.descriptor).toEqual({ state: 'close-failed', message: expect.stringContaining('EIO') })
  })

  it('a clean derivation carries NO closeFault — the control without which the trace proves nothing', async () => {
    // #391's own named mutation is a reporter that fires unconditionally: it
    // satisfies "the fault is reported" at every input, including this one.
    // This is the assertion that fails for such a reporter, and it is why the
    // test above cannot stand alone. Identical to it but for the arming.
    const beacon = await oneBeaconFor(
      gateLine({ at: 1_360, lane: 'feature', held: true, reason: 'suite-red', outputDigest: OUTPUT_DIGEST }),
    )
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-close-clean' })
    expect(result.outcome).toBe('derived')
    if (result.outcome !== 'derived') throw new Error('unreachable')
    // `closed` — positively, not merely "no fault". That distinction is the
    // whole of #391's second review round: the old shape could not tell this
    // apart from a refusal that never opened the file.
    expect(result.descriptor).toEqual({ state: 'closed' })
  })

  it('a REFUSAL carries the close fault too — two things wrong at once must not lose one of them', async () => {
    // The sibling case #391 names: a sidecar can be unverifiable AND fail to
    // close. Carrying the signal only on the derived outcome would drop it in
    // exactly the case where the operator most needs both facts.
    const line = gateLine({ at: 1_370, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })
    const beacon = await oneBeaconFor(line)
    // Same byte length, different content — so the offset still lands and the
    // digest is what refuses, rather than a truncation.
    await writeFile(path.join(dir, 'gate.jsonl'), `${line.replace('"reason":"clean"', '"reason":"cIean"')}\n`)
    closeFault.armed = true
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-close-and-tamper' })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') throw new Error('unreachable')
    expect(result.reason).toMatch(/does not match its recorded digest/)
    expect(result.descriptor).toEqual({ state: 'close-failed', message: expect.stringContaining('EIO') })
  })

  it('a read fault AND a close fault together keep BOTH — the finding two independent seats found', async () => {
    // #391's second review round, and the reason the whole shape changed.
    // The old code returned from inside the read's `catch`, which is
    // evaluated BEFORE `finally` runs, so the close fault was captured into a
    // local and thrown away. At the seam that absence read as a clean close
    // and UN-LATCHED a fault that was still happening — the exact zero-trace
    // scenario this issue exists to end, reintroduced by the fix for it.
    const beacon = await oneBeaconFor(
      gateLine({ at: 1_380, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
    )
    readFault.armed = true
    closeFault.armed = true
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-read-and-close' })
    // Both harness faults self-disarm on fire, so this is the control: it
    // proves each fault ACTUALLY fired rather than the test passing because
    // neither did.
    expect(readFault.armed).toBe(false)
    expect(closeFault.armed).toBe(false)
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') throw new Error('unreachable')
    expect(result.reason).toMatch(/could not be read/)
    expect(result.descriptor).toEqual({ state: 'close-failed', message: expect.stringContaining('EIO') })
  })

  it("open() failing is UNOPENED too — the arm a review found reachable but unpinned", async (ctx) => {
    // Found by the fix re-review: mutating this one arm's UNOPENED to
    // `closed` left all 99 tests green, and the consequence is not cosmetic.
    // A failing mount produces close faults AND open faults on the SAME
    // sidecar, so a `closed` here would let one EACCES derivation clear a
    // latched fault at the seam — reopening the un-latching defect through a
    // different door.
    //
    // **An earlier version of this comment claimed "the other eight pre-open
    // refusals carry descriptor assertions; this one did not". That was not
    // true, and a review found it by mutating all nine rather than reading
    // them.** Six of the other eight were pinned; three were not — `is
    // missing`, the generic `stat` fault, and `does not reach the recorded
    // offset` all stayed green with their `UNOPENED` mutated to `closed`.
    // The refusal table below now declares a `descriptor` per row, which is
    // what closes the remaining three and any row added later; this test
    // stays because `open()`'s arm needs a real EACCES the table cannot set
    // up. Counting a claim is not checking it.
    //
    // EACCES rather than an injected fault: the file genuinely exists and
    // reaches the offset, so `stat` succeeds and only `open` fails — which is
    // the one shape that exercises this arm rather than an earlier one.
    //
    // **The precondition is PROVEN, not inferred** — and the two wrong
    // versions of this guard are worth keeping written down, because they are
    // the same error one level apart.
    //
    // The first hatch asserted `closed` and returned when the derivation
    // succeeded anyway, so under any filesystem that ignores the mode the
    // test passed WITHOUT reaching the `open()` catch it exists to pin — a
    // green tick proving nothing. The second guard skipped on
    // `process.getuid?.() === 0`, which reads as careful and is wrong twice:
    // `process.getuid` is UNDEFINED on Windows, so the optional call yields
    // `undefined`, never 0, and the guard never fires — while Windows also
    // ignores the mode for the owner. That is exactly how this reached CI red
    // (`windows-suite`, `expected 'derived' to be 'refused'`).
    //
    // Whether a chmod can deny a read is a property of the FILESYSTEM, not of
    // a platform name or a uid, so this asks the filesystem: attempt the read
    // and skip only when the denial could not be constructed. Root, Windows,
    // an ACL, an exotic mount — all answered by one question, and none of
    // them can produce a passing assertion.
    const beacon = await oneBeaconFor(
      gateLine({ at: 1_400, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
    )
    const file = path.join(dir, 'gate.jsonl')
    await chmod(file, 0o000)
    try {
      let denied = false
      try {
        await readFile(file)
      } catch {
        denied = true
      }
      if (!denied) {
        ctx.skip(`chmod cannot deny a read here (${process.platform}), so open() cannot be made to fail`)
        return
      }
      const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-eacces' })
      // No hatch below this line: the denial is proven, so open() MUST fail
      // and this MUST refuse. A derived outcome here is a real defect, not an
      // environment to accommodate.
      expect(result.outcome).toBe('refused')
      if (result.outcome !== 'refused') throw new Error('unreachable')
      expect(result.reason).toMatch(/could not be read/)
      expect(result.descriptor).toEqual({ state: 'unopened' })
    } finally {
      await chmod(file, 0o644)
    }
  })

  it('a refusal that never opened the file says UNOPENED, not closed', async () => {
    // The other face of the same root: nine refusals precede `open()`, and
    // under the old optional-string shape all nine were indistinguishable
    // from a clean close. `unopened` is a state, not an absence.
    const beacon = await oneBeaconFor(gateLine({ at: 1_390, held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }))
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-unopened' })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') throw new Error('unreachable')
    expect(result.reason).toMatch(/no lane/)
    expect(result.descriptor).toEqual({ state: 'unopened' })
  })

  it('a sidecar truncated between the stat and the read says TRUNCATED, not "over the bound"', async () => {
    // Round 5's review finding 2. The classification used to read the stale
    // `stat` size, so a file that was long-and-unterminated when measured and
    // three bytes by the time it was read reported "the line exceeds the
    // bound this derivation reads" — pointing the reader at a too-long line
    // that does not exist, instead of at the truncation that does.
    //
    // The setup has to make the ORIGINAL file exceed the cap, because that is
    // the only shape in which the two branches disagree: under the cap, the
    // stale size and the real one both land on "truncated" anyway.
    const line = gateLine({ at: 1_400, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })
    const beacon = await oneBeaconFor(line)
    const file = path.join(dir, 'gate.jsonl')
    // Unterminated and longer than the window, measured from the offset.
    await writeFile(file, `${'x'.repeat(beacon.payload.offset + MAX_GATE_VERDICT_LINE_BYTES + 1)}`)
    truncateBeforeRead.armed = true
    truncateBeforeRead.target = file
    truncateBeforeRead.toBytes = beacon.payload.offset + 3
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-race' })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') throw new Error('unreachable')
    expect(result.reason).toMatch(/is truncated — no line terminates at offset \d+$/)
    // Said as a negative too: the wrong answer is a specific wrong answer,
    // and this is the assertion that fails if the stale size comes back.
    expect(result.reason).not.toMatch(/exceeds the bound/)
  })

  /**
   * THE REFUSAL CONTRACT, table-driven (review of #280, round 4, finding 5).
   * Round 2 found one unpinned field (`reason`); round 4's re-review found
   * the same shape twice more independently (`if (false && lane === null)`
   * and `size <` both left 71/71 green) — three defeats on the same axis is
   * a reason to pin the CONTRACT once, not to add a fourth targeted
   * assertion. Every documented refusal path gets a row here: the outcome
   * must be exactly what the row declares, and — since every row is awaited
   * directly rather than wrapped in a try/catch — a row whose guard is
   * deleted and starts throwing fails this test by construction, not by
   * someone having separately written that mutation.
   *
   * **Round 5's review found that this table did not do the job this
   * docblock claims for it, and `RefusalCase.reason` carries the finding in
   * full.** The short version: asserting `outcome` plus a non-empty `reason`
   * cannot fail for the reason a row NAMES, so a guard whose removal shifts
   * the refusal to a later stage left every row green — the fourth defeat on
   * the very axis this table was built to close, and by the same mechanism
   * (an assertion weaker than the claim above it). Each row now declares the
   * reason it expects and the runner matches it.
   */
  interface RefusalCase {
    name: string
    expected: 'not-a-gate-verdict-beacon' | 'refused'
    /**
     * The reason this row's own guard must produce — `null` only for the one
     * row that is not a refusal at all.
     *
     * **Round 5's review is why this field exists, and the finding is worth
     * keeping written down: the table as round 4 shipped it asserted
     * `outcome` plus `reason.length > 0`, which cannot fail for the reason a
     * row NAMES.** Three mutations were executed against it and all thirteen
     * rows stayed green through every one — disabling the `lane === null`
     * guard (its row still refused, one stage later, at schema validation,
     * because `handle` was then null), weakening `size <= offset` to `size <`
     * (its row's numbers never exercised the equality), and routing every
     * newline-free read through the cap branch (ordinary truncation still
     * refused, just with the wrong cause). A table that pins only "it
     * refused and said something" is the exact shape this repo's own runbook
     * names as its second-worst defect: a test that cannot fail for the
     * reason it claims. Matching the reason is what turns each row from
     * "some guard fired" into "THIS guard fired".
     */
    reason: RegExp | null
    /**
     * The descriptor this row's refusal must carry — `null` only for the one
     * row that is not a refusal at all.
     *
     * **The reason-matching fix above closed one axis and left its sibling
     * open, which a review found by mutation (2026-09-10).** Every pre-open
     * arm returns the same `UNOPENED` constant, and three of the nine were
     * pinned by no test at all: `is missing`, the generic `stat` fault, and
     * `does not reach the recorded offset` each stayed green with `UNOPENED`
     * rewritten to `{ state: 'closed' }`. That is not cosmetic — a refusal
     * claiming a clean close is precisely what makes `poll-loop.ts`'s latch
     * clear a fault that is still happening, which is #391's own second
     * review finding arriving through a third door.
     *
     * Declared per row rather than derived, for the same reason `reason` is:
     * a row that says `unopened` because the runner computed `unopened` pins
     * nothing.
     */
    descriptor: SidecarDescriptor | null
    setup: () => Promise<EventOf<'beacon.received'>>
  }

  const REFUSAL_CASES: RefusalCase[] = [
    {
      name: 'writer/kind is not gate/gate.verdict (an ordinary attention beacon)',
      expected: 'not-a-gate-verdict-beacon',
      reason: null,
      descriptor: null,
      setup: () => oneBeaconFor('{"v":1,"at":10,"writer":"claude-hook","kind":"waiting","lane":"feature"}'),
    },
    {
      name: 'lane is null',
      expected: 'refused',
      reason: /^beacon has no lane — no handle to attribute the verdict to$/,
      descriptor: { state: 'unopened' },
      setup: () => oneBeaconFor(gateLine({ at: 20, held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })),
    },
    {
      name: 'outputDigest omitted (schema-invalid payload)',
      expected: 'refused',
      reason: /does not carry a well-formed verdict — .*\bdigest\b/,
      descriptor: { state: 'closed' },
      setup: () => oneBeaconFor(gateLine({ at: 30, lane: 'feature', held: false, reason: 'clean' })),
    },
    {
      name: 'held is not a boolean (schema-invalid payload, a different field than the row above)',
      expected: 'refused',
      reason: /does not carry a well-formed verdict — .*\bheld\b/,
      descriptor: { state: 'closed' },
      setup: () =>
        oneBeaconFor(
          JSON.stringify({
            v: 1,
            at: 35,
            writer: 'gate',
            kind: 'gate.verdict',
            lane: 'feature',
            held: 'yes',
            reason: 'clean',
            outputDigest: OUTPUT_DIGEST,
          }),
        ),
    },
    {
      name: 'the file names an unresolvable path (a symlink loop)',
      expected: 'refused',
      reason: /could not be resolved:/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        const link = path.join(dir, 'table-loop.jsonl')
        await symlink(path.join('.', 'missing', '..', 'table-loop.jsonl'), link)
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'table-loop.jsonl', offset: 0 },
          { id: 'beacon-table-loop', ts: 40 },
        )
      },
    },
    {
      name: 'the resolved file lies outside the beacon directory (a symlink escape)',
      expected: 'refused',
      reason: /resolves outside the beacon directory$/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        const outsideDir = await mkdtemp(path.join(tmpdir(), 'gate-verdict-outside-'))
        extraDirs.push(outsideDir)
        const outsideFile = path.join(outsideDir, 'escaped.jsonl')
        const line = gateLine({ at: 45, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })
        await writeFile(outsideFile, `${line}\n`)
        await symlink(outsideFile, path.join(dir, 'table-escape.jsonl'))
        const digest = createHash('sha256').update(line, 'utf8').digest('hex')
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest, file: 'table-escape.jsonl', offset: 0 },
          { id: 'beacon-table-escape', ts: 45 },
        )
      },
    },
    {
      name: 'the sidecar is not a regular file (a directory sits where it should be)',
      expected: 'refused',
      reason: /is not a regular file$/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        await mkdir(path.join(dir, 'table-dir.jsonl'))
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'table-dir.jsonl', offset: 0 },
          { id: 'beacon-table-dir', ts: 50 },
        )
      },
    },
    {
      name: 'the sidecar is missing',
      expected: 'refused',
      reason: /is missing$/,
      descriptor: { state: 'unopened' },
      setup: async () =>
        createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'table-missing.jsonl', offset: 0 },
          { id: 'beacon-table-missing', ts: 55 },
        ),
    },
    {
      name: 'the sidecar size does not reach the recorded offset',
      expected: 'refused',
      reason: /does not reach the recorded offset \d+$/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        await writeFile(path.join(dir, 'table-short.jsonl'), 'x')
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'table-short.jsonl', offset: 5 },
          { id: 'beacon-table-short', ts: 60 },
        )
      },
    },
    {
      /**
       * The BOUNDARY the row above does not reach, and the last of round 5's
       * three mutations to survive the reason-matching fix on its own:
       * weakening `size <= offset` to `size <` left every row green, because
       * a 1-byte file at offset 5 is refused by either spelling. Only
       * `size === offset` tells them apart — the ordinary shape of a beacon
       * pointing exactly at end-of-file, which is what an offset recorded
       * for a line that was never actually appended looks like.
       */
      name: 'the sidecar size is EXACTLY the recorded offset (the boundary <= exists for, and < does not)',
      expected: 'refused',
      reason: /does not reach the recorded offset \d+$/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        await writeFile(path.join(dir, 'table-at-offset.jsonl'), 'xxxxx')
        return createEvent(
          'beacon.received',
          {
            writer: 'gate',
            kind: 'gate.verdict',
            lane: 'feature',
            digest: OUTPUT_DIGEST,
            file: 'table-at-offset.jsonl',
            offset: 5,
          },
          { id: 'beacon-table-at-offset', ts: 65 },
        )
      },
    },
    {
      name: 'no newline within the read window',
      expected: 'refused',
      reason: /has no newline within \d+ bytes of offset \d+ — the line exceeds the bound this derivation reads$/,
      descriptor: { state: 'closed' },
      setup: async () => {
        await writeFile(path.join(dir, 'table-no-newline.jsonl'), 'x'.repeat(MAX_GATE_VERDICT_LINE_BYTES + 100))
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: OUTPUT_DIGEST, file: 'table-no-newline.jsonl', offset: 0 },
          { id: 'beacon-table-no-newline', ts: 65 },
        )
      },
    },
    {
      name: 'the line no longer matches its recorded digest (tampered)',
      expected: 'refused',
      reason: /does not match its recorded digest — altered since it was recorded$/,
      descriptor: { state: 'closed' },
      setup: async () => {
        const line = gateLine({ at: 70, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST })
        await writeFile(path.join(dir, 'table-digest.jsonl'), `${line}\n`)
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest: 'f'.repeat(64), file: 'table-digest.jsonl', offset: 0 },
          { id: 'beacon-table-digest', ts: 70 },
        )
      },
    },
    {
      name: 'the digest matches but the bytes are not JSON at all',
      expected: 'refused',
      reason: /is not valid JSON despite matching its digest$/,
      descriptor: { state: 'closed' },
      setup: async () => {
        const text = 'not-json-at-all-despite-matching-its-digest'
        await writeFile(path.join(dir, 'table-notjson.jsonl'), `${text}\n`)
        const digest = createHash('sha256').update(text, 'utf8').digest('hex')
        return createEvent(
          'beacon.received',
          { writer: 'gate', kind: 'gate.verdict', lane: 'feature', digest, file: 'table-notjson.jsonl', offset: 0 },
          { id: 'beacon-table-notjson', ts: 75 },
        )
      },
    },
    {
      /**
       * The ninth pre-open arm, and the one this table had no row for at all
       * — found by mutating all nine rather than reading them. A non-ENOENT
       * `stat` failure lands on a generic "could not be read" message that is
       * BYTE-IDENTICAL to `open()`'s, one screen apart, so the two are
       * distinguishable only by the descriptor: this one refuses before any
       * `open()` and must say `unopened`.
       */
      name: 'an I/O error stat-ing the sidecar — the pre-open twin of the read fault below, told apart only by its descriptor',
      expected: 'refused',
      reason: /could not be read:/,
      descriptor: { state: 'unopened' },
      setup: async () => {
        // Armed AFTER the collector round-trip, for the reason the read-fault
        // row states: `beaconsFor` stats and reads through this same mock.
        const beacon = await oneBeaconFor(
          gateLine({ at: 85, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
        )
        statFault.armed = true
        return beacon
      },
    },
    {
      name: 'an I/O error reading the sidecar (a real fault, not a crafted input)',
      expected: 'refused',
      reason: /could not be read:/,
      descriptor: { state: 'closed' },
      setup: async () => {
        // Arm AFTER the real collector round-trip, never before: `beaconsFor`
        // reads through the identical `open`/`read` mock (`read-beacon-
        // lines.ts` uses the same module), so arming first would fault the
        // COLLECTOR's own read instead of this derivation's.
        const beacon = await oneBeaconFor(
          gateLine({ at: 80, lane: 'feature', held: false, reason: 'clean', outputDigest: OUTPUT_DIGEST }),
        )
        readFault.armed = true
        return beacon
      },
    },
  ]

  it.each(REFUSAL_CASES)('refuses: $name', async ({ expected, reason, descriptor, setup }) => {
    const beacon = await setup()
    const result = await deriveGateVerdict(beacon, { repoPath: '/repo', dataRoot: root, id: 'evt-table' })
    expect(result.outcome).toBe(expected)
    if (result.outcome === 'refused') {
      // The whole point of round 5's fix: match the reason this row NAMES, so
      // a guard whose removal merely shifts the refusal to a later stage
      // fails here instead of passing. `expected` alone could not tell those
      // apart — see `RefusalCase.reason` for the three mutations that proved
      // it.
      expect(reason, 'a refusing row must declare which reason it expects').not.toBeNull()
      expect(result.reason).toMatch(reason as RegExp)
      // The sibling axis. `reason` says WHICH guard fired; `descriptor` says
      // what the row left the file descriptor in, and the seam's latch reads
      // only the second. A row that pins one and not the other is half a
      // contract.
      expect(descriptor, 'a refusing row must declare its descriptor').not.toBeNull()
      expect(result.descriptor).toEqual(descriptor)
    } else {
      expect(reason, 'a non-refusing row has no reason to declare').toBeNull()
      expect(descriptor, 'a non-refusing row never opened anything').toBeNull()
    }
  })
})
