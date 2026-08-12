import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, eventsToJsonl, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor, sessionFileName } from '../log/paths.js'
import { runExportRecord } from './export-record.js'

// #299: `path.resolve` does not canonicalise symlinks, so an `--out` that is
// textually outside the watched repo but is a symlink pointing inside it must
// still be refused. The non-force path is already refused by the `wx` write
// flag (#298) regardless of this containment check, so every case here passes
// `force: true` — a test that omits it would pass vacuously and prove nothing
// about the containment law itself.

async function writeSessionFile(sessionDir: string, ts: number, events: readonly RhizomorphEvent[]): Promise<void> {
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(sessionDir, sessionFileName(ts)), eventsToJsonl(events), 'utf8')
}

function sessionEvents(ts: number, sessionId: string): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: ts, stepMs: 1000 })
  f.sessionStarted({ sessionId, repoPath: '/repo', repoName: 'repo' })
  f.agentStatus({ handle: 'worker-1', status: 'working' })
  return f.all()
}

describe('runExportRecord — symlink containment (#299)', () => {
  let root: string
  let dataRoot: string
  let repoPath: string
  let outsideDir: string

  beforeEach(async () => {
    // A dedicated root, not the bare OS tmpdir, so the repo, the symlink and
    // its target all sit under one canonicalisable prefix — and so a real
    // ancestor exists on both ubuntu and macOS regardless of whether tmpdir
    // itself is a symlink (`/var` -> `/private/var` on macOS).
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-export-record-containment-'))
    dataRoot = path.join(root, 'data')
    repoPath = path.join(root, 'repo')
    outsideDir = path.join(root, 'outside')
    await mkdir(repoPath, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const sessionDir = sessionDirFor(repoPath, dataRoot)
    await writeSessionFile(sessionDir, 1000, sessionEvents(1000, '1000'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a symlinked --out whose target does not exist yet but resolves inside the repo', async () => {
    // The exploitable variant proven in the issue: no file at the link target
    // yet, so a raw `stat`/`path.resolve` check has nothing to canonicalise.
    const link = path.join(outsideDir, 'dangling-link')
    const linkTarget = path.join(repoPath, 'leaked-record.json')
    await symlink(linkTarget, link)

    await expect(runExportRecord({ repoPath, dataRoot, out: link, force: true })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )

    await expect(readFile(linkTarget, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('refuses a symlinked --out whose target already exists inside the repo', async () => {
    const linkTarget = path.join(repoPath, 'leaked-record.json')
    await writeFile(linkTarget, 'pre-existing', 'utf8')
    const link = path.join(outsideDir, 'existing-link')
    await symlink(linkTarget, link)

    await expect(runExportRecord({ repoPath, dataRoot, out: link, force: true })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )

    // Refused before the write, not merely refused to overwrite: the
    // pre-existing content must be untouched, not replaced with an exported
    // record.
    expect(await readFile(linkTarget, 'utf8')).toBe('pre-existing')
  })

  it('names the canonical repo-relative path in the refusal, not the symlink path', async () => {
    const link = path.join(outsideDir, 'dangling-link')
    const linkTarget = path.join(repoPath, 'leaked-record.json')
    await symlink(linkTarget, link)

    await expect(runExportRecord({ repoPath, dataRoot, out: link, force: true })).rejects.toThrow(
      new RegExp(linkTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  it('still allows a symlinked --out whose target resolves outside the repo', async () => {
    const realTargetDir = path.join(outsideDir, 'real-target-dir')
    await mkdir(realTargetDir, { recursive: true })
    const link = path.join(outsideDir, 'safe-link')
    await symlink(realTargetDir, link)
    const out = path.join(link, 'exported.json')

    const { outPath, record } = await runExportRecord({ repoPath, dataRoot, out, force: true })

    expect(outPath).toBe(out)
    const onDisk = JSON.parse(await readFile(path.join(realTargetDir, 'exported.json'), 'utf8'))
    expect(onDisk.manifest.eventCount).toBe(record.manifest.eventCount)
  })

  it('keeps refusing a symlinked --out without --force — the containment law now catches it directly', async () => {
    // Before this fix, the non-force path was refused only as a side effect
    // of the `wx` overwrite guard (which independently refuses through any
    // symlink). The containment check now refuses it on its own terms too, so
    // the two guards agree instead of one silently covering for the other.
    const link = path.join(outsideDir, 'dangling-link-no-force')
    const linkTarget = path.join(repoPath, 'leaked-record.json')
    await symlink(linkTarget, link)

    await expect(runExportRecord({ repoPath, dataRoot, out: link })).rejects.toThrow(
      /refusing to write.*inside the watched repo/is,
    )

    await expect(readFile(linkTarget, 'utf8')).rejects.toThrow(/ENOENT/)
  })
})
