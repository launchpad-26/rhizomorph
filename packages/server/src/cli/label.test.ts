import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionLabel } from '../log/label.js'
import { sessionDirFor, sessionFileName } from '../log/paths.js'
import { labelHelpText, parseLabelArgs, runLabel } from './label.js'

describe('runLabel', () => {
  let dataRoot: string
  const repoPath = '/repo/rhizomorph'

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-label-run-'))
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  async function recordSession(sessionId: string): Promise<string> {
    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await mkdir(sessionDir, { recursive: true })
    const f = createEventFactory({ startTs: Number(sessionId) })
    f.sessionStarted({ sessionId, repoPath })
    await writeFile(path.join(sessionDir, sessionFileName(Number(sessionId))), eventsToJsonl(f.all()), 'utf8')
    return sessionDir
  }

  it('writes a label for a session that was actually recorded', async () => {
    const sessionDir = await recordSession('1000')

    const result = await runLabel({ repoPath, sessionId: '1000', label: 'the scene lands', dataRoot, now: () => 5000 })

    expect(result).toEqual({ sessionDir, sessionId: '1000', label: 'the scene lands' })
    expect(await readSessionLabel(sessionDir, '1000')).toBe('the scene lands')
  })

  it('refuses a session id nothing was recorded for, rather than creating an orphan sidecar', async () => {
    await expect(
      runLabel({ repoPath, sessionId: 'nonexistent', label: 'a label', dataRoot }),
    ).rejects.toThrow(/no session with id "nonexistent"/)
  })

  it('trims the label before writing it', async () => {
    await recordSession('1000')
    const result = await runLabel({ repoPath, sessionId: '1000', label: '  spaced out  ', dataRoot })
    expect(result.label).toBe('spaced out')
  })

  it('relabelling overwrites the previous label', async () => {
    const sessionDir = await recordSession('1000')
    await runLabel({ repoPath, sessionId: '1000', label: 'first pass', dataRoot })
    await runLabel({ repoPath, sessionId: '1000', label: 'second pass', dataRoot })
    expect(await readSessionLabel(sessionDir, '1000')).toBe('second pass')
  })

  it('never touches the session log itself', async () => {
    const sessionDir = await recordSession('1000')
    const logPath = path.join(sessionDir, sessionFileName(1000))
    const before = await readFile(logPath, 'utf8')

    await runLabel({ repoPath, sessionId: '1000', label: 'a label', dataRoot })

    expect(await readFile(logPath, 'utf8')).toBe(before)
  })
})

describe('parseLabelArgs', () => {
  it('takes the first positional as the session id and the rest as the label', () => {
    expect(parseLabelArgs(['1000', 'a', 'label'])).toEqual({
      sessionId: '1000',
      label: 'a label',
      path: undefined,
      help: false,
    })
  })

  it('accepts a single quoted label argument', () => {
    expect(parseLabelArgs(['1000', 'the scene lands'])).toEqual({
      sessionId: '1000',
      label: 'the scene lands',
      path: undefined,
      help: false,
    })
  })

  it('parses --path', () => {
    expect(parseLabelArgs(['1000', 'a label', '--path', '../other-repo'])).toEqual({
      sessionId: '1000',
      label: 'a label',
      path: '../other-repo',
      help: false,
    })
  })

  it('throws when the session id is missing', () => {
    expect(() => parseLabelArgs([])).toThrow(/missing required argument.*<sessionId>/is)
  })

  it('throws when the label text is missing', () => {
    expect(() => parseLabelArgs(['1000'])).toThrow(/missing required argument.*<text>/is)
  })

  it('throws for a whitespace-only label', () => {
    expect(() => parseLabelArgs(['1000', '   '])).toThrow(/missing required argument.*<text>/is)
  })

  it('parses --help without requiring a session id or text', () => {
    expect(parseLabelArgs(['--help']).help).toBe(true)
    expect(parseLabelArgs(['-h']).help).toBe(true)
  })
})

describe('labelHelpText', () => {
  it('documents the sessionId/text arguments, --path and --help', () => {
    const text = labelHelpText()
    expect(text).toContain('rhizomorph label <sessionId>')
    expect(text).toContain('--path')
    expect(text).toContain('--help')
  })
})
