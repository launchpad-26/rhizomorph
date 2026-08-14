import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertValidCloneUrl,
  type CloneEvent,
  CloneDestinationExistsError,
  CloneValidationError,
  deriveCloneName,
  parseCloneRequestBody,
  planClone,
  runClone,
  type SpawnedProcess,
  splitProgressLines,
} from './clone.js'
import { CloneFenceError } from './paths.js'

describe('parseCloneRequestBody', () => {
  it('accepts a body carrying only url', () => {
    expect(parseCloneRequestBody({ url: 'https://github.com/owner/repo.git' })).toEqual({
      url: 'https://github.com/owner/repo.git',
    })
  })

  it('refuses a non-object body', () => {
    expect(() => parseCloneRequestBody(null)).toThrow(CloneValidationError)
    expect(() => parseCloneRequestBody('https://x')).toThrow(CloneValidationError)
  })

  it('refuses a non-string url', () => {
    expect(() => parseCloneRequestBody({ url: 123 })).toThrow(CloneValidationError)
    expect(() => parseCloneRequestBody({})).toThrow(CloneValidationError)
  })
})

describe('assertValidCloneUrl', () => {
  it('accepts the URL shapes git clone itself accepts', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'http://example.com/repo',
      'ssh://git@example.com/owner/repo.git',
      'git://example.com/repo.git',
      'git@github.com:owner/repo.git',
    ]) {
      expect(() => assertValidCloneUrl(url)).not.toThrow()
    }
  })

  it('refuses an empty or whitespace-only string', () => {
    expect(() => assertValidCloneUrl('')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('   ')).toThrow(CloneValidationError)
  })

  it('refuses control characters or embedded whitespace — a URL is one token, not a command line', () => {
    expect(() => assertValidCloneUrl('https://example.com/repo\n--upload-pack=touch pwned')).toThrow(
      CloneValidationError,
    )
    expect(() => assertValidCloneUrl('https://example.com/re po')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('https://example.com/repo\x00')).toThrow(CloneValidationError)
  })

  it('refuses a flag-shaped url — the lab.ts defence-in-depth precedent', () => {
    expect(() => assertValidCloneUrl('--upload-pack=touch /tmp/pwned')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('-oProxyCommand=evil')).toThrow(CloneValidationError)
  })

  it('refuses a URL with an embedded credential — it would leak to every other local process via ps/proc', () => {
    expect(() => assertValidCloneUrl('https://user:ghp_secrettoken@github.com/owner/repo.git')).toThrow(
      CloneValidationError,
    )
    expect(() => assertValidCloneUrl('http://admin:hunter2@internal.example/repo.git')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('ssh://user:password@example.com/owner/repo.git')).toThrow(CloneValidationError)
  })

  it('refuses a token carried as a BARE username over http(s) — the colon-less leak the password check misses', () => {
    // GitHub and GitLab both accept a PAT as the URL username with no password,
    // so `https://<token>@host/…` leaks the token to ps/proc exactly as the
    // `user:pass@` form does — but carries no `:` for the password check to catch.
    expect(() => assertValidCloneUrl('https://ghp_secrettoken@github.com/owner/repo.git')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('https://glpat-secret@gitlab.com/owner/repo.git')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('http://tok@internal.example/repo.git')).toThrow(CloneValidationError)
  })

  it('does not confuse a bare SSH username (no password) for an embedded credential', () => {
    // `git@host` and the scp-like form carry no secret — auth is by key, not by a password in the URL.
    // Only the http(s) userinfo refusal is scheme-gated; the SSH login name stays legal.
    expect(() => assertValidCloneUrl('ssh://git@example.com/owner/repo.git')).not.toThrow()
    expect(() => assertValidCloneUrl('git@github.com:owner/repo.git')).not.toThrow()
  })

  it('refuses a scheme git clone does not accept, and a bare path', () => {
    expect(() => assertValidCloneUrl('file:///etc/passwd')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('/etc/passwd')).toThrow(CloneValidationError)
    expect(() => assertValidCloneUrl('javascript:alert(1)')).toThrow(CloneValidationError)
  })
})

