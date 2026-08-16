import { readListeningUrl } from './boot-line.js'
import type { SpawnRequest } from './spawn-contract.js'

/**
 * THE SERVER CHILD, SUPERVISED — start it, learn where it is listening, and
 * shut it down cleanly (prd-34 ruling 1; "the app launches, spawns the server,
 * shows the window, and shuts both down cleanly").
 *
 * Pure over an injected spawn, so every branch here is exercised without a real
 * process: the happy path, a server that exits before it ever listens, a server
 * that never prints, and a spawn that fails outright. Electron appears nowhere
 * in this file — `src/main/` wires it.
 *
 * **Failure degrades loudly and keeps working** (prd-34's D43, and the reason
 * this is a state machine rather than a promise that rejects). A server that
 * dies does not take the shell with it: the phase becomes `failed`, the
 * *reason* is a sentence a person can act on, and {@link ServerStatus.outputTail}
 * carries the child's last lines so the shell can show what the terminal would
 * have shown. The one thing this must never do is exit quietly.
 */

export type ServerPhase = 'starting' | 'running' | 'failed' | 'stopped'

export interface ServerStatus {
  phase: ServerPhase
  /** Where the instrument is, once the server has said so. Null in every other phase. */
  url: string | null
  /** What happened, in a sentence — always set for `failed`, otherwise null. */
  detail: string | null
  /** The child's last output lines, oldest first. What a terminal would have shown. */
  outputTail: readonly string[]
}

/** The slice of `child_process.ChildProcess` this module uses. A test satisfies it in ten lines. */
export interface ChildLike {
  readonly pid?: number | undefined
  stdout: StreamLike | null
  stderr: StreamLike | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface StreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  setEncoding?(encoding: string): unknown
}

export type SpawnLike = (request: SpawnRequest) => ChildLike

export interface SupervisorOptions {
  spawn: SpawnLike
  /** How long to wait for the boot line before calling it a failure. CI's own boot smoke waits 30s. */
  startTimeoutMs?: number
  /** How long a `SIGTERM` gets before `SIGKILL`. */
  stopGraceMs?: number
  /** Lines of child output to retain for the failure voice. */
  tailLines?: number
  /** Called on every status change — the shell's one subscription. */
  onStatus?: (status: ServerStatus) => void
}

export const DEFAULT_START_TIMEOUT_MS = 30_000
export const DEFAULT_STOP_GRACE_MS = 5_000
export const DEFAULT_TAIL_LINES = 40

export class ServerSupervisor {
  private readonly options: Required<Omit<SupervisorOptions, 'onStatus'>> & Pick<SupervisorOptions, 'onStatus'>
  private child: ChildLike | null = null
  private buffer = ''
  private tail: string[] = []
  private status: ServerStatus = { phase: 'starting', url: null, detail: null, outputTail: [] }
  private settle: ((status: ServerStatus) => void) | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private exited: Promise<void> | null = null
  private resolveExited: (() => void) | null = null

  constructor(options: SupervisorOptions) {
    this.options = {
      spawn: options.spawn,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      tailLines: options.tailLines ?? DEFAULT_TAIL_LINES,
      onStatus: options.onStatus,
    }
  }

  current(): ServerStatus {
    return this.status
  }

