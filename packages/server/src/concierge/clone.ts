import { spawn } from 'node:child_process'
import { EventEmitter, on } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { defaultDataRoot } from '../log/paths.js'
import { assertCloneTarget, defaultClonesRoot } from './paths.js'

/**
 * prd-20 ruling 1 / ADR-0014's second power, wired for real: `git clone` a
 * URL the operator typed, into the concierge's own namespace, with progress
 * surfaced as it happens. `assertCloneTarget` (`paths.ts`) already existed as
 * an unwired obligation — its own doc says so explicitly — and this module is
 * what finally calls it on every path a clone can take.
 *
 * Deliberately two phases, not one function: {@link planClone} does every
 * check that can be answered before a single byte of `git` output exists
 * (URL grammar, the fence, "does the destination already exist") and can
 * therefore fail with a precise HTTP status *before* the caller (`api/
 * concierge.ts`) commits to a streamed response; {@link runClone} only ever
 * runs once planning has already succeeded, and its only failures from then
 * on are real ones `git` itself reports.
 *
 * No shell, ever (namespace-law clause 4): `git` is spawned as an argv array
 * via `node:child_process`'s `spawn`, never `exec`/`execSync`, and `--` is
 * passed ahead of the URL and destination so neither can be read as a flag by
 * `git` itself even though {@link assertValidCloneUrl} already refuses a
 * leading `-` — defense in depth, not redundancy for its own sake.
 *
 * No clock, ever (namespace-law clause 3): everything below is event-driven
 * off the child process's own `data`/`close`/`error` events. There is no
 * `setTimeout`-backed hang guard here on purpose — `stdio: ['ignore', ...]`
 * on the real spawn removes the one hang vector this module could hit (`git`
 * blocking on a credential prompt for a private repo with no cached
 * credentials), so there is nothing left for a timer to guard against. A
 * caller wanting a hard wall-clock cap on top of that can add one in
 * `api/concierge.ts`, which this law does not fence.
 */

export class CloneValidationError extends Error {}

export class CloneDestinationExistsError extends Error {
  constructor(readonly path: string) {
    super(`refusing to clone: ${path} already exists`)
  }
}

export type CloneEvent =
  | { type: 'progress'; line: string }
  | { type: 'done'; path: string }
  | { type: 'error'; message: string }

/** `POST /api/concierge/clone`'s body: a URL, and nothing else — the destination is always derived, never caller-supplied (see `deriveCloneName`). */
export function parseCloneRequestBody(body: unknown): { url: string } {
  if (typeof body !== 'object' || body === null) {
    throw new CloneValidationError('request body must be a JSON object')
  }
  const { url } = body as Record<string, unknown>
  if (typeof url !== 'string') {
    throw new CloneValidationError('"url" must be a string')
  }
  return { url }
}

/** An `http(s)://`/`ssh://`/`git://` URL, or git's own scp-like `user@host:path` shorthand. */
const URL_SCHEME_RE = /^(?:https?|ssh|git):\/\//i
const SCP_LIKE_RE = /^[\w.-]+@[\w.-]+:.+$/
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/**
 * `scheme://user:password@host/...` — a credential embedded IN the URL,
 * distinct from the bare `user@host` SSH convention (`ssh://git@host/...`,
 * or the scp-like form) which carries no secret and authenticates through
 * the machine's own key. Requires a `:` between the userinfo and the `@` so
 * a plain username is never mistaken for one.
 */
const EMBEDDED_CREDENTIAL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i

/**
 * ANY userinfo (`user@` or `user:pass@`) in front of an `http(s)://` host.
 * Distinct from {@link EMBEDDED_CREDENTIAL_RE}, which only fires when a colon
 * separates a username from a password — and which therefore MISSES the way a
 * token most often rides in a URL: as the bare username itself,
 * `https://ghp_…@github.com/owner/repo.git` (GitHub and GitLab both accept a
 * PAT as the username with no password). Over `http(s)` a username in the URL
 * is either a token or useless — the machine's own credential helper supplies
 * real auth, per prd-20's credential story — so any userinfo is refused. The
 * bare `user@` SSH LOGIN name (`ssh://git@…`, `git@github.com:…`) is a
 * different thing and stays legal: it is scheme-gated to `http(s)` here so an
 * SSH key login never trips it.
 */
