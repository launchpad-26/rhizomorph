import type { AnyCollector, Exec } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
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
}