  /**
   * Spawns the child and resolves once it is either listening or known to have
   * failed. **Never rejects**: a failure is a status, because the shell's
   * answer to a dead server is a window that says so, not an unhandled
   * rejection in the main process.
   */
  start(request: SpawnRequest): Promise<ServerStatus> {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })

    let child: ChildLike
    try {
      child = this.options.spawn(request)
    } catch (error) {
      this.resolveExited?.()
      return Promise.resolve(this.fail(`could not start the server process: ${messageOf(error)}`))
    }
    this.child = child

    const settled = new Promise<ServerStatus>((resolve) => {
      this.settle = resolve
    })

    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding?.('utf8')
      stream?.on('data', (chunk) => this.absorb(String(chunk)))
    }

    child.on('error', (error) => {
      this.resolveExited?.()
      this.fail(`the server process reported an error: ${messageOf(error)}`)
    })

    child.on('exit', (code, signal) => {
      this.resolveExited?.()
      if (this.status.phase === 'stopped') return
      // An exit after the URL landed is still a failure — the instrument the
      // window is pointed at has gone. The window stays open and says so.
      this.fail(
        signal !== null
          ? `the server exited on ${signal} before the shell asked it to`
          : `the server exited with code ${code ?? 'unknown'} before the shell asked it to`,
      )
    })

    this.startTimer = setTimeout(() => {
      if (this.status.phase !== 'starting') return
      this.fail(
        `the server did not report a listening URL within ${Math.round(this.options.startTimeoutMs / 1000)}s`,
      )
    }, this.options.startTimeoutMs)
    this.startTimer.unref?.()

    return settled
  }

  /**
   * Asks the child to stop and waits for it to actually go. `SIGTERM` first —
   * the server's own bin handles it and releases its session lock
   * (`run.ts`'s `stop`), which is the whole reason a shell quit must not be a
   * `SIGKILL` — then `SIGKILL` if the grace period lapses.
   */
  async stop(): Promise<void> {
    const child = this.child
    this.emit({ ...this.status, phase: 'stopped', url: null, detail: null })
    this.clearStartTimer()
    if (child === null) return

    child.kill('SIGTERM')
    const graceful = await Promise.race([
      this.exited?.then(() => true) ?? Promise.resolve(true),
      delay(this.options.stopGraceMs).then(() => false),
    ])
    if (!graceful) child.kill('SIGKILL')
    this.child = null
  }

  /**
   * The last synchronous chance to take the child with us — for
   * `process.on('exit')`, where nothing may await.
   *
   * **This exists because a shell does not always get to run its own shutdown.**
   * Measured on 2026-08-16 with Electron 43 under WSLg: a `SIGTERM` to the
   * browser process runs **no** main-process JavaScript at all — not
   * `process.on('SIGTERM')`, not `before-quit`, not a window's `close` — because
   * Chromium installs its own POSIX handlers over libuv's. A probe confirmed
   * both halves: `app.quit()` fires `before-quit` and `process.on('exit')`
   * normally, and a `SIGTERM` fires neither.
   *
   * So the honest posture, stated rather than assumed:
   *
   * - every path where JS runs (the tray's Quit, `app.quit()`, a normal exit)
   *   stops the server properly, releasing its session lock;
   * - a path where JS does not run (`SIGKILL`, a Chromium fatal, that WSLg
   *   `SIGTERM`) leaves the server running until its own next write to a closed
   *   pipe ends it. It is not lost work — the session lock records a pid, and
   *   `decideSessionBoot`'s `isPidAlive` reports a dead writer immediately — but
   *   it is not instant either.
   *
   * Closing that last gap properly means the *server* watching its parent, which
   * is a change inside `packages/server` and outside this lane's fence (#563).
   * It is written down here rather than left for someone to rediscover.
   */
  killNow(): void {
    this.child?.kill('SIGTERM')
  }

  private absorb(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      this.tail.push(line)
      if (this.tail.length > this.options.tailLines) this.tail.shift()
    }

    if (this.status.phase !== 'starting') return
    // COMPLETED lines only. `http://127.0.0.1:43` is a URL that parses, and a
    // chunk boundary lands mid-number often enough that reading the partial
    // buffer would eventually point the window at a port nothing is listening
    // on. The unterminated remainder stays in `this.buffer` and is read on the
    // chunk that finishes it.
    const url = readListeningUrl(lines.join('\n'))
    if (url === null) return
    this.clearStartTimer()
    const running: ServerStatus = { phase: 'running', url, detail: null, outputTail: [...this.tail] }
    this.emit(running)
    this.settle?.(running)
    this.settle = null
  }

  private fail(detail: string): ServerStatus {
    this.clearStartTimer()
    const failed: ServerStatus = { phase: 'failed', url: null, detail, outputTail: [...this.tail] }
    this.emit(failed)
    this.settle?.(failed)
    this.settle = null
    return failed
  }

  private emit(status: ServerStatus): void {
    this.status = status
    this.options.onStatus?.(status)
  }

  private clearStartTimer(): void {
    if (this.startTimer === null) return
    clearTimeout(this.startTimer)
    this.startTimer = null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
