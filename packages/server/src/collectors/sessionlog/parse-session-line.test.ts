import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAssistantLine } from './parse-session-line.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(dirname, 'fixtures')

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(fixturesDir, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

describe('parseAssistantLine', () => {
  it('parses a text-only assistant line, with no tool calls', () => {
    const lines = fixtureLines('worker-2-core.jsonl')
    const facts = parseAssistantLine(lines[0] as string)

    expect(facts).toMatchObject({
      sessionId: '95f42357-058c-4ea2-84d4-de7b1eb58635',
      cwd: '/repo-wt/2-core',
      gitBranch: '2-core',
      requestId: 'req_011CdXK9nHfLfMD1xWUP4FYL',
      model: 'claude-opus-5',
      toolUses: [],
      timestamp: Date.parse('2026-07-30T00:42:23.473Z'),
    })
    expect(facts?.tokens).toEqual({
      input: 2,
      output: 250,
      cacheRead: 21093,
      cacheCreation: 7612,
    })
  })

  it('parses a tool_use assistant line and reports the tool name, its id and file_path', () => {
    const lines = fixtureLines('worker-2-core.jsonl')
    const facts = parseAssistantLine(lines[1] as string)

    expect(facts?.toolUses).toEqual([
      {
        tool: 'Read',
        toolUseId: 'toolu_01GqsDLd5PHv36rnrXqFqrLx',
        filePath: '/repo-wt/2-core/docs/vision.md',
      },
    ])
    // Same reply, split across two lines: usage and requestId repeat verbatim.
    expect(facts?.requestId).toBe('req_011CdXK9nHfLfMD1xWUP4FYL')
    expect(facts?.tokens).toEqual({
      input: 2,
      output: 250,
      cacheRead: 21093,
      cacheCreation: 7612,
    })
  })

  it('reports the same requestId and usage for every line of a multi-tool-call reply', () => {
    const lines = fixtureLines('worker-4-tmux-collector.jsonl')
    const [first, second, third, fourth] = lines.map((line) => parseAssistantLine(line))

    expect(first?.requestId).toBe('req_011CdXKgL7B2nj6xkUSoy4tk')
    expect(second?.requestId).toBe(first?.requestId)
    expect(third?.requestId).toBe(first?.requestId)
    expect(first?.toolUses.map((t) => t.tool)).toEqual(['Read'])
    expect(second?.toolUses.map((t) => t.tool)).toEqual(['Read'])
    expect(third?.toolUses.map((t) => t.tool)).toEqual(['Read'])

    // A later, distinct reply in the same file gets its own requestId.
    expect(fourth?.requestId).toBe('req_011CdXKgfbwmprh37TF3u2MZ')
    expect(fourth?.toolUses).toEqual([
      { tool: 'Bash', toolUseId: 'toolu_016mhV6ZLsSUsgv9fAENhG3A', filePath: null },
    ])
  })

  it('populates filePath for Edit/Write/Read (a file_path input), leaves it null for Bash (a command input)', () => {
    const lines = fixtureLines('worker-4-tmux-collector.jsonl')
    const facts = lines.map((line) => parseAssistantLine(line))
    expect(facts.map((f) => f?.toolUses[0]?.filePath)).toEqual([
      '/repo-wt/4-tmux-collector/docs/vision.md',
      '/repo-wt/4-tmux-collector/docs/prd0.md',
      '/repo-wt/4-tmux-collector/docs/architecture.md',
      null,
    ])
  })

  it('always reports the tool_use block\'s own id, file tool or not', () => {
    const lines = fixtureLines('worker-4-tmux-collector.jsonl')
    const facts = lines.map((line) => parseAssistantLine(line))
    expect(facts.map((f) => f?.toolUses[0]?.toolUseId)).toEqual([
      'toolu_019fAq2GB1eeu9rh63n1BfU6',
      'toolu_01BNpUfRjed6SWA9Se4HGWY3',
      'toolu_01SzR2F33CgoyztWPJ6thcC1',
      'toolu_016mhV6ZLsSUsgv9fAENhG3A',
    ])
  })

  it('never guesses a filePath for a tool block whose input has no file_path key', () => {
    const base = '{"type":"assistant","message":{"model":"x","usage":{},"content":['
    const line = `${base}{"type":"tool_use","id":"toolu_x","name":"Glob","input":{"pattern":"**/*.ts"}}]}}`
    expect(parseAssistantLine(line)?.toolUses).toEqual([{ tool: 'Glob', toolUseId: 'toolu_x', filePath: null }])
  })

  it('reports a null toolUseId when the tool_use block has no id', () => {
    const base = '{"type":"assistant","message":{"model":"x","usage":{},"content":['
    const line = `${base}{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}`
    expect(parseAssistantLine(line)?.toolUses).toEqual([{ tool: 'Bash', toolUseId: null, filePath: null }])
  })

  it('attributes a conductor session (cwd is the repo root, not a worktree) the same way', () => {
    const lines = fixtureLines('conductor-root.jsonl')
    const facts = parseAssistantLine(lines[0] as string)

    expect(facts).toMatchObject({
      cwd: '/repo',
      gitBranch: 'main',
      model: 'claude-sonnet-5',
      toolUses: [],
    })
  })

  it('returns null for non-assistant line types', () => {
    expect(parseAssistantLine('{"type":"user","message":{"role":"user","content":"hi"}}')).toBeNull()
    expect(parseAssistantLine('{"type":"ai-title","aiTitle":"x"}')).toBeNull()
  })

  it('never throws on garbage input', () => {
    expect(parseAssistantLine('')).toBeNull()
    expect(parseAssistantLine('not json at all')).toBeNull()
    expect(parseAssistantLine('{"type":"assistant"}')).toBeNull()
    expect(parseAssistantLine('{"type":"assistant","message":{"model":"x"}}')).toBeNull()
  })

  it('parses isSidechain: true off a sidechain (subagent) line (#65)', () => {
    const base = '{"type":"assistant","message":{"model":"x","usage":{}}'
    expect(parseAssistantLine(`${base},"isSidechain":true}`)?.isSidechain).toBe(true)
  })

  it('treats every real fixture line as main (isSidechain: false) — none of them are sidechain turns', () => {
    for (const name of ['worker-2-core.jsonl', 'worker-4-tmux-collector.jsonl', 'conductor-root.jsonl']) {
      for (const line of fixtureLines(name)) {
        expect(parseAssistantLine(line)?.isSidechain).toBe(false)
      }
    }
  })

  it('defaults isSidechain to false when the marker is absent or not a boolean', () => {
    const base = '{"type":"assistant","message":{"model":"x","usage":{}}'
    expect(parseAssistantLine(`${base}}`)?.isSidechain).toBe(false)
    expect(parseAssistantLine(`${base},"isSidechain":"true"}`)?.isSidechain).toBe(false)
  })

  it('falls back to a null timestamp when the line has none or an unparsable one', () => {
    const base = '{"type":"assistant","message":{"model":"x","usage":{}}'
    expect(parseAssistantLine(`${base}}`)?.timestamp).toBeNull()
    expect(parseAssistantLine(`${base},"timestamp":"not-a-date"}`)?.timestamp).toBeNull()
    expect(parseAssistantLine(`${base},"timestamp":"2026-07-30T00:42:23.473Z"}`)?.timestamp).toBe(
      Date.parse('2026-07-30T00:42:23.473Z'),
    )
  })
})
