import { parseIngestAccepted, parseIngestRequest } from '@rhizomorph/core/src/wire/index.js'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Journal, openJournal } from '../journal/journal.js'
import { readJournal } from '../journal/read.js'
import type { IngestFaults } from './faults.js'
import { INGEST_KEY_HEADER, handleIngest } from './handle.js'

/**
 * ORDERING 1's FAULT-POINT HARNESS (prd-51 ruling 4, F0–F5).
 *
 * ### The single strongest assertion is the tape
 *
 * Every step calls `trace`, and the happy path asserts the whole sequence with
 * an exact-array `toEqual`. That fails under **any** reordering, including the
 * one the ruling names — notify-and-respond before the journal — which is the
 * mutation whose executed form loses exactly one batch per process death.
 *
 * ### Why F0 exists
 *
 * F0 is the control, and it is what stops every F-test below passing for the
 * wrong reason. F1–F5 all assert *no 202*; F0 proves the same inputs DO produce
 * a 202 when no fault is injected. Without it, a `handleIngest` that returned
 * 500 unconditionally would pass all five.
 *
 * Nothing here mocks a syscall. The journal is a real file in a real temp
 * directory; only the *timing* of a process death is injected (`faults.ts`).
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-ingest-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const KEY = 'rzk_whatever'

function body(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: 1,
    project: 'acme-widgets',
    actorInstance: 'lane-7',
    batch: [
      { n: 1, line: '{"id":"e1","ts":1,"source":"otel","type":"llm.cost","payload":{}}' },
      { n: 2, line: '{"id":"e2","ts":2,"source":"otel","type":"llm.cost","payload":{}}' },
    ],
    ...overrides,
  }
}

interface Harness {
  readonly journal: Journal
  readonly journalPath: string
  readonly tape: string[]
  readonly notified: number[]
  readonly deps: Parameters<typeof handleIngest>[0]
}

function harness(faults?: IngestFaults): Harness {
  const journalPath = path.join(dir, 'ingest.journal')
  const tape: string[] = []
  const notified: number[] = []
  const opened = openJournal({ path: journalPath, hooks: faults, trace: (step) => tape.push(step) })
  if (!opened.ok) throw new Error(opened.error)
  return {
    journal: opened.journal,
    journalPath,
    tape,
    notified,
    deps: {
      journal: opened.journal,
      notify: (seq: number) => notified.push(seq),
      faults,
      trace: (step: string) => tape.push(step),
      now: () => 1785739192632,
    },
  }
}

function records(journalPath: string): number {
  const read = readJournal(journalPath)
  return read.ok ? read.records.length : -1
}

function sizeOf(journalPath: string): number {
  try {
    return statSync(journalPath).size
  } catch {
    return -1
  }
}

const dies = (): never => {
  throw new Error('process died')
}

describe('F0 — the control: no fault, and the whole ordering as one array', () => {
  it('journals, fsyncs, notifies, THEN responds 202 — in that order and no other', () => {
    const h = harness()
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()

    expect(h.tape).toEqual(['validate', 'journal.write', 'journal.fsync', 'notify', 'respond:202'])
    expect(response.status).toBe(202)
    const parsed = parseIngestAccepted(response.body)
    expect(parsed.ok && parsed.response).toEqual({ accepted: 2, journalSeq: 1 })
    expect(records(h.journalPath)).toBe(1)
    expect(h.notified).toEqual([1])
  })

  it('the journal holds exactly the batch that was accepted', () => {
    const h = harness()
    handleIngest(h.deps, body(), KEY)
    h.journal.close()
    const read = readJournal(h.journalPath)
    expect(read.ok && read.records[0]?.entry.project).toBe('acme-widgets')
    expect(read.ok && read.records[0]?.entry.actorInstance).toBe('lane-7')
    expect(read.ok && read.records[0]?.entry.batch.map((e) => e.n)).toEqual([1, 2])
    expect(read.ok && read.records[0]?.entry.receivedAtMs).toBe(1785739192632)
  })

  it('a second batch is a second record and a second seq', () => {
    const h = harness()
    handleIngest(h.deps, body(), KEY)
    const second = handleIngest(h.deps, body({ batch: [{ n: 3, line: '{"a":1}' }] }), KEY)
    h.journal.close()
    expect(second.body).toEqual({ accepted: 1, journalSeq: 2 })
    expect(h.notified).toEqual([1, 2])
  })
})

describe('F1 — a 4xx never touches the journal', () => {
  it.each([
    ['a body that is not an object', 42],
    ['a batch repeating n', body({ batch: [{ n: 1, line: 'a' }, { n: 1, line: 'b' }] })],
    ['protocolVersion 2', body({ protocolVersion: 2 })],
    ['no protocolVersion at all', body({ protocolVersion: undefined })],
  ])('%s is 400 with parseIngestRequest own message, and writes nothing', (_name, value) => {
    const h = harness()
    const before = sizeOf(h.journalPath)

    const response = handleIngest(h.deps, value, KEY)
    h.journal.close()

    expect(response.status).toBe(400)
    // Byte-identical to core's own refusal. A second envelope schema written
    // here would be visible as a changed string rather than as a silent fork.
    const expected = parseIngestRequest(value)
    expect(expected.ok).toBe(false)
    expect(response.body).toEqual({ error: expected.ok ? '' : expected.error })
    expect(sizeOf(h.journalPath)).toBe(before)
    expect(records(h.journalPath)).toBe(0)
    expect(h.notified).toEqual([])
    expect(h.tape).toEqual(['validate'])
  })

  it('a missing or empty ingest key is 401, naming the header — and the value is NOT verified', () => {
    for (const key of [undefined, '', '   ']) {
      const h = harness()
      const response = handleIngest(h.deps, body(), key)
      h.journal.close()
      expect(response.status).toBe(401)
      expect(JSON.stringify(response.body)).toContain(INGEST_KEY_HEADER)
      expect(records(h.journalPath)).toBe(0)
      rmSync(h.journalPath, { force: true })
    }

    // The gap, asserted so it is loud rather than latent: ANY non-empty key is
    // accepted today. Key issuance and membership are prd-51 wave 4's.
    const h = harness()
    expect(handleIngest(h.deps, body(), 'not-a-real-key-at-all').status).toBe(202)
    h.journal.close()
  })
})

describe('F2–F5 — a fault after validation, at each point of the ordering', () => {
  /** F2: before a single byte is written. */
  it('F2 — a death BEFORE the write sends no 202, notifies nobody, and journals nothing', () => {
    const h = harness({ beforeWrite: dies })
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()

    expect(response.status).toBe(500)
    expect(response.status).not.toBe(202)
    expect(h.notified).toEqual([])
    expect(records(h.journalPath)).toBe(0)
    expect(h.tape).toEqual(['validate'])
  })

  /** F3: the point the measured mutation loses a batch at. */
  it('F3 — a death BETWEEN the write and the fsync sends no 202 and notifies nobody', () => {
    const h = harness({ afterWriteBeforeFsync: dies })
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()

    expect(response.status).toBe(500)
    expect(parseIngestAccepted(response.body).ok).toBe(false)
    expect(h.notified).toEqual([])
    // The fsync never ran, so the tape stops at the write. Under the reversed
    // ordering the 202 and the notify would already be on this tape.
    expect(h.tape).toEqual(['validate', 'journal.write'])
    // Whatever reached the page cache is by construction NOT acked: no 202 ever
    // carried this seq, so a shipper retries it and the fold dedups it.
    expect(records(h.journalPath)).toBeLessThanOrEqual(1)
  })

  /**
   * F4, and the asymmetry with F3 is the point: the same shape of death one
   * step later leaves the record durable. That is what locates durability at
   * the fsync rather than at the response.
   */
  it('F4 — a death AFTER the fsync still sends no 202, but the record IS durable', () => {
    const h = harness({ afterFsync: dies })
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()

    expect(response.status).toBe(500)
    expect(h.notified).toEqual([])
    expect(h.tape).toEqual(['validate', 'journal.write', 'journal.fsync'])
    const read = readJournal(h.journalPath)
    expect(read.ok && read.verdict).toBe('clean')
    expect(read.ok && read.records.map((r) => r.seq)).toEqual([1])
  })

  /**
   * F5 is past the durable point, so the batch is not lost — only the ack is.
   * The shipper retries, the fold dedups, and the cost is time.
   */
  it('F5 — a death between the notify and the response loses the ack, not the batch', () => {
    const h = harness({ afterNotifyBeforeRespond: dies })
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()

    expect(response.status).toBe(500)
    expect(h.notified).toEqual([1])
    expect(h.tape).toEqual(['validate', 'journal.write', 'journal.fsync', 'notify'])
    const read = readJournal(h.journalPath)
    expect(read.ok && read.records.length).toBe(1)
  })

  it('every F-test above asserts something F0 makes false — no 202, under the same inputs', () => {
    // The control, restated as an assertion rather than as a comment: the exact
    // request each fault test sends does produce a 202 when nothing is injected.
    const h = harness()
    expect(handleIngest(h.deps, body(), KEY).status).toBe(202)
    h.journal.close()
  })

  it('the 500 says which side of the durable point it failed on, in words an operator can act on', () => {
    const h = harness({ beforeWrite: dies })
    const response = handleIngest(h.deps, body(), KEY)
    h.journal.close()
    expect(JSON.stringify(response.body)).toContain('before it could acknowledge')
    expect(JSON.stringify(response.body)).toContain('process died')
  })
})
