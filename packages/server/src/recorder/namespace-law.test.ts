import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
import { readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { writeSessionLock } from '../log/session-lock.js'
import { rotateSession } from './rotate.js'
import { SessionRecorder } from './session-recorder.js'

/**
 * THE RECORDER NAMESPACE LAW — prd16 ruling 2's own condition, in the shape of
 * `lab/namespace-law.test.ts`: "the existing readonly greps stay green
 * untouched; a new rotation-namespace test asserts every write path of this
 * hand lands under the data directory and nowhere else."
 *
 * The constitution now has three hands. The observer is absolutely read-only
 * over the watched repo; the laboratory is an explicitly-invoked second actor
 * inside `refs/rhizomorph/`; this, the third and narrowest, may end one
 * recording and begin another — inside
 * `~/.local/share/rhizomorph/<repo>/` and nowhere else. It never touches the
 * watched repo, never a ref, never a worktree, never `~/.claude`.
 *
 * Four halves:
 *
 * 1. The module's filesystem surface is ONE file. Every direct write in
 *    `recorder/` lives in `session-log-writer.ts`; rotation's only other write
 *    is the lock sidecar, through `log/session-lock.ts`, which builds its path
 *    from the session dir it is handed. Nothing here names a home directory, a
 *    ref, `~/.claude`, or a way to run a command.
 * 2. Rotation is reachable ONLY from an explicit operator entry point. No
 *    collector, no poll loop, no web file. The one allowed importer is named
 *    below rather than silently excluded.
 * 3. The recorder has no clock of its own — no `setInterval`/`setTimeout`
 *    anywhere under `recorder/` — so "never rotates without a human's explicit
 *    command" holds structurally, not just by convention.
 * 4. A live pass of the whole write surface: a real rotation against a real
 *    git repo, a real data dir and a stand-in `~/.claude/projects`, asserted
 *    by hashing the entire tree before and after. Halves 1–3 can be fooled by
 *    a clever spelling; this one runs the thing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/server/src/recorder -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')
const WEB_SRC = path.join(REPO_ROOT, 'packages', 'web', 'src')
const RECORDER_DIR = path.join(SERVER_SRC, 'recorder')

/**
 * The one file allowed to reach rotation: the mutating API route the CLI verb
 * and the dashboard button both go through. `cli/index.ts` is deliberately NOT
 * here — `rhizomorph rotate` asks the running server over HTTP rather than
 * closing a log another process is writing (see `cli/rotate.ts`), so the CLI
 * never holds a reference to this hand at all.
 */
const ALLOWED_ROTATION_CALLERS = new Set([path.join(SERVER_SRC, 'api', 'rotate.ts')])

/** The only file inside the module that may touch the filesystem directly. */
const THE_WRITER = path.join(RECORDER_DIR, 'session-log-writer.ts')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function walkSourceFiles(dir: string, exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude.map((p) => path.resolve(p)))
  const out: string[] = []

  const visit = (current: string) => {
    if (excluded.has(path.resolve(current))) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (excluded.has(path.resolve(full))) continue
      const info = statSync(full)
      if (info.isDirectory()) {
        visit(full)
      } else if (SOURCE_EXTENSIONS.has(path.extname(full))) {
        out.push(full)
      }
    }
  }

  visit(dir)
  return out
}