const HTTP_USERINFO_RE = /^https?:\/\/[^/@]+@/i

/**
 * Validates a clone URL well before it ever reaches an argv array: non-empty,
 * no control characters or whitespace (a repo URL is one token, never a
 * command line), not flag-shaped (the same defence-in-depth `lab.ts` grew
 * for `model`/`lane` after review — commits `3d2f303`/`90f0884`), one of the
 * URL shapes `git clone` itself actually accepts, and carrying no embedded
 * credential. Throws {@link CloneValidationError}; never returns a reason,
 * only a refusal — the one thing this function is FOR is to reject before
 * anything downstream has to guess why.
 *
 * The embedded-credential refusal is a security review finding, not a
 * grammar nicety: `url` is spawned as a literal `git` argv element
 * (`runClone`), which is visible to every other local process on the
 * machine via `ps`/`/proc/<pid>/cmdline` for the clone's whole duration. This
 * instrument's own threat model (`api/security.ts`) explicitly treats
 * "another local process on the same machine" as an adversary the
 * capability token defends against — but the token gates the HTTP request,
 * not the OS process table, so a `https://user:token@host/repo.git` URL
 * would leak that token to exactly the adversary the token exists to stop.
 * Refusing it also enforces prd-20's own credential story: "the machine's
 * existing git/gh credentials" means an SSH key or a credential helper, not
 * a token pasted into a URL.
 */
export function assertValidCloneUrl(url: string): void {
  if (url.trim().length === 0) {
    throw new CloneValidationError('"url" must be a non-empty string')
  }
  if (CONTROL_CHAR_RE.test(url) || /\s/.test(url)) {
    throw new CloneValidationError('"url" must not contain control characters or whitespace')
  }
  if (url.startsWith('-')) {
    throw new CloneValidationError('"url" must not start with "-" — that would be read as a flag, not a repository')
  }
  if (!URL_SCHEME_RE.test(url) && !SCP_LIKE_RE.test(url)) {
    throw new CloneValidationError(
      '"url" must be an http(s)/ssh/git URL, or the scp-like "user@host:path" form git itself accepts',
    )
  }
  if (EMBEDDED_CREDENTIAL_RE.test(url) || HTTP_USERINFO_RE.test(url)) {
    throw new CloneValidationError(
      '"url" must not embed a credential (user@host or user:password@host over http(s)) — it would be visible to ' +
        'every other process on this machine for the whole clone; use the machine\'s own SSH key or git credential ' +
        'helper instead',
    )
  }
}

const NAME_SANITIZE_RE = /[^A-Za-z0-9._-]+/g

/**
 * The destination directory NAME a clone lands under `clonesRoot` as —
 * derived from the URL's last path segment, never taken from the caller as a
 * path. Accepting a caller-supplied path at all would turn "where does this
 * land" into something the request controls; deriving it keeps the only
 * caller-controlled input the URL itself, which {@link assertCloneTarget}
 * still checks regardless.
 */
export function deriveCloneName(url: string): string {
  const withoutTrailingSlashes = url.replace(/\/+$/, '')
  const lastSegment = withoutTrailingSlashes.split(/[/:]/).pop() ?? ''
  const withoutGitSuffix = lastSegment.replace(/\.git$/i, '')
  const sanitized = withoutGitSuffix.replace(NAME_SANITIZE_RE, '-').replace(/^-+|-+$/g, '')

  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    throw new CloneValidationError(`could not derive a destination directory name from "${url}"`)
  }
  return sanitized
}

export interface ClonePlan {
  readonly clonesRoot: string
  readonly candidate: string
}

export interface PlanCloneOptions {
  /** The repo this server is watching — absolutely off-limits (ADR-0014 grant 4). */
  watchedRepoPath: string
  /** Defaults to {@link defaultClonesRoot} — the answer proposed on issue #262. */
  clonesRoot?: string
  /** Defaults to {@link defaultDataRoot} — the other hands' territory the fence also refuses. */
  dataRoot?: string
  /** Overridable for tests; production always claims the real filesystem. */
  claimDestination?: (candidate: string) => Promise<boolean>
}

