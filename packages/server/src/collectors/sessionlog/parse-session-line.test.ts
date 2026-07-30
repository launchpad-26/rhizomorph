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
      cwd: '/home/operator/worktrees-challenge__worktrees/2-core',
      gitBranch: '2-core',
      requestId: 'req_011CdXK9nHfLfMD1xWUP4FYL',
      model: 'claude-opus-5',
      toolUses: [],
    })
    expect(facts?.tokens).toEqual({
      input: 2,
      output: 250,
      cacheRead: 21093,
      cacheCreation: 7612,
    })
  })

  it('parses a tool_use assistant line and reports the tool name', () => {
    const lines = fixtureLines('worker-2-core.jsonl')
    const facts = parseAssistantLine(lines[1] as string)

    expect(facts?.toolUses).toEqual(['Read'])
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
    expect(first?.toolUses).toEqual(['Read'])
    expect(second?.toolUses).toEqual(['Read'])
    expect(third?.toolUses).toEqual(['Read'])

    // A later, distinct reply in the same file gets its own requestId.
    expect(fourth?.requestId).toBe('req_011CdXKgfbwmprh37TF3u2MZ')
    expect(fourth?.toolUses).toEqual(['Bash'])
  })

  it('attributes a conductor session (cwd is the repo root, not a worktree) the same way', () => {
    const lines = fixtureLines('conductor-root.jsonl')
    const facts = parseAssistantLine(lines[0] as string)

    expect(facts).toMatchObject({
      cwd: '/home/operator/worktrees-challenge',
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
})
