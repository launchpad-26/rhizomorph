import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEventFactory,
  createIdFactory,
  eventsToJsonl,
  type EventOf,
  type EventType,
  type PayloadOf,
  type RhizomorphEvent,
  type SourceOf,
} from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OtelEmitter } from '../collectors/otel/parse-metrics.js'
import { parseTracesExport } from '../collectors/otel/parse-traces.js'
import { repoSlug, sessionDirFor, sessionFileName } from '../log/paths.js'
import { exportOtlpHelpText, parseExportOtlpArgs, runExportOtlp } from './export-otlp.js'

async function writeSessionFile(sessionDir: string, ts: number, events: readonly RhizomorphEvent[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(sessionDir, sessionFileName(ts)), eventsToJsonl(events), 'utf8')
}

/** A session with `spanCount` `trace.span` events, each a distinct trace, plus the usual boot noise. */
function sessionEvents(ts: number, sessionId: string, spanCount = 1): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: ts, stepMs: 1000 })
  f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo' })
  for (let i = 0; i < spanCount; i += 1) {
    f.traceSpan({ traceId: `trace-${i}`, spanId: `span-${i}`, sessionId })
  }
  return f.all()
}

/** A session with no `trace.span` events at all — recorded, but nothing an OTLP receiver ever saw. */
function sessionEventsWithNoSpans(ts: number, sessionId: string): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: ts, stepMs: 1000 })
  f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo' })
  f.agentStatus({ handle: 'worker-1', status: 'working' })
  return f.all()
}

