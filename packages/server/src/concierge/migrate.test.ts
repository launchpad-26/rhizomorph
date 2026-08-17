import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/worktree-slug.js'
import {
  MIGRATION_HEAD_BYTES,
  type MigrationPlan,
  MigrationSourceNotFoundError,
  MigrationSourceNotResumableError,
  planMigration,
  runMigration,
  SessionUnknownError,
} from './migrate.js'
import { MigrationFenceError } from './paths.js'

/**
 * prd-20 ruling 6 / ADR-0020's copy, tested against REAL directories from end
 * to end — no filesystem seam, no injected `copyFile`. Two reasons, and they
 * are the same two clause 5 and clause 6 of `namespace-law.test.ts` give:
 *
 * - The behaviour under test IS filesystem behaviour. `COPYFILE_EXCL`'s refusal,
 *   `mkdir`'s `EEXIST`-on-a-file, a symlinked slug directory and a canonicalized
 *   macOS temp path are all things a fake `copyFile` would agree to whatever the
 *   code did. A create-only guarantee proven against a stub is a claim.
 * - The one thing this module must never do is touch the operator's real
 *   `~/.claude`, and every root below is a `mkdtemp` this file also removes —
 *   `claudeProjectsRoot` is a parameter precisely so that is possible.
 *
 * `realpathSync` on the temp root because the fence canonicalizes the watched
 * repo before slugging it: on macOS `mkdtemp` hands back the `/var/…` spelling
 * of a `/private/var/…` directory and the two slug DIFFERENTLY, so a test
 * comparing against a raw-spelled expectation would pass vacuously on Linux and
 * fail on the macOS leg.
 */

const SESSION_ID = '200fb100-b3e2-4828-a3a6-01333a255127'
const OTHER_SESSION_ID = 'edf0eb2b-9c37-4d15-8f06-99e9306cdac6'
const LANE = 'conductor'

let root: string
let claudeProjectsRoot: string
let watchedRepoPath: string
let originRepoPath: string

function slugDir(repoPath: string): string {
  return path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoPath))
}

function transcriptIn(repoPath: string, sessionId: string = SESSION_ID): string {
  return path.join(slugDir(repoPath), `${sessionId}.jsonl`)
}

/** The event log's own attribution: this session id was seen in `worktreePath`. */
function sessionEvents(
  sessionId: string = SESSION_ID,
  worktreePath: string = originRepoPath,
): RhizomorphEvent[] {
  const f = createEventFactory()
  return [f.llmUsage({ lane: LANE, branch: LANE, sessionId, worktreePath })]
}

function context(events: readonly RhizomorphEvent[] = sessionEvents(), headBytes?: number) {
  return { events, claudeProjectsRoot, watchedRepoPath, ...(headBytes === undefined ? {} : { headBytes }) }
}

/** A real conversation turn, the shape the collector's own fixtures use. */
function userLine(text: string, sessionId: string = SESSION_ID): string {
  return JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: text } })
}

function assistantLine(text: string, sessionId: string = SESSION_ID): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  })
}

/**
 * The spike's degenerate specimen, verbatim in shape: metadata only, zero
 * conversation turns (`research/2026-08-14-cross-host-resume.md` Q2, the 278-byte
 * `a3a4ee6a` file whose resume failed with the same error a missing file gives).
 */
function stubLines(sessionId: string = SESSION_ID): string[] {
  return [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Review rhizomorph repo ⑂', sessionId }),
    JSON.stringify({ type: 'agent-name', agentName: 'Review rhizomorph repo ⑂', sessionId }),
  ]
}

