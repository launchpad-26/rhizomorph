/**
 * THE SPAWN CONTRACT (prd-34 ruling 1) — every argument, every environment
 * variable, and the reason for each, as one pure function a test can read.
 *
 * The shell adds no server code, so the only thing it can get wrong about the
 * server is *how it starts it*. Keeping that as data rather than as a `spawn()`
 * call buried in the Electron entry buys three things: `spawn-contract.test.ts`
 * can assert the shape without a process, `flag-honesty-law.test.ts` can hold
 * every flag here against the server's own `parseArgs` so a renamed flag fails
 * in this package rather than at a stranger's first launch, and a reviewer can
 * see the whole surface of contact in one screen.
 *
 * ## `ELECTRON_RUN_AS_NODE`, and why the app never looks for `node`
 *
 * A packaged app cannot assume a system Node — that assumption is precisely the
 * doorstep prd-34 exists to remove. Electron ships Node in-process (the reason
 * ruling 1 chose it over Tauri), and `ELECTRON_RUN_AS_NODE=1` makes the app's
 * own binary behave as a plain Node for one child. So the server runs on the
 * Node inside the app the stranger installed, and the shell's spawn command is
 * `process.execPath` in both worlds — one code path, developed and shipped.
 *
 * ## `--port 0`, and why the shell never picks a number
 *
 * The default port is 4321 and a developer already has one instrument running
 * on it more often than not. Asking for `0` makes the OS pick a free port and
 * the server print it ({@link readListeningUrl} reads it back), so the second
 * launch is not an `EADDRINUSE` a stranger has to interpret. The shell
 * therefore never holds a port constant at all.
 *
 * ## What is deliberately NOT here
 *
 * No `--fresh`: a shell relaunch is exactly the case the resume window exists
 * for, and forcing a new session on every window open would split one run into
 * a dozen logs. No `--backfill`: reading history on purpose is an operator's
 * act. No token, no credential, no auth flag of any kind — ADR-0012's handshake
 * is in-band and the page performs it (see `boot-line.ts`).
 */

/** Every flag the shell passes, as data — the flag-honesty law reads this list, not the argv it builds. */
export const SHELL_FLAGS = ['--port'] as const

export interface SpawnContractInput {
  /** Electron's own binary — `process.execPath`. Never a `node` looked up on PATH. */
  execPath: string
  /** The server's bin, from `resolveLayout`. */
  serverEntry: string
  /** The repo to watch, or null on a first run that has not chosen one yet. */
  repoPath: string | null
  /** The process environment to inherit. */
  env: NodeJS.ProcessEnv
}

export interface SpawnRequest {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The directory the child runs in — the watched repo when there is one. */
  cwd: string | undefined
}

/**
 * The server child, as the shell asks for it. `repoPath` is passed as the
 * positional argument *and* as the cwd: the CLI defaults the positional to
 * `process.cwd()`, and passing both means the two can never disagree about
 * which repo this instrument watches.
 */
export function serverSpawnRequest(input: SpawnContractInput): SpawnRequest {
  const args = [input.serverEntry]
  if (input.repoPath !== null) args.push(input.repoPath)
  args.push('--port', '0')

  return {
    command: input.execPath,
    args,
    env: {
      ...input.env,
      // The one variable that makes `process.execPath` a Node rather than an
      // Electron. Without it the child would boot a second Electron app.
      ELECTRON_RUN_AS_NODE: '1',
    },
    cwd: input.repoPath ?? undefined,
  }
}
