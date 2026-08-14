import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TurnEntry } from '../sessionlog/turn-grammar.js'
import { PI_COMPLETING_STOP_REASONS, PI_JSONL_GRAMMAR } from './grammar.js'

/**
 * The pi dialect, stated against **real captures** (prd15 ruling 1's
 * dialect-verification clause; prd26 ruling 5 / ADR-0017). Every fixture read
 * here is a mechanically redacted real `pi 0.83.0` session — see
 * `fixtures/CAPTURE.md`. Nothing here is hand-written from
 * `session-format.md`: that doc validates a *hypothesis*, these fixtures
 * validate the tool.
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))
const CAPTURED_VERSION = 'pi-0.83.0'

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function classifiedTail(name: string): TurnEntry | null {
  const entries = fixtureLines(name)
    .map((line) => PI_JSONL_GRAMMAR.classify(line))
    .filter((entry): entry is TurnEntry => entry !== null)
  return entries.at(-1) ?? null
}

describe('the pi JSONL turn grammar', () => {
  it('names the capture it was derived from, not a document', () => {
    expect(PI_JSONL_GRAMMAR.cli).toBe('pi')
    expect(PI_JSONL_GRAMMAR.capture).toContain(CAPTURED_VERSION)
    expect(PI_JSONL_GRAMMAR.capture).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('skips the session header and the model/thinking-level bookkeeping lines', () => {
    for (const line of [
      '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/x"}',
      '{"type":"model_change","id":"a","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","provider":"openrouter","modelId":"x"}',
      '{"type":"thinking_level_change","id":"b","parentId":"a","timestamp":"2026-01-01T00:00:00.000Z","thinkingLevel":"high"}',
    ]) {
      expect(PI_JSONL_GRAMMAR.classify(line)).toBeNull()
    }
  })

  it('reads a completed turn with no tool call as turnComplete (the plain success capture)', () => {
    const tail = classifiedTail(`${CAPTURED_VERSION}-turn-complete.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: true, opensToolUseIds: [] })
    expect(PI_COMPLETING_STOP_REASONS).toEqual(['stop', 'error'])
  })

  it('reads a real tool call as pending, carrying its id — proven by a real capture, not inferred', () => {
    // fixtures/CAPTURE.md's incrementality proof: a real SIGINT sent 6s into
    // a `sleep 15` bash call left the session file truncated on exactly this
    // shape, permanently — this is what was really on disk mid-tool-call.
    const tail = classifiedTail(`${CAPTURED_VERSION}-tail-pending-tool-interrupted.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: false })
    expect(tail?.role === 'assistant' && tail.opensToolUseIds).toEqual(['toolu_bdrk_01HXJgj9fHFxwoXcxSbBXo3i'])
    // Pinned against the entry's own `line.timestamp` (2026-08-14T05:39:09.493Z),
    // NOT `message.timestamp` (1786685946546, a different, earlier value on
    // this exact line) — see grammar.ts's header comment for why.
    expect(tail?.ts).toBe(1786685949493)
  })

  it('reads a tool result as a user entry that closes the call it answers, whether or not the tool itself failed', () => {
    // Classified, non-null order for the tool-call capture is
    // [user, assistant-pending, toolResult, assistant-final] — the toolResult
    // entry is the third of the four, not the second (that's the pending call).
    const successLines = fixtureLines(`${CAPTURED_VERSION}-tool-call.jsonl`)
    const toolResultEntry = successLines.map((line) => PI_JSONL_GRAMMAR.classify(line)).filter((e): e is TurnEntry => e !== null)[2]
    expect(toolResultEntry).toMatchObject({ role: 'user' })
    expect(toolResultEntry?.role === 'user' && toolResultEntry.closesToolUseIds).toEqual(['toolu_bdrk_016XrSLLjoF4jw1vmVpAKdwp'])

    // isError:true (the tool itself failed) still closes the call the same
    // way — TurnEntry has no opinion about tool success, only turn shape.
    const errorLines = fixtureLines(`${CAPTURED_VERSION}-tool-call-error.jsonl`)
    const errorResultEntry = errorLines.map((line) => PI_JSONL_GRAMMAR.classify(line)).filter((e): e is TurnEntry => e !== null)[2]
    expect(errorResultEntry?.role === 'user' && errorResultEntry.closesToolUseIds).toEqual(['toolu_bdrk_01Dt8pdUErRPqeamRbLiboTU'])
  })

  it('reads the real API-rejection failure as a completed turn, not a silent absence', () => {
    // The real "definitely-not-a-real-model-xyz" rejection: content:[],
    // stopReason:"error" — this is pi's actual failure shape, an assistant
    // entry, never a missing or truncated file.
    const tail = classifiedTail(`${CAPTURED_VERSION}-task-error.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: true, opensToolUseIds: [] })
  })

  it('maps an unknown or malformed line to no-opinion, never to an error', () => {
    for (const line of ['', '   ', 'not json at all', '{"type":"a-shape-from-2027"}', '[]', 'null', '{']) {
      expect(() => PI_JSONL_GRAMMAR.classify(line)).not.toThrow()
      expect(PI_JSONL_GRAMMAR.classify(line)).toBeNull()
    }
  })

  it('refuses to let an unverified stopReason ("length", "aborted", or anything newer) manufacture a completed turn', () => {
    // session-format.md documents "length" and "aborted" as possible
    // stopReason values; neither was ever captured on this machine. The
    // conservative reading claude's own grammar uses for an unseen stop
    // reason applies here too: never manufacture a WAITING summons from a
    // shape nobody has verified.
    for (const stopReason of ['length', 'aborted', 'a-reason-from-2027']) {
      const line = JSON.stringify({
        type: 'message',
        id: 'x',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [], model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason },
      })
      expect(PI_JSONL_GRAMMAR.classify(line)).toMatchObject({ role: 'assistant', turnComplete: false })
    }
  })

  it('never calls a turn complete while it has an open tool call, whatever stopReason says', () => {
    const line = JSON.stringify({
      type: 'message',
      id: 'x',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'x',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'stop',
        content: [{ type: 'toolCall', id: 'toolu_x', name: 'bash', arguments: {} }],
      },
    })
    expect(PI_JSONL_GRAMMAR.classify(line)).toMatchObject({ turnComplete: false, opensToolUseIds: ['toolu_x'] })
  })

  it('never treats stopReason:"toolUse" as completing, even on a malformed line with no toolCall block', () => {
    // Real captures never show this combination (a real `stopReason:"toolUse"`
    // line always carries the toolCall it opened) — this is the behavioural
    // case that actually distinguishes PI_COMPLETING_STOP_REASONS from
    // ['stop','error','toolUse']: with 'toolUse' added, an empty
    // opensToolUseIds would satisfy both halves of the turnComplete guard and
    // this would wrongly read complete. The literal-identity check above
    // (`toEqual(['stop','error'])`) catches the set changing; this catches
    // what changing it would actually do.
    const line = JSON.stringify({
      type: 'message',
      id: 'x',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [], model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'toolUse' },
    })
    expect(PI_JSONL_GRAMMAR.classify(line)).toMatchObject({ role: 'assistant', turnComplete: false, opensToolUseIds: [] })
  })

  it('reports sidechain as always false — no such marker was ever captured for pi', () => {
    const tail = classifiedTail(`${CAPTURED_VERSION}-turn-complete.jsonl`)
    expect(tail?.sidechain).toBe(false)
  })
})

describe('the pi JSONL grammar bundles extraction too (prd26 ruling 5 / ADR-0017)', () => {
  // Every fixture here is [session, model_change, thinking_level_change,
  // user, assistant, ...] — line index 4 is always the first assistant line.

  it('extracts real usage, cost-bearing model facts through the grammar, from a real capture', () => {
    const lines = fixtureLines(`${CAPTURED_VERSION}-turn-complete.jsonl`)
    const facts = PI_JSONL_GRAMMAR.extractFacts(lines[4] as string)
    expect(facts).toMatchObject({ model: 'anthropic/claude-haiku-4.5', toolUses: [] })
    expect(facts?.tokens).toEqual({ input: 1974, output: 38, cacheRead: 0, cacheCreation: 0 })
    // Never present on a pi message line — see grammar.ts's header comment.
    expect(facts).toMatchObject({ sessionId: null, cwd: null, gitBranch: null, requestId: null, isSidechain: false })
    // Pinned against the entry's own `line.timestamp` (2026-08-14T05:32:01.229Z),
    // NOT `message.timestamp` (1786685519047, ~2.2s earlier on this exact
    // line) — see grammar.ts's header comment for why this must be
    // `line.timestamp`. A prior version of this grammar read the wrong field
    // and every one of these 45 tests stayed green — this assertion is what
    // catches it now.
    expect(facts?.timestamp).toBe(1786685521229)
  })

  it('maps cacheRead/cacheWrite to the shared tokens.cacheRead/cacheCreation without swapping them — NOT fixture-backed', () => {
    // Every real capture on this machine shows cacheRead:0, cacheWrite:0 —
    // four back-to-back turns in one session never triggered caching via
    // openrouter/anthropic-claude-haiku-4.5 (tested, not assumed). A swapped
    // mapping is therefore invisible on every real fixture (0 reads as 0
    // either way) — exactly the "test that cannot fail for the reason it
    // claims" shape this repo's own discipline warns about. This synthetic
    // line, with distinct nonzero values, is what actually pins the mapping;
    // labelled here as an assumption from the field's own name and pi's
    // documented `Usage` interface, not a captured fact.
    const line = JSON.stringify({
      type: 'message',
      id: 'x',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'x',
        content: [],
        stopReason: 'stop',
        usage: { input: 1, output: 2, cacheRead: 30, cacheWrite: 40 },
      },
    })
    expect(PI_JSONL_GRAMMAR.extractFacts(line)?.tokens).toEqual({ input: 1, output: 2, cacheRead: 30, cacheCreation: 40 })
  })

  it('extracts a real tool call, with its id, from a real capture', () => {
    const lines = fixtureLines(`${CAPTURED_VERSION}-tool-call.jsonl`)
    const facts = PI_JSONL_GRAMMAR.extractFacts(lines[4] as string)
    expect(facts?.toolUses).toEqual([{ tool: 'bash', toolUseId: 'toolu_bdrk_016XrSLLjoF4jw1vmVpAKdwp', filePath: null }])
  })

  it('extracts a real file-tool path from arguments.path (write/edit — pi\'s own key, not claude\'s file_path)', () => {
    const lines = fixtureLines(`${CAPTURED_VERSION}-write-tool.jsonl`)
    const facts = PI_JSONL_GRAMMAR.extractFacts(lines[4] as string)
    expect(facts?.toolUses).toEqual([{ tool: 'write', toolUseId: expect.any(String), filePath: '/repo-wt/pi-capture/scratch/pi-write-target.txt' }])
  })

  it('extracts real zeroed usage from the real API-rejection failure, never a fabricated model', () => {
    const lines = fixtureLines(`${CAPTURED_VERSION}-task-error.jsonl`)
    const facts = PI_JSONL_GRAMMAR.extractFacts(lines[4] as string)
    expect(facts).toMatchObject({ model: 'definitely-not-a-real-model-xyz' })
    expect(facts?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
  })

  it('extracts null for a non-assistant line, same as classify has no opinion', () => {
    expect(PI_JSONL_GRAMMAR.extractFacts('{"type":"model_change","id":"a","parentId":null,"timestamp":"x","provider":"openrouter","modelId":"x"}')).toBeNull()
    const lines = fixtureLines(`${CAPTURED_VERSION}-tool-call.jsonl`)
    // line 3 is the user prompt, line 5 is the toolResult — neither carries assistant facts
    expect(PI_JSONL_GRAMMAR.extractFacts(lines[3] as string)).toBeNull()
    expect(PI_JSONL_GRAMMAR.extractFacts(lines[5] as string)).toBeNull()
  })
})

describe('fixture hygiene law', () => {
  // Version-pinning and line-parseability are captures-only laws — CAPTURE.md
  // is neither versioned nor JSONL. But the host-path/identity/NUL-byte scan
  // MUST be total, over every file in the directory: #322's own CAPTURE.md
  // leaked a literal operator home path inside the very sentence documenting
  // its redaction, and this fixture's own CAPTURE.md did too, in the same
  // place, for the same reason — a hygiene law that only scans `pi-*`
  // fixtures never looks at the prose file most likely to quote a real path
  // as an example. Scanning every file, captures included, costs nothing
  // extra and catches both.
  const fixtures = readdirSync(FIXTURES_DIR).filter((name) => name.startsWith('pi-'))
  const allFiles = readdirSync(FIXTURES_DIR)

  it('pins every captured fixture to the tool version in its filename', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const name of fixtures) {
      expect(name).toMatch(/^pi-\d+\.\d+\.\d+-/)
    }
  })

  it('carries no identity, no host paths and no NUL bytes into a repo that will go public — every file, not just the captures', () => {
    expect(allFiles.length).toBeGreaterThan(fixtures.length) // sanity: CAPTURE.md itself is in scope
    for (const name of allFiles) {
      const raw = readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
      expect(raw, `${name} carries an email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      expect(raw, `${name} carries a real home directory`).not.toMatch(/\/(home|Users)\/[a-zA-Z0-9_.-]/)
      expect(raw.includes('\u0000'), `${name} carries a NUL byte`).toBe(false)
    }
  })

  it('keeps every fixture parseable line-by-line, so a capture cannot rot silently', () => {
    for (const name of fixtures) {
      for (const line of fixtureLines(name)) {
        expect(() => JSON.parse(line), `${name} has an unparsable line`).not.toThrow()
      }
    }
  })
})
