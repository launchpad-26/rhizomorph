import type { AnyCollector, Exec } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../server/context.js'
import type { PollLoop } from '../server/poll-loop.js'
import type { SessionRecorder } from '../server/recorder.js'

export interface RunCliOptions {
  /** Injectable clock, so tests get deterministic session ids and ticks. */
  now?: () => number
  /** Overrides `~/.local/share/rhizomorph` — tests point this at a temp dir. */
  dataRoot?: string
  /** Overrides the web dist dir this server would otherwise serve statically. */
  webDistDir?: string
  /** Overrides collector discovery — tests inject fakes instead of the real loader. */
  collectors?: readonly AnyCollector[]
  /** Overrides the sessionlog collector's Claude project-logs root; tests point this at a fixture dir instead of the real `~/.claude/projects`. */
  claudeProjectsRoot?: string
  /**
   * Overrides the home directory per-dialect session-log discovery reads
   * (prd-57 ruling 8). Separate from {@link RunCliOptions.claudeProjectsRoot},
   * which overrides where a transcript is READ from — the two coincide on a
   * real machine and a test needs to move them apart to reach the
   * discovered-versus-merely-readable distinction at all.
   */
  home?: string
  /** Overrides the root `package.json` path `--version` reads from; tests point this at a fixture file. */
  rootPackageJsonPath?: string
  exec?: Exec
  intervalMs?: number
  log?: Pick<Console, 'log' | 'warn'>
  /** Overrides `process.exit` — tests inject a stub that throws so a parse failure unwinds instead of killing the runner. */
  exit?: (code: number) => never
}

export interface CliHandle {
  app: FastifyInstance
  recorder: SessionRecorder
  pollLoop: PollLoop
  /** The address the server ended up listening on, e.g. "http://127.0.0.1:4321". */
  url: string
  stop: () => Promise<void>
  /**
   * The live, re-pointable `ServerContext` this boot's routes read from
   * (prd20 ruling 5) — present only for a watching server
   * (`runServerCommand`), absent for a replay (`cli/replay.ts`), which serves
   * a finished record nothing ever retargets. A caller wanting to repoint
   * `repoPath`/`repoName`/`sessionDir` mutates this object directly; every
   * route already holds the identical reference (`build-app.ts` never
   * copies it).
   */
  ctx?: ServerContext
}
