import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  repoSlug,
  sessionDirFor,
  sessionFileName,
  sessionIdFromFileName,
  sessionLabelFileName,
  snapshotDirFor,
} from './paths.js'

describe('repoSlug', () => {
  it('combines a sanitized basename with a short hash of the absolute path', () => {
    const slug = repoSlug('/home/operator/repos/Rhizomorph')
    expect(slug).toMatch(/^rhizomorph-[0-9a-f]{8}$/)
  })

  it('is stable for the same path and differs for different paths', () => {
    expect(repoSlug('/a/repo')).toBe(repoSlug('/a/repo'))
    expect(repoSlug('/a/repo')).not.toBe(repoSlug('/b/repo'))
  })

  it('gives two same-named repos in different locations different slugs', () => {
    expect(repoSlug('/one/place/app')).not.toBe(repoSlug('/other/place/app'))
  })
})

describe('sessionDirFor', () => {
  it('nests the repo slug under the given data root', () => {
    const dir = sessionDirFor('/a/repo', '/data/root')
    expect(dir).toBe(path.join('/data/root', repoSlug('/a/repo')))
  })
})

describe('session filenames', () => {
  it('round-trips a timestamp through the filename', () => {
    const name = sessionFileName(1700000000000)
    expect(name).toBe('session-1700000000000.jsonl')
    expect(sessionIdFromFileName(name)).toBe('1700000000000')
  })

  it('rejects names that are not session files', () => {
    expect(sessionIdFromFileName('not-a-session.jsonl')).toBeNull()
    expect(sessionIdFromFileName('session-abc.jsonl')).toBeNull()
  })
})

describe('sessionLabelFileName', () => {
  it('names the sidecar beside the session log, never the log itself', () => {
    expect(sessionLabelFileName('1700000000000')).toBe('session-1700000000000.label.json')
    expect(sessionLabelFileName('1700000000000')).not.toBe(sessionFileName(1700000000000))
  })
})

describe('snapshotDirFor', () => {
  it('keys snapshots by session id, under a snapshots/ level beside the logs', () => {
    expect(snapshotDirFor('/data/root/repo-1234abcd', '1700000000000')).toBe(
      path.join('/data/root/repo-1234abcd', 'snapshots', '1700000000000'),
    )
  })

  it('gives two sessions separate directories, so an abandoned session cannot feed a new one', () => {
    expect(snapshotDirFor('/dir', '1')).not.toBe(snapshotDirFor('/dir', '2'))
  })

  it('never produces a name listSessions would mistake for a session file', () => {
    expect(sessionIdFromFileName(path.basename(snapshotDirFor('/dir', '1700000000000')))).toBeNull()
    expect(sessionIdFromFileName('snapshots')).toBeNull()
  })
})