describe('deriveCloneName', () => {
  it('strips a .git suffix off an https URL', () => {
    expect(deriveCloneName('https://github.com/owner/repo.git')).toBe('repo')
  })

  it('works without a .git suffix', () => {
    expect(deriveCloneName('https://github.com/owner/repo')).toBe('repo')
  })

  it('ignores a trailing slash', () => {
    expect(deriveCloneName('https://github.com/owner/repo/')).toBe('repo')
  })

  it('reads the scp-like form the same way', () => {
    expect(deriveCloneName('git@github.com:owner/repo.git')).toBe('repo')
  })

  it('sanitizes characters outside the safe set', () => {
    expect(deriveCloneName('https://example.com/owner/my repo!.git')).toBe('my-repo')
  })

  it('refuses a URL with nothing nameable at the end', () => {
    // A segment that is only punctuation sanitizes down to nothing.
    expect(() => deriveCloneName('https://github.com/owner/---.git')).toThrow(CloneValidationError)
    // The whole last segment IS the .git suffix — stripping it leaves nothing.
    expect(() => deriveCloneName('https://github.com/.git')).toThrow(CloneValidationError)
  })
})

describe('planClone', () => {
  let root: string
  let clonesRoot: string
  let watchedRepoPath: string
  let dataRoot: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-clone-plan-test-'))
    clonesRoot = path.join(root, 'clones')
    watchedRepoPath = path.join(root, 'watched-repo')
    dataRoot = path.join(root, 'data')
    await mkdir(clonesRoot, { recursive: true })
    await mkdir(watchedRepoPath, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('plans a candidate under clonesRoot, named from the url', async () => {
    const plan = await planClone('https://github.com/owner/repo.git', {
      watchedRepoPath,
      clonesRoot,
      dataRoot,
      claimDestination: async () => true,
    })
    expect(plan).toEqual({ clonesRoot, candidate: path.join(clonesRoot, 'repo') })
  })

  it('refuses a malformed url before ever checking the fence or the filesystem', async () => {
    const claimDestination = vi.fn(async () => true)
    await expect(
      planClone('not a url', { watchedRepoPath, clonesRoot, dataRoot, claimDestination }),
    ).rejects.toThrow(CloneValidationError)
    expect(claimDestination).not.toHaveBeenCalled()
  })

  it('refuses a clone root that overlaps the watched repo — assertCloneTarget wired for real', async () => {
    await expect(
      planClone('https://github.com/owner/repo.git', {
        watchedRepoPath,
        clonesRoot: path.join(watchedRepoPath, 'clones'),
        dataRoot,
        claimDestination: async () => true,
      }),
    ).rejects.toThrow(CloneFenceError)
  })

  it('refuses a destination whose claim fails (already occupied) — no silent overwrite', async () => {
    await expect(
      planClone('https://github.com/owner/repo.git', {
        watchedRepoPath,
        clonesRoot,
        dataRoot,
        claimDestination: async () => false,
      }),
    ).rejects.toThrow(CloneDestinationExistsError)
  })

  describe('the real claim — atomic against a genuine race, not just a mocked one', () => {
    it('mkdir-based claim: one of two concurrent requests for the same URL wins, the other is refused', async () => {
      // The bug this closes: an `exists()`-then-decide check has a window
      // between the two where a second concurrent request can slip through.
      // No `claimDestination` override here — this drives the REAL
      // filesystem claim (`mkdir`) both calls default to, racing them via
      // `Promise.allSettled` so neither gets a head start.
      const results = await Promise.allSettled([
        planClone('https://github.com/owner/racer.git', { watchedRepoPath, clonesRoot, dataRoot }),
        planClone('https://github.com/owner/racer.git', { watchedRepoPath, clonesRoot, dataRoot }),
      ])

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof planClone>>> =>
        r.status === 'fulfilled',
      )
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(CloneDestinationExistsError)
      expect(fulfilled[0]?.value.candidate).toBe(path.join(clonesRoot, 'racer'))
    })
  })
})

describe('splitProgressLines', () => {
  it('splits on a bare \\n', () => {
    expect(splitProgressLines('', 'line one\nline two\n')).toEqual({ lines: ['line one', 'line two'], remainder: '' })
  })

  it('splits on a bare \\r — the shape git\'s own progress meter redraws with', () => {
    expect(splitProgressLines('', 'Receiving objects: 10%\rReceiving objects: 20%\rReceiving objects: 30%')).toEqual({
      lines: ['Receiving objects: 10%', 'Receiving objects: 20%'],
      remainder: 'Receiving objects: 30%',
    })
  })

  it('treats \\r\\n as one terminator, not two', () => {
    expect(splitProgressLines('', 'line one\r\nline two\r\n')).toEqual({ lines: ['line one', 'line two'], remainder: '' })
  })

  it('carries an unterminated tail forward across chunks', () => {
    const first = splitProgressLines('', 'Enumerating obj')
    expect(first).toEqual({ lines: [], remainder: 'Enumerating obj' })
    const second = splitProgressLines(first.remainder, 'ects: 100%, done.\n')
    expect(second).toEqual({ lines: ['Enumerating objects: 100%, done.'], remainder: '' })
  })

  it('drops empty segments rather than surfacing a blank progress line', () => {
    expect(splitProgressLines('', '\r\r\n\n')).toEqual({ lines: [], remainder: '' })
  })
})