async function writeTranscript(filePath: string, lines: readonly string[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, lines.map((line) => `${line}\n`).join(''))
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

beforeEach(async () => {
  root = realpathSync(await mkdtemp(path.join(tmpdir(), 'rhizomorph-concierge-migrate-')))
  claudeProjectsRoot = path.join(root, 'claude-projects')
  watchedRepoPath = path.join(root, 'watched-repo')
  originRepoPath = path.join(root, 'origin-repo')
  await mkdir(watchedRepoPath, { recursive: true })
  await mkdir(originRepoPath, { recursive: true })
  await writeTranscript(transcriptIn(originRepoPath), [userLine('the conversation that came from somewhere else')])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planMigration — the whole taxonomy, before a byte is written', () => {
  it('plans the one copy the power is for: the attributed transcript into the watched repo\'s slug dir', async () => {
    const plan = await planMigration(SESSION_ID, context())

    expect(plan).toEqual({
      kind: 'migrate',
      from: transcriptIn(originRepoPath),
      to: transcriptIn(watchedRepoPath),
    })
  })

  it('and writes nothing while planning it — the plan is a judgement, not the copy', async () => {
    await planMigration(SESSION_ID, context())
    await expect(stat(slugDir(watchedRepoPath))).rejects.toThrow()
  })

  it('takes no source and no destination path — an arbitrary file is unrepresentable, not merely refused', () => {
    // ADR-0020 point 2, asserted at this layer and not only at the fence's:
    // `(sessionId, context)`, and `context` carries two ROOTS, never a file.
    expect(planMigration.length).toBe(2)
  })

  describe('404 — the id, or its file, is not something this instrument has', () => {
    it('refuses a session the event log never named — SessionUnknownError', async () => {
      await expect(planMigration(SESSION_ID, context(sessionEvents(OTHER_SESSION_ID)))).rejects.toThrow(
        SessionUnknownError,
      )
      await expect(planMigration(SESSION_ID, context([]))).rejects.toThrow(/NO SUCH SESSION/)
    })

    it('refuses an attributed session with no transcript on disk — MigrationSourceNotFoundError, naming what it tried', async () => {
      await rm(transcriptIn(originRepoPath))

      const failure = planMigration(SESSION_ID, context())
      await expect(failure).rejects.toThrow(MigrationSourceNotFoundError)
      await expect(failure).rejects.toThrow(transcriptIn(originRepoPath))
    })

    it('and the two are DIFFERENT failures — an unknown id is not a missing file', async () => {
      // Both are 404s at the route, so nothing there would catch a collapse of
      // one into the other; the distinction is the whole reason for two classes.
      await rm(transcriptIn(originRepoPath))
      await expect(planMigration(SESSION_ID, context())).rejects.not.toBeInstanceOf(SessionUnknownError)
      await expect(planMigration(SESSION_ID, context([]))).rejects.not.toBeInstanceOf(MigrationSourceNotFoundError)
    })

    it('never reaches a well-named transcript the attribution did not derive', async () => {
      const elsewhere = path.join(root, 'elsewhere')
      await writeTranscript(path.join(elsewhere, `${SESSION_ID}.jsonl`), [userLine('someone else\'s history')])
      await rm(transcriptIn(originRepoPath))

      await expect(planMigration(SESSION_ID, context())).rejects.toThrow(MigrationSourceNotFoundError)
    })
  })

  describe('400 — the stub case: the file is there and cannot be resumed', () => {
    it('refuses a metadata-only transcript, and says what it actually is', async () => {
      await writeTranscript(transcriptIn(originRepoPath), stubLines())

      const failure = planMigration(SESSION_ID, context())
      await expect(failure).rejects.toThrow(MigrationSourceNotResumableError)
      // The message has to carry the reason, because the resume itself cannot:
      // the spike found `--resume` gives a stub the same "No conversation found"
      // it gives a MISSING file, which is why this check exists at all.
      await expect(failure).rejects.toThrow(/agent-name\/ai-title/)
      await expect(failure).rejects.toThrow(/No conversation found with session ID/)
    })

    it('refuses an empty transcript, and says that it is empty', async () => {
      await writeTranscript(transcriptIn(originRepoPath), [])
      await expect(planMigration(SESSION_ID, context())).rejects.toThrow(/the file is empty/)
    })

    it('accepts a transcript whose only turn is an ASSISTANT one — not just `user`', async () => {
      // Mutation this kills: narrowing the turn set to `['user']` alone. A
      // transcript can legitimately open on an assistant line (the spike's own
      // large specimen opens on `queue-operation` lines), and refusing that
      // would refuse a resumable conversation.
      await writeTranscript(transcriptIn(originRepoPath), [
        JSON.stringify({ type: 'queue-operation', sessionId: SESSION_ID }),
        assistantLine('resuming where we left off'),
      ])

      await expect(planMigration(SESSION_ID, context())).resolves.toMatchObject({ kind: 'migrate' })
    })

    it('skips a torn line rather than failing on it — one good turn is enough', async () => {
      await writeTranscript(transcriptIn(originRepoPath), ['{"type":"user", NOT JSON', userLine('the real turn')])
      await expect(planMigration(SESSION_ID, context())).resolves.toMatchObject({ kind: 'migrate' })
    })

    it('refuses a stub that is ALREADY home — the sibling case of not-needed', async () => {
      // The trap: a transcript already in the watched repo's slug dir needs no
      // copy, so a "nothing to do" answer looks right — and hands the operator
      // the resume's own indistinguishable failure a moment later. The
      // resumability check therefore runs BEFORE the not-needed branch.
      await rm(transcriptIn(originRepoPath))
      await writeTranscript(transcriptIn(watchedRepoPath), stubLines())

      await expect(planMigration(SESSION_ID, context(sessionEvents(SESSION_ID, watchedRepoPath)))).rejects.toThrow(
        MigrationSourceNotResumableError,
      )
    })

    it('reads a BOUNDED head — the same head, refused at a small cap and accepted at a larger one', async () => {
      const padding = JSON.stringify({ type: 'queue-operation', sessionId: SESSION_ID, filler: 'x'.repeat(4096) })
      await writeTranscript(transcriptIn(originRepoPath), [padding, userLine('the turn past the cap')])
      const paddingBytes = Buffer.byteLength(`${padding}\n`, 'utf8')

      // Mutation this kills: ignoring `headBytes` and always reading
      // MIGRATION_HEAD_BYTES (or the whole file) would find the turn here and
      // this expectation would fail.
      await expect(planMigration(SESSION_ID, context(sessionEvents(), paddingBytes))).rejects.toThrow(
        MigrationSourceNotResumableError,
      )
      await expect(
        planMigration(SESSION_ID, context(sessionEvents(), paddingBytes + 1024)),
      ).resolves.toMatchObject({ kind: 'migrate' })
    })

    it('and the default cap is big enough for a real transcript head', () => {
      expect(MIGRATION_HEAD_BYTES).toBeGreaterThanOrEqual(64 * 1024)
    })
  })

  describe('not-needed — the transcript is already where a resume in this repo looks', () => {
    it('answers not-needed rather than planning a copy onto itself', async () => {
      await rm(transcriptIn(originRepoPath))
      await writeTranscript(transcriptIn(watchedRepoPath), [userLine('this conversation began right here')])

      const plan = await planMigration(SESSION_ID, context(sessionEvents(SESSION_ID, watchedRepoPath)))
      expect(plan).toEqual({ kind: 'not-needed', at: transcriptIn(watchedRepoPath) })
    })

    it('and the fence would have REFUSED that case — which is why it is checked first', async () => {
      // `assertMigrationPaths`' clause 5 throws for source === destination. That
      // is correct for a fence (it is not a copy it may make) and wrong for a
      // caller (the operator is on the happy path), so the ordering here is
      // load-bearing rather than incidental. Proven by the same fixture
      // reaching the fence through a non-not-needed route: an EXISTING
      // destination beside a foreign source is clause 6's refusal, below.
      await rm(transcriptIn(originRepoPath))
      await writeTranscript(transcriptIn(watchedRepoPath), [userLine('already home')])
      await expect(
        planMigration(SESSION_ID, context(sessionEvents(SESSION_ID, watchedRepoPath))),
      ).resolves.not.toBeInstanceOf(Error)
    })
  })

  describe('403 — every plan passes through the fence, and the fence refuses', () => {
    it('refuses an existing destination — create-only, clause 6', async () => {
      await writeTranscript(transcriptIn(watchedRepoPath), ['someone else\'s history'])

      await expect(planMigration(SESSION_ID, context())).rejects.toThrow(MigrationFenceError)
      await expect(planMigration(SESSION_ID, context())).rejects.toThrow(/already exists/)
    })

    it('refuses a slug directory that is a symlink out of the projects root — clause 2', async () => {
      const outside = path.join(root, 'outside')
      await mkdir(outside, { recursive: true })
      await mkdir(claudeProjectsRoot, { recursive: true })
      await symlink(outside, slugDir(watchedRepoPath))

      await expect(planMigration(SESSION_ID, context())).rejects.toThrow(MigrationFenceError)
    })

    it('refuses a destination inside the watched repo — the clause that can never be relaxed', async () => {
      // A projects root INSIDE the watched repo. The source has to live under
      // that same root for the fence to be what refuses this — otherwise the
      // source lookup fails first and the answer is a 404 about a missing file
      // rather than a 403 about prd-20's one uncrossable line.
      const inside = path.join(watchedRepoPath, '.claude', 'projects')
      await writeTranscript(path.join(inside, worktreePathToProjectSlug(originRepoPath), `${SESSION_ID}.jsonl`), [
        userLine('a transcript already under the watched repo'),
      ])

      await expect(planMigration(SESSION_ID, { ...context(), claudeProjectsRoot: inside })).rejects.toThrow(
        MigrationFenceError,
      )
    })

    it('refuses a traversal-shaped session id that the log itself attributed', async () => {
      // The id reaches the fence from the EVENT LOG, not the wire, so the
      // route's own parse gate is not what protects this path — and `..` passes
      // `isSafeSessionId` (`path.basename('..')` is `'..'`), which is exactly
      // why the fence names the dot ids separately. The file is created so the
      // source lookup cannot be what refuses this instead.
      await writeTranscript(path.join(slugDir(originRepoPath), '...jsonl'), [userLine('a dot-named transcript')])

      await expect(planMigration('..', context(sessionEvents('..')))).rejects.toThrow(MigrationFenceError)
      await expect(planMigration('..', context(sessionEvents('..')))).rejects.toThrow(/not a bare session id/)
    })
  })
})

describe('runMigration — one directory, one create-only copy, and never a throw', () => {
  it('copies the transcript home, byte for byte, and leaves the origin untouched', async () => {
    const plan = await planMigration(SESSION_ID, context())
    const sourceBefore = await stat(transcriptIn(originRepoPath))
    const sourceHash = await sha256(transcriptIn(originRepoPath))

    const outcome = await runMigration(plan)

    expect(outcome).toEqual({ kind: 'migrated', at: transcriptIn(watchedRepoPath) })
    expect(await sha256(transcriptIn(watchedRepoPath))).toBe(sourceHash)

    // ADR-0020's whole safety argument: the origin stays a valid rollback, and
    // the origin process may still be appending to that exact file.
    const sourceAfter = await stat(transcriptIn(originRepoPath))
    expect(sourceAfter.size).toBe(sourceBefore.size)
    expect(sourceAfter.mtimeMs).toBe(sourceBefore.mtimeMs)
  })

  it('creates the slug directory it needs, on a machine that has never run Claude Code in this repo', async () => {
    // The fresh-machine case the concierge exists for: NO `~/.claude/projects`
    // at all. The source is then the second place `candidateTranscriptPaths`
    // offers — the transcript beside the worktree itself — so this also covers
    // the candidate the happy-path fixture never uses.
    await rm(claudeProjectsRoot, { recursive: true, force: true })
    await writeTranscript(path.join(originRepoPath, `${SESSION_ID}.jsonl`), [userLine('from a bare worktree')])
    await expect(stat(claudeProjectsRoot)).rejects.toThrow()

    const outcome = await runMigration(await planMigration(SESSION_ID, context()))

    expect(outcome).toEqual({ kind: 'migrated', at: transcriptIn(watchedRepoPath) })
    expect((await stat(slugDir(watchedRepoPath))).isDirectory()).toBe(true)
    expect(await sha256(transcriptIn(watchedRepoPath))).toBe(await sha256(path.join(originRepoPath, `${SESSION_ID}.jsonl`)))
  })

  describe('create-only, proven — the second run of the same plan', () => {
    it('reports already-present and does not overwrite a single byte', async () => {
      const plan = await planMigration(SESSION_ID, context())
      expect(await runMigration(plan)).toEqual({ kind: 'migrated', at: transcriptIn(watchedRepoPath) })

      // What the destination looks like once the RESUME has appended to it —
      // the spike's Q3: the copy is appended in place, so by the time a second
      // attempt arrives the destination is no longer a copy of the source. A
      // hash-equal-to-source assertion would be satisfied by a re-copy; this
      // one is not.
      await writeFile(
        transcriptIn(watchedRepoPath),
        `${userLine('the conversation that came from somewhere else')}\n${assistantLine('and continued here')}\n`,
      )
      const before = await sha256(transcriptIn(watchedRepoPath))

      const second = await runMigration(plan)

      expect(second).toEqual({ kind: 'already-present', at: transcriptIn(watchedRepoPath) })
      expect(await sha256(transcriptIn(watchedRepoPath))).toBe(before)
    })

    it('and the destination it reports is the same one it refused to write', async () => {
      const plan = await planMigration(SESSION_ID, context())
      await runMigration(plan)
      const outcome = await runMigration(plan)
      expect(outcome).toEqual({ kind: 'already-present', at: (plan as { to: string }).to })
    })
  })

  describe('copy-failed — a real I/O failure, and the EEXIST that is NOT already-present', () => {
    it('reports a source that vanished between the plan and the copy', async () => {
      // The honest TOCTOU the plan/run split cannot close, exercised for real
      // rather than through an injected error.
      const plan = await planMigration(SESSION_ID, context())
      await rm(transcriptIn(originRepoPath))

      const outcome = await runMigration(plan)

      expect(outcome.kind).toBe('copy-failed')
      expect((outcome as { message: string }).message).toContain('ENOENT')
      expect((outcome as { message: string }).message).toContain(transcriptIn(originRepoPath))
    })

    it('reports a slug path occupied by a FILE as copy-failed, never as already-present', async () => {
      // The sibling case: `mkdir` fails with EEXIST when the path exists and is
      // not a directory, and `copyFile`'s EEXIST is the good-news one. A single
      // catch around both would report a broken destination as success — the
      // resume would then find nothing and the operator would be told the
      // transcript was already there.
      await mkdir(claudeProjectsRoot, { recursive: true })
      await writeFile(slugDir(watchedRepoPath), 'not a directory\n')
      const plan: MigrationPlan = {
        kind: 'migrate',
        from: transcriptIn(originRepoPath),
        to: transcriptIn(watchedRepoPath),
      }

      const outcome = await runMigration(plan)

      expect(outcome.kind).toBe('copy-failed')
      expect((outcome as { message: string }).message).toContain(slugDir(watchedRepoPath))
    })

    it('never throws — every failure is a value the caller can put in a response body', async () => {
      const plan: MigrationPlan = {
        kind: 'migrate',
        from: path.join(root, 'no-such-file.jsonl'),
        to: path.join(root, 'no-such-dir', 'target.jsonl'),
      }
      await expect(runMigration(plan)).resolves.toMatchObject({ kind: 'copy-failed' })
    })
  })

  it('passes a not-needed plan straight through, touching nothing', async () => {
    await rm(transcriptIn(originRepoPath))
    await writeTranscript(transcriptIn(watchedRepoPath), [userLine('already home')])
    const plan = await planMigration(SESSION_ID, context(sessionEvents(SESSION_ID, watchedRepoPath)))
    const before = await sha256(transcriptIn(watchedRepoPath))

    const outcome = await runMigration(plan)

    expect(outcome).toEqual({ kind: 'not-needed', at: transcriptIn(watchedRepoPath) })
    expect(await sha256(transcriptIn(watchedRepoPath))).toBe(before)
  })
})
