import { describe, expect, it } from 'vitest'
import {
  BEACON_ATTENTION_KINDS,
  BEACON_LINE_VERSION,
  BEACON_MESSAGE_MAX,
  beaconReceivedPayloadSchema,
} from './beacon.js'

/**
 * The beacon payload's key-set, stated structurally — the shape `tmux.test.ts`
 * already uses for its own payloads (#292).
 *
 * This file is new with prd-57 wave 1. `beacon.ts` has never had a sibling
 * test: its schema was exercised only from `gate-honesty-law.test.ts`, one
 * package out, as a side effect of parsing a real gate line. That is a fine
 * integration check and a poor place to learn what the payload admits, which is
 * why ruling 3's four join keys arrive with this.
 */

const DIGEST = 'a'.repeat(64)

/** A line as every writer before prd-57 produced one — no join keys at all. */
const legacy = {
  writer: 'gate',
  kind: 'waiting',
  lane: '2-core',
  digest: DIGEST,
  file: 'gate.jsonl',
  offset: 0,
}

describe('beaconReceivedPayloadSchema', () => {
  it('has a fixed key-set — a new field is a decision, not a drift', () => {
    expect(Object.keys(beaconReceivedPayloadSchema.shape).sort()).toEqual([
      'cwd',
      'detail',
      'digest',
      'file',
      'kind',
      'lane',
      'message',
      'offset',
      'pid',
      'sessionId',
      'transcriptPath',
      'writer',
    ])
  })

  it('carries no field for a prompt, a tool input, or a completion — the words plane prd-57 refuses', () => {
    for (const field of ['toolInput', 'tool_input', 'prompt', 'completion', 'text', 'content', 'preview']) {
      expect(Object.keys(beaconReceivedPayloadSchema.shape)).not.toContain(field)
    }
  })

  it('strips an unknown key on parse rather than failing the line (ADR-0011)', () => {
    // ADR-0036 is explicit that extra keys are ignored and covered by the
    // digest, and ADR-0011 forbids a refusing parse on a log that must fold old
    // recordings. So a planted `tool_input` does NOT die here — it is stripped
    // from the event and stays in the file. The law that it never reaches disk
    // belongs to the hook runner, which is wave 3's, and is stated there.
    const parsed = beaconReceivedPayloadSchema.parse({ ...legacy, tool_input: { command: 'rm -rf /' } })
    expect(parsed).toBeDefined()
    expect(Object.keys(parsed)).not.toContain('tool_input')
  })
})

describe('the hook join keys are optional, because an old recording must fold unchanged (prd-57 ruling 3)', () => {
  it('a line with no join keys at all parses — every writer before prd-57 wrote one of these', () => {
    const parsed = beaconReceivedPayloadSchema.parse(legacy)
    expect(parsed.sessionId).toBeUndefined()
    expect(parsed.cwd).toBeUndefined()
    expect(parsed.pid).toBeUndefined()
  })

  it.each(['sessionId', 'transcriptPath', 'cwd', 'pid', 'message'])(
    'a line carrying only %s parses — the four are independent, not a block that arrives together',
    (field) => {
      const value = field === 'pid' ? 4321 : 'x'
      expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, [field]: value })).not.toThrow()
    },
  )

  it('a full hook line parses and every key survives — the declared join, in one fact', () => {
    const parsed = beaconReceivedPayloadSchema.parse({
      ...legacy,
      writer: 'claude-hook',
      sessionId: '0199c3f1-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
      transcriptPath: '/home/operator/.claude/projects/repo/0199c3f1.jsonl',
      cwd: '/repo-wt/2-core',
      pid: 4321,
    })
    expect(parsed.sessionId).toBe('0199c3f1-7a2b-7c3d-8e4f-5a6b7c8d9e0f')
    expect(parsed.cwd).toBe('/repo-wt/2-core')
    expect(parsed.pid).toBe(4321)
  })

  it('a pid is a positive integer — 0 and -1 are not pids, and both are what a failed read returns', () => {
    for (const pid of [0, -1, 1.5]) {
      expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, pid })).toThrow()
    }
  })

  it('an empty join key is refused rather than stored — absent and empty are different facts', () => {
    for (const field of ['sessionId', 'transcriptPath', 'cwd']) {
      expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, [field]: '' })).toThrow()
    }
  })
})

describe('the message ceiling is declared, and it is the writer that applies it', () => {
  it('states a bound the runner can truncate to', () => {
    expect(BEACON_MESSAGE_MAX).toBe(512)
  })

  it('a message at the ceiling parses and one past it does not', () => {
    expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, message: 'x'.repeat(BEACON_MESSAGE_MAX) })).not.toThrow()
    expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, message: 'x'.repeat(BEACON_MESSAGE_MAX + 1) })).toThrow()
  })
})

describe('what this change did not touch', () => {
  it('the line version is unchanged — this is an additive widening, not a new era', () => {
    expect(BEACON_LINE_VERSION).toBe(1)
  })

  it('the attention vocabulary is unchanged', () => {
    expect([...BEACON_ATTENTION_KINDS]).toEqual(['waiting', 'working', 'stopped'])
  })

  it('kind stays free-form — a collector that dropped a kind it had not met is the silent loss ADR-0011 forbids', () => {
    expect(() => beaconReceivedPayloadSchema.parse({ ...legacy, kind: 'a-kind-from-a-later-era' })).not.toThrow()
  })
})