function isTest(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

function recorderSourceFiles(): string[] {
  return walkSourceFiles(RECORDER_DIR).filter((file) => !isTest(file))
}

/**
 * A file's CODE, with comments removed. The law is about what the module
 * does, and the module's own doc comments legitimately *name* the things it
 * must never touch (`never a ref, never a worktree, never ~/.claude`) — the
 * same false positive the lab law solved for git verbs by matching argv
 * position. Crude on purpose (a `//` inside a string literal would truncate
 * its line; the module has none) and legible by eye, like every check here.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/**
 * The first argument of a call, by paren depth — so
 * `mkdir(path.dirname(this.filePath), …)` reads as one expression rather than
 * being cut at its inner comma.
 */
function firstArguments(code: string, callee: RegExp): string[] {
  const out: string[] = []
  for (const match of code.matchAll(callee)) {
    let depth = 0
    let start = (match.index ?? 0) + match[0].length
    let end = start
    for (; end < code.length; end += 1) {
      const char = code[end]
      if (char === '(' || char === '[') depth += 1
      else if (char === ']') depth -= 1
      else if (char === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (char === ',' && depth === 0) break
    }
    out.push(code.slice(start, end).trim())
  }
  return out
}

/** Every way a Node program writes to, moves or removes a path. */
const WRITE_CALL_RE =
  /\b(?:writeFile|appendFile|mkdir|mkdtemp|rmdir|unlink|rename|truncate|createWriteStream|copyFile|open|chmod|utimes)\s*\(/g

/** Reaching rotation, by the name of one of its entry points. */
const ROTATION_ENTRY_RE = /\b(?:rotateSession|closeCurrentSession|openNextSession)\b/

describe('the recorder namespace law (prd16 ruling 2)', () => {
  describe('the module writes through exactly one file, and names nothing outside the data dir', () => {
    it('has source files to check at all — an empty grep proves nothing', () => {
      expect(recorderSourceFiles().length).toBeGreaterThan(3)
    })

    it('every direct filesystem write in the module lives in the log writer', () => {
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        if (path.resolve(file) === path.resolve(THE_WRITER)) continue
        for (const match of codeOf(file).matchAll(WRITE_CALL_RE)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('the writer itself writes only to the file path it was handed', () => {
      // Every write call's first argument is the path the recorder gave this
      // writer (or its dirname) — and rotation only ever builds those from the
      // session dir. A write to any other expression is what this catches.
      const ALLOWED_TARGETS = new Set(['this.filePath', 'path.dirname(this.filePath)', 'filePath'])
      const targets = firstArguments(
        codeOf(THE_WRITER),
        /\b(?:writeFile|appendFile|truncate|mkdir|open|rename|unlink)\s*\(/g,
      )
      expect(targets.length).toBeGreaterThan(0)
      expect(targets.filter((target) => !ALLOWED_TARGETS.has(target))).toEqual([])
    })

    it('names no home directory, no ref, no ~/.claude, and no way to run a command', () => {
      const forbidden: Array<{ what: string; pattern: RegExp }> = [
        { what: 'a home directory', pattern: /\bhomedir\s*\(|process\.env\.HOME/ },
        { what: 'a git ref', pattern: /refs\// },
        { what: "Claude Code's own directory", pattern: /\.claude\b/ },
        { what: 'a git worktree', pattern: /\bworktree/i },
        { what: 'an execution channel', pattern: /child_process|\bexec\w*\s*\(|\bspawn\w*\s*\(/ },
        { what: 'the default data root', pattern: /defaultDataRoot/ },
      ]
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        const code = codeOf(file)
        for (const { what, pattern } of forbidden) {
          if (pattern.test(code)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${what}`)
        }
      }
      expect(offenders).toEqual([])
    })

    it('those detectors bite — and do not fire on a doc comment forbidding the same thing', () => {
      expect(/\bhomedir\s*\(/.test('const root = homedir()')).toBe(true)
      expect(/refs\//.test("await exec('git', ['update-ref', 'refs/rhizomorph/x', sha])")).toBe(true)
      expect(/\.claude\b/.test("path.join(homedir(), '.claude', 'projects')")).toBe(true)
      expect(/\bwriteFile\s*\(/.test('await writeFile(somewhereElse, data)')).toBe(true)

      // The false positive this module's own prose would otherwise be.
      expect(/\.claude\b/.test(codeOf(path.join(RECORDER_DIR, 'rotate.ts')))).toBe(false)
      expect(readFileSync(path.join(RECORDER_DIR, 'rotate.ts'), 'utf8')).toContain('~/.claude')
    })
  })

  describe('rotation is reachable only from an explicit operator command', () => {
    it('no source file outside the module reaches rotation, except the one declared route', () => {
      const violations: string[] = []
      for (const file of walkSourceFiles(SERVER_SRC, [RECORDER_DIR])) {
        if (isTest(file)) continue
        if (ALLOWED_ROTATION_CALLERS.has(path.resolve(file))) continue
        if (ROTATION_ENTRY_RE.test(readFileSync(file, 'utf8'))) {
          violations.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(violations).toEqual([])
    })

    it('the one allowed caller really does call it — the exception is not dead code', () => {
      for (const file of ALLOWED_ROTATION_CALLERS) {
        expect(ROTATION_ENTRY_RE.test(readFileSync(file, 'utf8'))).toBe(true)
      }
    })

    it('no collector and no poll loop is among them — stated by name, not left to the sweep', () => {
      const shouldNeverRotate = [
        path.join(SERVER_SRC, 'server', 'poll-loop.ts'),
        path.join(SERVER_SRC, 'collectors', 'sessionlog', 'collector.ts'),
        path.join(SERVER_SRC, 'collectors', 'git', 'git-collector.ts'),
      ]
      for (const file of shouldNeverRotate) {
        expect(ROTATION_ENTRY_RE.test(readFileSync(file, 'utf8')), `${file} reaches rotation`).toBe(false)
      }
    })

    it('no web source file imports the recorder module — the button asks the server, it does not write', () => {
      const violations: string[] = []
      for (const file of walkSourceFiles(WEB_SRC)) {
        const source = readFileSync(file, 'utf8')
        if (/from\s+['"][^'"]*server\/src\/recorder|\brecorder\/(?:rotate|session-recorder|session-log-writer)/.test(source)) {
          violations.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(violations).toEqual([])
    })
  })

  describe('the recorder has no clock of its own', () => {
    it('no source file in the module schedules work — rotation never runs without a human', () => {
      const offenders: string[] = []
      for (const file of recorderSourceFiles()) {
        if (/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test(readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(REPO_ROOT, file))
        }
      }
      expect(offenders).toEqual([])
    })

    it('that detector bites', () => {
      expect(/\b(?:setInterval|setTimeout|setImmediate)\s*\(/.test('setInterval(() => rotate(), 3_600_000)')).toBe(
        true,
      )
    })
  })
})

/**
 * The live half. Everything above reads source text; this rotates for real and
 * asserts, by hashing every file in a temp root before and after, that ruling
 * 2's fence held: the session directory changed, and nothing else did.
 *
 * Hermetic under 4x concurrency: one `mkdtemp` root per test, ids derived from
 * the test's own pinned clock, no reliance on the ambient `~`.
 */
describe('the recorder namespace law, live (prd16 ruling 2)', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let sessionDir: string
  let claudeProjectsRoot: string
  let recorder: SessionRecorder

  const FIRST_SESSION = '1000'
  const ROTATE_AT = 2000

  function git(args: string[], cwd = repoDir): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  /** Every path under `dir`: directories by name, files by content hash. */
  function fingerprint(dir: string): Map<string, string> {
    const out = new Map<string, string>()
    const visit = (current: string) => {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry)
        const relative = path.relative(dir, full)
        const info = statSync(full)
        if (info.isDirectory()) {
          out.set(relative, 'dir')
          visit(full)
        } else {
          out.set(relative, createHash('sha1').update(readFileSync(full)).digest('hex'))
        }
      }
    }
    visit(dir)
    return out
  }

  interface TreeDiff {
    added: string[]
    changed: string[]
    removed: string[]
  }

  function diff(before: Map<string, string>, after: Map<string, string>): TreeDiff {
    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []
    for (const [key, value] of after) {
      const previous = before.get(key)
      if (previous === undefined) added.push(key)
      else if (previous !== value) changed.push(key)
    }
    for (const key of before.keys()) {
      if (!after.has(key)) removed.push(key)
    }
    return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
  }

  /**
   * prd16 ruling 2's namespace, as a path predicate over the whole temp root:
   * this repo's own session directory under the data root, and nothing else.
   * Not "anywhere under the data root" — a rotation that wrote into another
   * repo's session dir would be just as much a trespass as one that wrote into
   * the repo.
   */
  function isAllowedWrite(relative: string): boolean {
    const allowed = path.relative(root, sessionDir)
    return relative === allowed || relative.startsWith(`${allowed}${path.sep}`)
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-recorder-law-test-'))
    repoDir = path.join(root, 'repo')
    dataRoot = path.join(root, 'data')
    claudeProjectsRoot = path.join(root, 'claude-projects')
    sessionDir = sessionDirFor(repoDir, dataRoot)

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial commit'])
    // A dirty tree and an untracked file: what the observer is watching when an
    // operator hits "end session · start fresh" mid-run.
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 dirty\n')
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n')

    // A stand-in `~/.claude/projects`: transcripts rotation must not touch
    // (capturing them is prd16 ruling 3, a later wave, and a copy INTO the
    // data dir even then — never a write here).
    await mkdir(path.join(claudeProjectsRoot, 'a-project'), { recursive: true })
    await writeFile(path.join(claudeProjectsRoot, 'a-project', `${randomUUID()}.jsonl`), '{"type":"user"}\n')

    // A session already being recorded, with a live lock beside it.
    recorder = new SessionRecorder(FIRST_SESSION, sessionFilePath(sessionDir, FIRST_SESSION))
    await recorder.record(
      createEvent(
        'session.started',
        { sessionId: FIRST_SESSION, repoPath: repoDir, repoName: 'repo' },
        { id: 'evt-000001', ts: Number(FIRST_SESSION) },
      ),
    )
    await writeSessionLock(sessionDir, FIRST_SESSION, process.pid, Number(FIRST_SESSION))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function rotate() {
    return rotateSession({
      sessionDir,
      repoPath: repoDir,
      repoName: 'repo',
      recorder,
      now: () => ROTATE_AT,
      pid: process.pid,
    })
  }

  it("writes ONLY inside this repo's own session directory — nothing else in the tree moves", async () => {
    const before = fingerprint(root)

    await rotate()

    const { added, changed, removed } = diff(before, fingerprint(root))
    // Otherwise every assertion below would pass vacuously.
    expect(added.length).toBeGreaterThan(0)
    expect(changed.length).toBeGreaterThan(0)
    expect(removed.length).toBeGreaterThan(0)

    expect([...added, ...changed, ...removed].filter((entry) => !isAllowedWrite(entry))).toEqual([])
  })

  it('that fence bites — a write anywhere else in the tree would be caught', () => {
    expect(isAllowedWrite(path.join('repo', 'notes.md'))).toBe(false)
    expect(isAllowedWrite(path.join('repo', '.git', 'refs', 'heads', 'main'))).toBe(false)
    expect(isAllowedWrite(path.join('claude-projects', 'a-project', 'x.jsonl'))).toBe(false)
    // Another repo's recordings, under the same data root, are still not ours.
    expect(isAllowedWrite(path.join('data', 'other-repo-deadbeef', 'session-1.jsonl'))).toBe(false)
    // …and the three writes the ruling grants are all inside one directory.
    const mine = path.relative(root, sessionDir)
    expect(isAllowedWrite(path.join(mine, 'session-1000.jsonl'))).toBe(true)
    expect(isAllowedWrite(path.join(mine, 'session-2000.jsonl'))).toBe(true)
    expect(isAllowedWrite(path.join(mine, 'session-2000.lock.json'))).toBe(true)
  })

  it("leaves the watched repo's working tree and every ref byte-for-byte as it found them", async () => {
    const statusBefore = git(['status', '--porcelain'])
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)'])
    const treeBefore = fingerprint(repoDir)

    await rotate()

    expect(git(['status', '--porcelain'])).toBe(statusBefore)
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore)
    expect(diff(treeBefore, fingerprint(repoDir))).toEqual({ added: [], changed: [], removed: [] })
  })

  it('leaves ~/.claude untouched — a recording is written, never a transcript', async () => {
    const before = fingerprint(claudeProjectsRoot)
    await rotate()
    expect(diff(before, fingerprint(claudeProjectsRoot))).toEqual({ added: [], changed: [], removed: [] })
  })

  it('and what it DID write is a closed log, a fresh log, and one lock — nothing more', async () => {
    const rotation = await rotate()

    const entries = readdirSync(sessionDir).sort()
    expect(entries).toEqual([
      `session-${FIRST_SESSION}.jsonl`,
      `session-${ROTATE_AT}.jsonl`,
      `session-${ROTATE_AT}.lock.json`,
    ])
    expect(rotation.closed.sessionId).toBe(FIRST_SESSION)
    expect(rotation.opened.sessionId).toBe(String(ROTATE_AT))

    // The closed log ends where the operator said it did, and the new one begins.
    const closed = await readSessionEvents(rotation.closed.filePath)
    expect(closed.map((event) => event.type)).toEqual(['session.started', 'session.closed'])
    const opened = await readSessionEvents(rotation.opened.filePath)
    expect(opened.map((event) => event.type)).toEqual(['session.started'])

    // The lock names the new session and this process — not the closed one.
    const lock = JSON.parse(await readFile(path.join(sessionDir, `session-${ROTATE_AT}.lock.json`), 'utf8')) as {
      pid: number
    }
    expect(lock.pid).toBe(process.pid)
  })
})