describe('runExportOtlp', () => {
  let dataRoot: string
  let repoPath: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-export-otlp-test-'))
    repoPath = path.join(tmpdir(), 'export-otlp-repo')
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('exports the trace spans of the most recently recorded session by default', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    await writeSessionFile(sessionDir, 2000, sessionEvents(2000, '2000', 2))

    const { outPath, sessionId, spanCount } = await runExportOtlp({ repoPath, dataRoot })

    expect(sessionId).toBe('2000')
    expect(spanCount).toBe(2)
    expect(outPath).toBe(path.join(sessionDir, `${repoSlug(repoPath)}-2000.otlp.json`))

    const written = JSON.parse(await readFile(outPath, 'utf8')) as { resourceSpans: unknown[] }
    expect(written.resourceSpans).toHaveLength(1) // one lane/role group
  })

  it('honors --session to pick a specific recorded session', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    await writeSessionFile(sessionDir, 2000, sessionEvents(2000, '2000', 3))

    const result = await runExportOtlp({ repoPath, dataRoot, sessionId: '1000' })
    expect(result.sessionId).toBe('1000')
    expect(result.spanCount).toBe(1)
  })

  it('throws when there are no recorded sessions', async () => {
    await expect(runExportOtlp({ repoPath, dataRoot })).rejects.toThrow(/no recorded sessions/)
  })

  it('throws when --session names a session that does not exist', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))

    await expect(runExportOtlp({ repoPath, dataRoot, sessionId: '9999' })).rejects.toThrow(
      /no session with id "9999"/,
    )
  })

  /**
   * The sibling of "no recorded sessions": a session exists (someone recorded
   * a plain agent-status run) but no OTLP receiver ever saw it, so there is
   * nothing to dump. Silently writing an empty export-trace request would
   * teach an operator that a `curl` of it does something.
   */
  it('throws when the session has no recorded trace spans', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEventsWithNoSpans(1000, '1000'))

    await expect(runExportOtlp({ repoPath, dataRoot })).rejects.toThrow(/no trace spans recorded/)
  })

  it('refreshes the default (no --out) path on a second export of the same session', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))

    const first = await runExportOtlp({ repoPath, dataRoot })
    expect(first.spanCount).toBe(1)

    // The session grows between the two exports, so a refresh is observable:
    // only a re-read and re-write of the artifact can surface the second span.
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 2))
    const second = await runExportOtlp({ repoPath, dataRoot })

    expect(second.outPath).toBe(first.outPath)
    expect(second.spanCount).toBe(2)
    const onDisk = JSON.parse(await readFile(second.outPath, 'utf8')) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>
    }
    expect(onDisk.resourceSpans[0]?.scopeSpans[0]?.spans).toHaveLength(2)
  })

  it('writes to a custom --out path outside the repo', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    const customOut = path.join(dataRoot, 'custom', 'my-export.json')

    const { outPath } = await runExportOtlp({ repoPath, dataRoot, out: customOut })
    expect(outPath).toBe(customOut)
  })

  it('refuses to write the export inside the watched repo', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    const insideRepo = path.join(repoPath, 'leaked-export.json')

    await expect(runExportOtlp({ repoPath, dataRoot, out: insideRepo })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )
  })

  it('refuses to overwrite an existing --out file, naming --force', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    const customOut = path.join(dataRoot, 'custom', 'my-export.json')
    await mkdir(path.dirname(customOut), { recursive: true })
    await writeFile(customOut, 'pre-existing', 'utf8')

    await expect(runExportOtlp({ repoPath, dataRoot, out: customOut })).rejects.toThrow(
      /refusing to overwrite.*--force/is,
    )
    expect(await readFile(customOut, 'utf8')).toBe('pre-existing')
  })

  it('--force overwrites an existing --out file', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    const customOut = path.join(dataRoot, 'custom', 'my-export.json')
    await mkdir(path.dirname(customOut), { recursive: true })
    await writeFile(customOut, 'pre-existing', 'utf8')

    const { outPath } = await runExportOtlp({ repoPath, dataRoot, out: customOut, force: true })

    expect(outPath).toBe(customOut)
    expect(await readFile(customOut, 'utf8')).not.toBe('pre-existing')
  })

  it('names the directory case instead of advising a --force that cannot help', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    const dirOut = path.join(dataRoot, 'custom')
    await mkdir(dirOut, { recursive: true })

    await expect(runExportOtlp({ repoPath, dataRoot, out: dirOut })).rejects.toThrow(
      /names an existing directory.*pass a file path/is,
    )
    await expect(runExportOtlp({ repoPath, dataRoot, out: dirOut, force: true })).rejects.toThrow(
      /names an existing directory.*pass a file path/is,
    )
    expect((await stat(dirOut)).isDirectory()).toBe(true)
  })

  it('names the default export path when a directory squats on it, instead of blaming --out', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
    await mkdir(path.join(sessionDir, `${repoSlug(repoPath)}-1000.otlp.json`), { recursive: true })

    await expect(runExportOtlp({ repoPath, dataRoot })).rejects.toThrow(/default export path is an existing directory/)
  })

  /**
   * The privacy allowlist (prd9 ruling 5) already bounded what a `trace.span`
   * payload can carry when it was first parsed off the wire; this pins that
   * the exporter's own attribute list is exactly that allowlist and nothing
   * more — a payload with every optional field set must not surface any key
   * beyond the fixed set below. A mutation that started forwarding, say, a
   * stray `payload` field would be caught here.
   */
  it('an exported span carries only the allowlisted attribute keys', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    const f = createEventFactory({ startTs: 1000, stepMs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath: '/repo', repoName: 'repo' })
    f.traceSpan({
      traceId: 'trace-full',
      spanId: 'span-full',
      sessionId: '1000',
      model: 'claude-opus-5',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      ttftMs: 500,
      requestId: 'req-1',
      agentId: 'agent-1',
      parentAgentId: 'agent-0',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      subagentType: 'general-purpose',
      decision: 'accept',
    })
    await writeSessionFile(sessionDir, 1000, f.all())

    const { outPath } = await runExportOtlp({ repoPath, dataRoot })
    const written = JSON.parse(await readFile(outPath, 'utf8')) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }> }>
    }
    const keys = written.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map((a) => a.key).sort()

    expect(keys).toEqual(
      [
        'agent_id',
        'cache_creation_tokens',
        'cache_read_tokens',
        'decision',
        'input_tokens',
        'model',
        'output_tokens',
        'parent_agent_id',
        'request_id',
        'session.id',
        'subagent_type',
        'tool_name',
        'tool_use_id',
        'ttft_ms',
      ].sort(),
    )
  })

  /**
   * The dump is only useful to an operator if it is genuinely the dialect
   * `docs/telemetry.md` claims — this feeds the written file straight back
   * through our own `/v1/traces` parser (the exact code a receiving
   * Rhizomorph, or Langfuse, exercises) and checks the round trip recovers
   * the same facts. A mutation that scrambled the nanos conversion, the
   * status code mapping, or an attribute key would be caught here, not just
   * by re-reading this file's own serializer.
   */
  it('round-trips through this repo\'s own OTLP trace parser', async () => {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    const f = createEventFactory({ startTs: 1000, stepMs: 1000 })
    f.sessionStarted({ sessionId: '1000', repoPath: '/repo', repoName: 'repo' })
    f.traceSpan({
      traceId: 'trace-rt',
      spanId: 'span-rt',
      parentSpanId: null,
      sessionId: '1000',
      name: 'claude_code.llm_request',
      kind: 'llm_request',
      status: 'error',
      model: 'claude-opus-5',
      tokens: { input: 5, output: 6, cacheRead: 7, cacheCreation: 8 },
    })
    await writeSessionFile(sessionDir, 1000, f.all())

    const { outPath } = await runExportOtlp({ repoPath, dataRoot })
    const body = JSON.parse(await readFile(outPath, 'utf8'))

    const nextId = createIdFactory('evt')
    const emitter: OtelEmitter = {
      emit: <T extends EventType>(type: T, payload: PayloadOf<T>, source?: SourceOf<T>): EventOf<T> =>
        ({ id: nextId(), ts: 1_000, source: source ?? 'otel', type, payload }) as EventOf<T>,
    }
    const parsed = parseTracesExport(body, emitter)

    expect(parsed.malformed).toBe(false)
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]?.type).toBe('trace.span')
    expect(parsed.events[0]?.payload).toMatchObject({
      lane: 'feature',
      role: 'worker',
      sessionId: '1000',
      traceId: 'trace-rt',
      spanId: 'span-rt',
      parentSpanId: null,
      name: 'claude_code.llm_request',
      status: 'error',
      model: 'claude-opus-5',
      tokens: { input: 5, output: 6, cacheRead: 7, cacheCreation: 8 },
    })
  })
})