/** A fake child process good enough for `runClone` — real streams, an `EventEmitter` for close/error. */
type FakeChild = SpawnedProcess & {
  stdout: PassThrough
  stderr: PassThrough
  emitClose: (code: number | null) => void
  emitError: (err: Error) => void
}

function fakeChild(): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const child = {
    stdout,
    stderr,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
      return child
    },
    emitClose: (code: number | null) => emitter.emit('close', code),
    emitError: (err: Error) => emitter.emit('error', err),
  }
  return child as unknown as FakeChild
}

describe('runClone', () => {
  const plan = { clonesRoot: '/clones', candidate: '/clones/repo' }

  /**
   * Drives `runClone` against `child` and collects every event it yields.
   * `drive` fires after the generator has started consuming (so writes to
   * `child`'s streams and `emitClose`/`emitError` land on live listeners),
   * and the returned promise resolves once the generator itself completes —
   * one line per test in place of the same four-line IIFE-and-array
   * boilerplate repeated across all six cases below.
   */
  async function runAndCollect(
    child: FakeChild,
    drive: (child: FakeChild) => void | Promise<void>,
    options: { removeDirectory?: (candidate: string) => Promise<void> } = {},
  ): Promise<CloneEvent[]> {
    const events: CloneEvent[] = []
    const generator = runClone('https://example.com/repo.git', plan, { spawnGit: () => child, ...options })
    const consumed = (async () => {
      for await (const event of generator) events.push(event)
    })()
    await drive(child)
    await consumed
    return events
  }

  /** Yields to the event loop so a stream `write` is delivered before the caller emits `close`/`error`. */
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  it('streams progress lines and ends with done on a clean exit', async () => {
    const removeDirectory = vi.fn(async () => {})
    const events = await runAndCollect(
      fakeChild(),
      async (child) => {
        child.stderr.write('Receiving objects: 50%\r')
        child.stderr.write('Receiving objects: 100%, done.\n')
        await flush()
        child.emitClose(0)
      },
      { removeDirectory },
    )

    expect(events).toEqual([
      { type: 'progress', line: 'Receiving objects: 50%' },
      { type: 'progress', line: 'Receiving objects: 100%, done.' },
      { type: 'done', path: '/clones/repo' },
    ])
    expect(removeDirectory).not.toHaveBeenCalled()
  })

  it('flushes an unterminated final line at close', async () => {
    const events = await runAndCollect(fakeChild(), async (child) => {
      child.stderr.write("Cloning into 'repo'...")
      await flush()
      child.emitClose(0)
    })

    expect(events).toEqual([
      { type: 'progress', line: "Cloning into 'repo'..." },
      { type: 'done', path: '/clones/repo' },
    ])
  })

  it('reports a non-zero exit as an error, and cleans up the partial destination', async () => {
    const removeDirectory = vi.fn(async () => {})
    const events = await runAndCollect(fakeChild(), (child) => child.emitClose(128), { removeDirectory })

    expect(events).toEqual([{ type: 'error', message: 'git clone exited with code 128' }])
    expect(removeDirectory).toHaveBeenCalledWith('/clones/repo')
  })

  it('reports a failed spawn (git not installed) as an error, and cleans up', async () => {
    const removeDirectory = vi.fn(async () => {})
    const events = await runAndCollect(
      fakeChild(),
      (child) => child.emitError(new Error('spawn git ENOENT')),
      { removeDirectory },
    )

    expect(events).toEqual([{ type: 'error', message: 'could not start git: spawn git ENOENT' }])
    expect(removeDirectory).toHaveBeenCalledWith('/clones/repo')
  })

  it('never removes anything on success', async () => {
    const removeDirectory = vi.fn(async () => {})
    await runAndCollect(fakeChild(), (child) => child.emitClose(0), { removeDirectory })

    expect(removeDirectory).not.toHaveBeenCalled()
  })

  it('ignores a close after an error has already settled the outcome — no double-terminal event', async () => {
    const events = await runAndCollect(fakeChild(), (child) => {
      child.emitError(new Error('spawn git ENOENT'))
      child.emitClose(null) // Node can fire both after a failed spawn
    })

    expect(events).toEqual([{ type: 'error', message: 'could not start git: spawn git ENOENT' }])
  })
})
