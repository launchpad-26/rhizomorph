import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { installationBeaconDir } from '../collectors/beacon/paths.js'
import { defaultDataRoot } from '../log/paths.js'

/**
 * `rhizomorph hook` — prd-57 ruling 6, licensed by ADR-0055.
 *
 * Reads the harness's hook JSON from stdin, adds the firing process's parent
 * pid, and appends **one line** to the beacon door. Invoked by the hook entries
 * `rhizomorph enlist` writes, each as the absolute path to the installed CLI
 * resolved at enlist time — never `npx`, whose cold start would eat the
 * harness's hook timeout.
 *
 * ## The law, and it is one sentence: NEVER BLOCK THE AGENT
 *
 * **Exit 0 on every failure**, without exception. A hook that exits non-zero
 * can make the harness surface an error, retry, or in some configurations
 * refuse the tool call — so a broken instrument would degrade the thing it
 * exists to watch. Every failure path here is silent and successful: no door,
 * no permission, malformed stdin, a full disk. The operator finds out from
 * `doctor` saying the witness has seen nothing, never from their agent
 * stumbling.
 *
 * That is why there is no `--verbose`, no error output and no retry. Each would
 * be a way for this to cost the agent something.
 *
 * ## The declared key set, and why stripping happens HERE
 *
 * ADR-0036 records that the collector keeps whatever the writer said: extra
 * keys are ignored on the read and stay on disk, covered by the digest. So a
 * law that an unknown key "dies at the boundary" would be false — the boundary
 * does not strip, and the file keeps what was written.
 *
 * **The real law is about what this RUNNER writes.** {@link DECLARED_KEYS} is
 * the whole of what may leave here; everything else in the hook payload is
 * dropped before the line is formed. `hook.test.ts` plants `tool_input` — the
 * field that carries whatever the agent was about to do — and asserts it is
 * absent from the written bytes.
 *
 * prd-57's non-goals refuse a words plane outright: never `tool_input`, never
 * prompt text, never completion text. The one field carrying words an agent
 * produced is a permission prompt's own short sentence, bounded by
 * {@link MESSAGE_MAX} before the line is formed rather than by whoever reads it.
 *
 * ## The monotonic sequence #525 asked for is DECLARED, not written
 *
 * The issue's DoD asks this to add "the firing process's parent pid **and a
 * monotonic sequence**". The pid is here. The sequence is not, and the reason
 * is that the same DoD forbids it two lines later - "appends exactly one line
 * to exactly one file ... and writes nowhere else."
 *
 * A counter inside this process is always 1: `rhizomorph hook` is invoked fresh
 * per firing, writes one line and exits, so there is no run in which a second
 * number exists. A counter ACROSS firings needs state that outlives the
 * process, which is a second file, read and rewritten on every hook - the write
 * that DoD refuses, on the hot path of every tool call, with two agents racing
 * it.
 *
 * What the sequence was for is ordering when two firings share a millisecond,
 * and **the medium already carries that**: the door is append-only and the
 * collector reads it by increasing byte offset, which every emitted event
 * carries (`BeaconReceivedPayload.offset`). `at` can tie; an offset cannot. So
 * the guarantee is held, by the file rather than by a field.
 *
 * Declared rather than quietly dropped (ADR-0010). Should ordering ever need to
 * survive leaving the file - across two doors, or inside a record - that is a
 * schema field in `packages/core/src/events/beacon.ts`, which this issue's
 * fence does not reach, and it is owed to whichever wave does.
 *
 * ## The runner owns the mkdir
 *
 * ADR-0036: *"The collector never creates the directory … the writer that
 * appends is the one that knows the directory has to exist."* That makes this a
 * rhizomorph process writing outside the watched repo, invoked by the harness
 * rather than by a hand — and ADR-0055 names it: the runner writes only into
 * the installation's own data root, only ever appends, and is covered by the
 * enlist grant that installed it.
 */

/** Everything this runner may write. Nothing else in the hook payload survives. */
export const DECLARED_KEYS = [
  'v',
  'at',
  'writer',
  'kind',
  'lane',
  'detail',
  'sessionId',
  'transcriptPath',
  'cwd',
  'pid',
  'message',
] as const

/** A permission prompt's own sentence, bounded by the WRITER — this file — not by its reader. */
export const MESSAGE_MAX = 200