/**
 * Atomically claims `candidate` as this call's own, by creating it —
 * `mkdir` either creates the directory or fails with `EEXIST`, with no
 * window between "check" and "act" for a second caller to land in. Returns
 * `true` if THIS call created it, `false` if it was already there (another
 * clone got there first, or a leftover from an earlier one).
 *
 * This is the fix for a real race a caller-supplied `exists()`-then-mkdir
 * check cannot close: two concurrent requests for the same URL both pass an
 * "is anything there yet" check before either has created the directory,
 * both spawn `git clone` at the identical path, one wins and one loses — and
 * the loser's own failure cleanup (`runClone`'s `removeDirectory`) would then
 * delete whatever the WINNER left behind, silently destroying an already
 * -completed, already-acknowledged clone. Claiming the path atomically,
 * before `git` ever runs, means `removeDirectory` can only ever be cleaning
 * up THIS call's own attempt — nobody else could have been given the same
 * path to clone into.
 */
async function realClaimDestination(candidate: string): Promise<boolean> {
  try {
    await mkdir(candidate)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * Every check that can be answered before `git` runs at all: the URL's own
 * grammar, the namespace fence (`assertCloneTarget`), and — atomically, so
 * two concurrent requests for the same URL can never both proceed — whether
 * the destination is already occupied. Throws {@link CloneValidationError},
 * `CloneFenceError` (`paths.ts`) or {@link CloneDestinationExistsError} —
 * three distinct failures `api/concierge.ts` maps to three distinct HTTP
 * statuses, precisely so a caller can tell "you typed something wrong" from
 * "that would breach the fence" from "you already have that repo".
 *
 * Async only for claiming the destination; everything else here is
 * synchronous and could fail before a single `await` — ordered
 * grammar-then-fence-then-claim anyway, so the cheapest, most-likely-to-fire
 * checks run first, and the one check with a real side effect (creating the
 * directory) runs last, only once everything else has already agreed to
 * proceed.
 */
export async function planClone(url: string, options: PlanCloneOptions): Promise<ClonePlan> {
  assertValidCloneUrl(url)
  const name = deriveCloneName(url)

  const clonesRoot = options.clonesRoot ?? defaultClonesRoot()
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const candidate = path.join(clonesRoot, name)

  assertCloneTarget({ clonesRoot, watchedRepoPath: options.watchedRepoPath, dataRoot }, candidate)

  const claimDestination = options.claimDestination ?? realClaimDestination
  if (!(await claimDestination(candidate))) {
    throw new CloneDestinationExistsError(candidate)
  }

  return { clonesRoot, candidate }
}

/**
 * Splits a raw chunk of `git clone --progress` output into complete lines,
 * carrying an unterminated tail forward as `remainder` for the next chunk to
 * complete. Splits on `\r` OR `\n`: git redraws its own percentage meter with
 * a bare `\r` between ticks and writes a real `\n` only once per phase
 * ("Enumerating objects", "Receiving objects: 100% (…), done.") — treating
 * only `\n` as a line end would collapse an entire phase's ticks into one
 * line seen only once at the very end, which is not the live progress a
 * caller watching this stream is asking for. A blank segment (the `\n` half
 * of a `\r\n` pair, or two terminators back to back) is dropped rather than
 * surfaced as an empty "progress line" nobody wants.
 *
 * Pure and stateless by design — `remainder` is threaded back in by the
 * caller rather than held here, so it is unit-testable one chunk at a time
 * without a real process.
 */
export function splitProgressLines(buffer: string, chunk: string): { lines: string[]; remainder: string } {
  const parts = (buffer + chunk).split(/\r\n|\r|\n/)
  const remainder = parts.pop() ?? ''
  return { lines: parts.filter((line) => line.length > 0), remainder }
}

/** The minimal shape {@link runClone} needs from a spawned child — real `ChildProcess` satisfies it structurally. */
export interface SpawnedProcess {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export type SpawnFn = (command: string, args: readonly string[]) => SpawnedProcess

/**
 * `stdio: ['ignore', 'pipe', 'pipe']` — stdin is deliberately NEVER connected.
 * A private repo with no cached credentials makes `git clone` prompt on
 * stdin; with stdin ignored, that prompt has nowhere to go and `git` fails
 * fast instead of hanging forever. This module has no clock (namespace-law
 * clause 3) to time such a hang out with, so removing the hang vector itself
 * is the only fix available here.
 */
const realSpawnGit: SpawnFn = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

export interface RunCloneOptions {
  spawnGit?: SpawnFn
  /** Overridable for tests; production removes a failed attempt's partial checkout for real. */
  removeDirectory?: (candidate: string) => Promise<void>
}

async function realRemoveDirectory(candidate: string): Promise<void> {
  await rm(candidate, { recursive: true, force: true })
}

/**
 * Runs the clone {@link planClone} already approved, yielding progress as it
 * happens and a terminal `done`/`error` event — never throws, so a caller can
 * `for await` this without a `try`/`catch` of its own. Only ever called after
 * planning succeeds, so its only failures from here are real ones: `git`
 * itself exiting non-zero, or failing to start at all (`ENOENT` — git not
 * installed).
 *
 * On failure, best-effort removes whatever `git` left at `plan.candidate` —
 * a killed process or a network failure partway through a clone leaves a
 * `.git` on disk that would otherwise force the operator to clean up by hand
 * before a retry could get past {@link planClone}'s claim check. Safe to do
 * unconditionally because {@link planClone}'s `claimDestination` step
 * atomically created `plan.candidate` for THIS call alone before `git` ever
 * ran — nothing else could have been handed the same path to clone into, so
 * there is no sibling attempt's success this could delete out from under it.
 * Never removes anything on success.
 *
 * Deliberately does not accept a cancellation signal: a disconnected caller
 * must not abort a clone that might be most of the way through downloading a
 * large repo (this is exactly the multi-minute case the whole module exists
 * for) — `api/concierge.ts` keeps pulling this generator to completion even
 * once its own response socket has gone away, so the clone always finishes
 * on its own terms, whether or not anyone is still listening.
 */
export async function* runClone(
  url: string,
  plan: ClonePlan,
  options: RunCloneOptions = {},
): AsyncGenerator<CloneEvent, void, void> {
  const spawnGit = options.spawnGit ?? realSpawnGit
  const removeDirectory = options.removeDirectory ?? realRemoveDirectory

  const child = spawnGit('git', ['clone', '--progress', '--', url, plan.candidate])
  // A private bus, not `child` itself: `child`'s own `data`/`close`/`error`
  // events don't share one shape, so `on(child, ...)` couldn't yield a
  // uniform `CloneEvent` — this re-emits everything onto one event name
  // instead, which is what `events.on`'s async-iterator helper needs to
  // bridge callback events into `for await` with no hand-rolled queue.
  const bus = new EventEmitter()
  let remainder = ''
  let settled = false

  const handleChunk = (chunk: string): void => {
    const split = splitProgressLines(remainder, chunk)
    remainder = split.remainder
    for (const line of split.lines) bus.emit('clone-event', { type: 'progress', line })
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', handleChunk)
  child.stderr.on('data', handleChunk)

  /** The one terminal event this run gets — guards against Node firing both `error` and `close` for a failed spawn. */
  const settle = (event: CloneEvent): void => {
    if (settled) return
    settled = true
    if (remainder.length > 0) bus.emit('clone-event', { type: 'progress', line: remainder })
    bus.emit('clone-event', event)
  }

  child.on('error', (err) => settle({ type: 'error', message: `could not start git: ${err.message}` }))
  child.on('close', (code) =>
    settle(
      code === 0
        ? { type: 'done', path: plan.candidate }
        : { type: 'error', message: `git clone exited with code ${code ?? 'unknown'}` },
    ),
  )

  let failed = false
  for await (const [event] of on(bus, 'clone-event') as AsyncIterableIterator<[CloneEvent]>) {
    if (event.type === 'error') failed = true
    yield event
    if (event.type !== 'progress') break // the terminal event — nothing further will ever be emitted
  }

  if (failed) await removeDirectory(plan.candidate).catch(() => {})
}
