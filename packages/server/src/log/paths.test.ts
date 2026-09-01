import { homedir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DATA_ROOT_ENV_VAR,
  defaultDataRoot,
  repoSlug,
  sessionDirFor,
  sessionFileName,
  sessionIdFromFileName,
  sessionLabelFileName,
  snapshotDirFor,
  transcriptCaptureDir,
  transcriptCaptureFileName,
} from './paths.js'

/**
 * The historical root, spelled out rather than re-derived from the function
 * under test. Every one of `defaultDataRoot()`'s callers already has data on
 * disk at this path, so "unset behaves as before" is the load-bearing claim
 * here — a mutation that renamed any one of these three segments has to fail.
 */
const HISTORICAL_ROOT = path.join(homedir(), '.local', 'share', 'rhizomorph')

describe('defaultDataRoot', () => {
  let savedOverride: string | undefined
  let savedXdg: string | undefined

  beforeEach(() => {
    savedOverride = process.env[DATA_ROOT_ENV_VAR]
    savedXdg = process.env.XDG_DATA_HOME
    delete process.env[DATA_ROOT_ENV_VAR]
    delete process.env.XDG_DATA_HOME
  })

  afterEach(() => {
    if (savedOverride === undefined) delete process.env[DATA_ROOT_ENV_VAR]
    else process.env[DATA_ROOT_ENV_VAR] = savedOverride
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = savedXdg
  })

  it('is the historical path when nothing overrides it', () => {
    expect(defaultDataRoot()).toBe(HISTORICAL_ROOT)
  })

  it('honours the override, using the value as given', () => {
    process.env[DATA_ROOT_ENV_VAR] = '/spikes/copied-data-dir'
    expect(defaultDataRoot()).toBe('/spikes/copied-data-dir')
  })

  // Unset and empty are different facts about intent and the same fact about a
  // path: `RHIZOMORPH_DATA_DIR=` names no directory. Without this branch an
  // empty value would return '', and `sessionDirFor` would then quietly root a
  // whole installation at the process's cwd.
  it('treats an empty override as no override, not as a root of ""', () => {
    process.env[DATA_ROOT_ENV_VAR] = ''
    expect(defaultDataRoot()).toBe(HISTORICAL_ROOT)
    expect(sessionDirFor('/a/repo')).toBe(path.join(HISTORICAL_ROOT, repoSlug('/a/repo')))
  })

  it('ignores XDG_DATA_HOME, so a box that sets it still finds yesterday\'s logs', () => {
    process.env.XDG_DATA_HOME = '/xdg/data'
    expect(defaultDataRoot()).toBe(HISTORICAL_ROOT)
  })

  it('lets XDG_DATA_HOME lose to the real override rather than racing it', () => {
    process.env.XDG_DATA_HOME = '/xdg/data'
    process.env[DATA_ROOT_ENV_VAR] = '/spikes/copied-data-dir'
    expect(defaultDataRoot()).toBe('/spikes/copied-data-dir')
  })
})

describe('defaultDataRoot precedence against an explicit argument', () => {
  let savedOverride: string | undefined

  beforeEach(() => {
    savedOverride = process.env[DATA_ROOT_ENV_VAR]
    process.env[DATA_ROOT_ENV_VAR] = '/spikes/copied-data-dir'
  })

  afterEach(() => {
    if (savedOverride === undefined) delete process.env[DATA_ROOT_ENV_VAR]
    else process.env[DATA_ROOT_ENV_VAR] = savedOverride
  })

  // The eight existing call sites all read `options.dataRoot ?? defaultDataRoot()`.
  // If the variable outranked the argument, every one of them would start
  // ignoring a directory it was explicitly handed — so the argument wins, and
  // the variable only answers "where is the root when nobody named one".
  it('an explicit dataRoot still wins — the variable answers only for callers who named none', () => {
    expect(sessionDirFor('/a/repo', '/explicit/root')).toBe(
      path.join('/explicit/root', repoSlug('/a/repo')),
    )
  })

  it('and a caller who names none follows the override', () => {
    expect(sessionDirFor('/a/repo')).toBe(
      path.join('/spikes/copied-data-dir', repoSlug('/a/repo')),
    )
  })
})

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

describe('transcriptCaptureDir', () => {
  it('keys captures by session id, under a transcripts/ level beside the logs', () => {
    expect(transcriptCaptureDir('/data/root/repo-1234abcd', '1700000000000')).toBe(
      path.join('/data/root/repo-1234abcd', 'transcripts', '1700000000000'),
    )
  })

  it('gives two sessions separate directories', () => {
    expect(transcriptCaptureDir('/dir', '1')).not.toBe(transcriptCaptureDir('/dir', '2'))
  })

  it('never produces a name listSessions would mistake for a session file', () => {
    expect(sessionIdFromFileName(path.basename(transcriptCaptureDir('/dir', '1700000000000')))).toBeNull()
    expect(sessionIdFromFileName('transcripts')).toBeNull()
  })
})

describe('transcriptCaptureFileName', () => {
  it('names a captured lane by the Claude Code session id it was tailing', () => {
    expect(transcriptCaptureFileName('sess-84')).toBe('sess-84.jsonl')
  })
})