/**
 * The lifecycle events the enlisted hooks subscribe to, and the word each
 * implies — prd-57 ruling 5's own table.
 *
 * `PostToolUse` and `Stop` both mean "no longer inside a tool call", which is
 * `working`: the agent is alive and not waiting on a human. The distinction
 * between them is a fact about the harness, not about the lane, and inventing a
 * word for it would widen ruling 5's vocabulary without a ruling.
 */
const KIND_BY_EVENT: Readonly<Record<string, string>> = {
  PreToolUse: 'tool-running',
  PostToolUse: 'working',
  Notification: 'waiting-permission',
  Stop: 'working',
  SessionEnd: 'stopped',
}

export interface HookRunOptions {
  /** Overridable so a test needs no real data root. */
  readonly dataRoot?: string
  /** The parent pid, injectable because `process.ppid` is not a test fixture. */
  readonly parentPid?: number
  readonly now?: () => number
}

/** What one hook firing becomes on disk, or `null` when there is nothing honest to write. */
export function beaconLineFor(payload: unknown, options: HookRunOptions = {}): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const input = payload as Record<string, unknown>

  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : null
  if (event === null) return null
  const kind = KIND_BY_EVENT[event]
  // An event this runner has no word for is not guessed at. A hook entry the
  // operator added by hand, or one a future harness fires, writes nothing
  // rather than a line claiming a state nobody derived.
  if (kind === undefined) return null

  const line: Record<string, unknown> = {
    v: 1,
    at: (options.now ?? Date.now)(),
    writer: 'claude-hook',
    kind,
  }

  // Each of the four join keys is carried only when the harness supplied it and
  // it is the shape the schema declares. prd-57 ruling 3's DECLARED join is
  // exactly these; an absent one leaves the join to be inferred, and the actor
  // says which it got.
  if (typeof input.session_id === 'string' && input.session_id.length > 0) line.sessionId = input.session_id
  if (typeof input.transcript_path === 'string' && input.transcript_path.length > 0) {
    line.transcriptPath = input.transcript_path
  }
  if (typeof input.cwd === 'string' && input.cwd.length > 0) line.cwd = input.cwd
  const pid = options.parentPid ?? process.ppid
  if (Number.isInteger(pid) && pid > 0) line.pid = pid

  // The ONE field carrying words an agent produced, bounded here rather than by
  // its reader. Everything else in the payload — `tool_input` above all — is
  // dropped before the line is formed.
  if (typeof input.message === 'string' && input.message.length > 0) {
    line.message = input.message.slice(0, MESSAGE_MAX)
  }

  return `${JSON.stringify(line)}\n`
}

/**
 * Append one line, and never let a failure reach the agent.
 *
 * Returns an exit code for the caller to pass to `exit`, and it is always 0 —
 * the return type says `0` rather than `number` so a future edit that tries to
 * fail loudly does not typecheck.
 */
export async function runHookCommand(
  stdin: string,
  options: HookRunOptions = {},
): Promise<0> {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(stdin)
    } catch {
      return 0
    }

    const line = beaconLineFor(payload, options)
    if (line === null) return 0

    const dir = installationBeaconDir(options.dataRoot ?? defaultDataRoot())
    // The runner owns the mkdir — ADR-0036, and ADR-0055 names this the one
    // write it is granted: into the installation's own data root, append only.
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, 'claude-hook.jsonl'), line, 'utf8')
    return 0
  } catch {
    // The law, and the reason there is no branch here worth distinguishing: a
    // full disk, a permission refusal and a vanished data root all cost the
    // agent exactly nothing. `doctor` is where an operator learns the witness
    // has seen nothing; their agent must never learn it at all.
    return 0
  }
}

/**
 * Everything on stdin, or `''` when there is none.
 *
 * Wrapped in the same never-throw posture as the rest of this module: a
 * harness that closes the pipe early, or invokes the runner with no stdin at
 * all, produces an empty string that {@link runHookCommand} declines quietly.
 */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * `rhizomorph hook` — the dispatch arm's whole body.
 *
 * Deliberately the one subcommand with no `--help`, no flags and no usage
 * error. Its caller is a harness, not a person: every argv it could be given
 * is ignored, and the only thing it can do with a mistake is exit 0.
 */
export async function runHookCli(
  exit: (code: number) => never,
  options: HookRunOptions = {},
): Promise<never> {
  return exit(await runHookCommand(await readStdin(), options))
}
