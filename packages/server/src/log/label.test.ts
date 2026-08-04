import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionLabel, sessionLabelFilePath, writeSessionLabel } from './label.js'
import { sessionLabelFileName } from './paths.js'

describe('session labels', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-labels-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads null for a session that was never labelled', async () => {
    expect(await readSessionLabel(dir, '1000')).toBeNull()
  })

  it('writes a label sidecar and reads it back, never touching a same-named log file', async () => {
    const logPath = path.join(dir, 'session-1000.jsonl')
    await writeFile(logPath, '{"id":"evt-1"}\n', 'utf8')

    await writeSessionLabel(dir, '1000', 'the scene lands', 5000)

    expect(await readSessionLabel(dir, '1000')).toBe('the scene lands')
    expect(await readFile(logPath, 'utf8')).toBe('{"id":"evt-1"}\n')
  })

  it('writes to a sidecar file distinct from the session log', async () => {
    await writeSessionLabel(dir, '1000', 'a label', 5000)
    const sidecarPath = sessionLabelFilePath(dir, '1000')
    expect(path.basename(sidecarPath)).toBe(sessionLabelFileName('1000'))
    const raw = JSON.parse(await readFile(sidecarPath, 'utf8'))
    expect(raw).toEqual({ label: 'a label', labelledAt: 5000 })
  })

  it('trims whitespace around a label', async () => {
    await writeSessionLabel(dir, '1000', '  spaced out  ', 5000)
    expect(await readSessionLabel(dir, '1000')).toBe('spaced out')
  })

  it('refuses an empty (or whitespace-only) label', async () => {
    await expect(writeSessionLabel(dir, '1000', '   ', 5000)).rejects.toThrow(/empty/)
  })

  it('relabelling overwrites the previous label', async () => {
    await writeSessionLabel(dir, '1000', 'first pass', 5000)
    await writeSessionLabel(dir, '1000', 'second pass', 6000)
    expect(await readSessionLabel(dir, '1000')).toBe('second pass')
  })

  it('treats a malformed sidecar as unlabelled rather than throwing', async () => {
    await writeFile(sessionLabelFilePath(dir, '1000'), 'not json', 'utf8')
    expect(await readSessionLabel(dir, '1000')).toBeNull()
  })

  it('treats a sidecar missing its label field as unlabelled', async () => {
    await writeFile(sessionLabelFilePath(dir, '1000'), JSON.stringify({ labelledAt: 5000 }), 'utf8')
    expect(await readSessionLabel(dir, '1000')).toBeNull()
  })
})