// #299's containment law, over export-otlp's own --out (mirrors
// `export-record-containment.test.ts`): a symlinked --out that is textually
// outside the watched repo but resolves inside it must still be refused.
// Every case here passes `force: true` — the non-force path is separately
// refused by the `wx` write flag regardless of this check, so omitting
// `force` would pass vacuously and prove nothing about containment itself.
describe('runExportOtlp — symlink containment (#299)', () => {
  let root: string
  let dataRoot: string
  let repoPath: string
  let outsideDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-export-otlp-containment-'))
    dataRoot = path.join(root, 'data')
    repoPath = path.join(root, 'repo')
    outsideDir = path.join(root, 'outside')
    await mkdir(repoPath, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000', 1))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a symlinked --out whose target does not exist yet but resolves inside the repo', async () => {
    const link = path.join(outsideDir, 'dangling-link')
    const linkTarget = path.join(repoPath, 'leaked-export.json')
    await symlink(linkTarget, link)

    await expect(runExportOtlp({ repoPath, dataRoot, out: link, force: true })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )
    await expect(readFile(linkTarget, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('refuses a symlinked --out whose target already exists inside the repo', async () => {
    const linkTarget = path.join(repoPath, 'leaked-export.json')
    await writeFile(linkTarget, 'pre-existing', 'utf8')
    const link = path.join(outsideDir, 'existing-link')
    await symlink(linkTarget, link)

    await expect(runExportOtlp({ repoPath, dataRoot, out: link, force: true })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )
    expect(await readFile(linkTarget, 'utf8')).toBe('pre-existing')
  })

  it('still allows a symlinked --out whose target resolves outside the repo', async () => {
    const realTargetDir = path.join(outsideDir, 'real-target-dir')
    await mkdir(realTargetDir, { recursive: true })
    const link = path.join(outsideDir, 'safe-link')
    await symlink(realTargetDir, link)
    const out = path.join(link, 'exported.json')

    const { outPath } = await runExportOtlp({ repoPath, dataRoot, out, force: true })

    expect(outPath).toBe(out)
    const onDisk = JSON.parse(await readFile(path.join(realTargetDir, 'exported.json'), 'utf8'))
    expect(onDisk.resourceSpans).toHaveLength(1)
  })
})

describe('parseExportOtlpArgs', () => {
  const exportDefaults = { path: undefined, sessionId: undefined, out: undefined, force: false, help: false }

  it('defaults everything to undefined', () => {
    expect(parseExportOtlpArgs([])).toEqual(exportDefaults)
  })

  it('takes the first non-flag token as the path', () => {
    expect(parseExportOtlpArgs(['../some-repo'])).toEqual({ ...exportDefaults, path: '../some-repo' })
  })

  it('parses --session', () => {
    expect(parseExportOtlpArgs(['--session', '123'])).toEqual({ ...exportDefaults, sessionId: '123' })
  })

  it('parses --out=<file>', () => {
    expect(parseExportOtlpArgs(['--out=/tmp/x.otlp.json'])).toEqual({
      ...exportDefaults,
      out: '/tmp/x.otlp.json',
    })
  })

  it('parses --force', () => {
    expect(parseExportOtlpArgs(['--force'])).toEqual({ ...exportDefaults, force: true })
  })

  it('throws on an empty --session value', () => {
    expect(() => parseExportOtlpArgs(['--session', ''])).toThrow(/invalid --session/)
  })

  it('throws on an unknown flag, naming it', () => {
    expect(() => parseExportOtlpArgs(['--foo'])).toThrow(/unknown option.*"--foo"/is)
  })

  it('parses --help without requiring anything else', () => {
    expect(parseExportOtlpArgs(['--help']).help).toBe(true)
    expect(parseExportOtlpArgs(['-h']).help).toBe(true)
  })
})

describe('exportOtlpHelpText', () => {
  it('documents path, --session, --out, --force, --help and the replay workflow', () => {
    const text = exportOtlpHelpText()
    expect(text).toContain('rhizomorph export-otlp')
    expect(text).toContain('--session')
    expect(text).toContain('--out')
    expect(text).toContain('--force')
    expect(text).toContain('--help')
    expect(text).toContain('curl')
    expect(text).toContain('/api/public/otel/v1/traces')
  })
})

/**
 * THE ZERO-OUTBOUND LAW, at the level of the source text — exactly the
 * readonly-grep style `drawer/readonly.test.ts` and `lab/namespace-law.test.ts`
 * already use elsewhere in this repo. "This command still sends nothing,
 * ever" (the 2026-08-12 ruling that unblocked #128) is not a property any
 * behavioural test can prove — a `fetch(` added tomorrow in a branch nothing
 * here calls would pass every test above. So this greps the module's own
 * source text instead.
 *
 * Deliberately excludes THIS file from the sweep: a law that greps `fetch(`
 * over its own directory would match its own fixture strings below and
 * fail on itself — the exact bug the issue calls out as having shipped
 * twice already this week. Only `export-otlp.ts`, the module that actually
 * builds and writes the export, is swept.
 */
describe('export-otlp reaches for no outbound call (the offline-rung law)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const SOURCE_PATH = path.join(HERE, 'export-otlp.ts')
  const NETWORK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
    { name: 'fetch(', pattern: /\bfetch\s*\(/ },
    { name: 'http.request(', pattern: /\bhttp\.request\s*\(/ },
    { name: 'net.connect(', pattern: /\bnet\.connect\s*\(/ },
  ]

  it('the module that builds the export has zero matches for fetch(, http.request(, or net.connect(', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const offenders = NETWORK_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name)
    expect(offenders).toEqual([])
  })

  it('the detector bites — each pattern matches a deliberately-network fixture, proving it is not vacuous', () => {
    const fixtures = [
      "await fetch('https://langfuse.example/api/public/otel/v1/traces', { method: 'POST' })",
      "http.request(options, (res) => {})",
      "net.connect(port, host)",
    ]
    for (const { pattern } of NETWORK_PATTERNS) {
      expect(fixtures.some((line) => pattern.test(line)), `no fixture matched ${pattern}`).toBe(true)
    }
  })

  it('does not false-positive on the verbs merely being named in prose, as this very law does above', () => {
    const prose = 'This module never calls fetch or http.request or net.connect on its own.'
    for (const { pattern } of NETWORK_PATTERNS) {
      expect(pattern.test(prose)).toBe(false)
    }
  })
})
