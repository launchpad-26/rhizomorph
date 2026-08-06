import { parseFlags, type FlagSpec } from './args.js'

/**
 * `rhizomorph lab fork <lane> [--at <checkpointId>] [--model <m>]
 * [--prompt-file <f>] [--arms <n>] [--path <dir>] [--launch] [--help]`.
 *
 * Same rule as `parseLabCheckpointArgs`: nothing here imports from
 * `server/src/lab/`, so the namespace law's one allowed importer stays one.
 * `DEFAULT_ARMS` is therefore restated rather than imported — and the
 * duplication is load-bearing, not laziness.
 */
export interface LabForkArgs {
  lane: string
  /** Checkpoint to fork from; undefined takes the lane's most recent. */
  at: string | undefined
  model: string | undefined
  promptFile: string | undefined
  arms: number
  /** The parent lane's worktree; undefined defaults to the current directory. */
  path: string | undefined
  /** Run the workmux launcher too. Off by default — see `lab/fork.ts`'s module doc. */
  launch: boolean
  help: boolean
}

/** prd12 ruling 4's floor, restated here for the reason given on {@link LabForkArgs}. */
const DEFAULT_FORK_ARMS = 3

/** `rhizomorph lab fork`'s own usage table. */
export function labForkHelpText(): string {
  return `rhizomorph lab fork <lane> [options]

Restores n independent realities from one of a lane's checkpoints. Each arm
gets its own detached worktree under the lab's data dir, restored at the
checkpoint's snapshot (the parent's uncommitted work included), and its own
Claude Code session: the parent's conversation cut at the checkpoint, digest-
verified, with every absolute path into the parent worktree rewritten to the
arm's own tree (prd12 ruling 5 — an agent acting on its parent's files is the
one corruption this design makes impossible). Each arm is recorded as a
fork.dispatched event, which is what marks its lane synthetic everywhere.

Arguments:
  lane                    Lane to fork — the one whose checkpoints are read

Options:
  --at <checkpointId>     Checkpoint to fork from (default: that lane's most recent)
  --model <m>             Model each arm's agent runs (default: the fleet default)
  --prompt-file <f>       Prompt file handed to each arm; its sha256 is the treatment's identity
  --arms <n>              How many arms (default: ${DEFAULT_FORK_ARMS} — prd12 ruling 4's floor for comparison)
  --path <dir>            The lane's worktree (default: current directory)
  --launch                Also run 'workmux add' for each arm. OFF by default: that
                          creates a refs/heads/ branch and a worktree of workmux's
                          own, neither of which is a namespace prd12 ruling 1 lets
                          the laboratory write to on its own authority. Without it
                          the arms are fully restored and the exact command line for
                          each is printed for you to run.
  --help, -h              Show this help and exit
`
}

export function parseLabForkArgs(argv: readonly string[]): LabForkArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      lane: '',
      at: undefined,
      model: undefined,
      promptFile: undefined,
      arms: DEFAULT_FORK_ARMS,
      path: undefined,
      launch: false,
      help: true,
    }
  }

  let atArg: string | undefined
  let modelArg: string | undefined
  let promptFileArg: string | undefined
  let armsArg: string | undefined
  let pathArg: string | undefined
  let launch = false

  const specs: FlagSpec[] = [
    { flag: '--at', read: (v) => { atArg = v } },
    { flag: '--model', read: (v) => { modelArg = v } },
    { flag: '--prompt-file', read: (v) => { promptFileArg = v } },
    { flag: '--arms', read: (v) => { armsArg = v } },
    { flag: '--path', read: (v) => { pathArg = v } },
    { flag: '--launch', boolean: true, read: () => { launch = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  if (atArg !== undefined && atArg.trim().length === 0) {
    throw new Error('invalid --at value: (must be a non-empty checkpoint id)')
  }
  if (modelArg !== undefined && modelArg.trim().length === 0) {
    throw new Error('invalid --model value: (must be a non-empty model name)')
  }
  if (promptFileArg !== undefined && promptFileArg.trim().length === 0) {
    throw new Error('invalid --prompt-file value: (must be a non-empty file path)')
  }

  const arms = armsArg === undefined ? DEFAULT_FORK_ARMS : Number(armsArg)
  if (!Number.isInteger(arms) || arms < 1) {
    throw new Error(`invalid --arms value: "${armsArg}" (must be a positive integer)`)
  }

  return { lane, at: atArg, model: modelArg, promptFile: promptFileArg, arms, path: pathArg, launch, help: false }
}
