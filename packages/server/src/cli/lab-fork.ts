import { type FlagSpec, parseFlags } from './args.js'

/**
 * `rhizomorph lab fork <lane> [--at <checkpointId>] [--model <m>]
 * [--prompt-file <f>] [--arms <n>] [--runs <r>] [--fork-id <id>]
 * [--arm-number <k>] [--path <dir>] [--launch] [--help]`.
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
  /** Runs of each arm (prd53 ruling 1). 1 unless asked. */
  runs: number
  /** Dispatch into this existing fork instead of minting one — the launch's one-per-experiment id. */
  forkId: string | undefined
  /** Which arm this call dispatches; only meaningful with `--arms 1`, and refused otherwise. */
  armNumber: number | undefined
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
one corruption this design makes impossible). Each run of each arm is recorded
as a fork.dispatched event, which is what marks its lane synthetic everywhere.

Arguments:
  lane                    Lane to fork — the one whose checkpoints are read

Options:
  --at <checkpointId>     Checkpoint to fork from (default: that lane's most recent)
  --model <m>             Model each arm's agent runs (default: the fleet default)
  --prompt-file <f>       Prompt file handed to each arm; its sha256 is the treatment's identity
  --arms <n>              How many arms (default: ${DEFAULT_FORK_ARMS} — prd12 ruling 4's floor for comparison)
  --runs <r>              How many runs of each arm (default: 1). An arm is one treatment; a
                          run is one restored reality of it. Three runs of one arm is what
                          a summary needs before it may say anything (prd53 ruling 1)
  --fork-id <id>          Dispatch into an existing experiment instead of minting a new one —
                          what the /lab launch passes so n treatments stay ONE fork
  --arm-number <k>        Which arm this call dispatches (default: 1; requires --arms 1)
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
      runs: 1,
      forkId: undefined,
      armNumber: undefined,
      path: undefined,
      launch: false,
      help: true,
    }
  }

  let atArg: string | undefined
  let modelArg: string | undefined
  let promptFileArg: string | undefined
  let armsArg: string | undefined
  let runsArg: string | undefined
  let forkIdArg: string | undefined
  let armNumberArg: string | undefined
  let pathArg: string | undefined
  let launch = false

  const specs: FlagSpec[] = [
    { flag: '--at', read: (v) => { atArg = v } },
    { flag: '--model', read: (v) => { modelArg = v } },
    { flag: '--prompt-file', read: (v) => { promptFileArg = v } },
    { flag: '--arms', read: (v) => { armsArg = v } },
    { flag: '--runs', read: (v) => { runsArg = v } },
    { flag: '--fork-id', read: (v) => { forkIdArg = v } },
    { flag: '--arm-number', read: (v) => { armNumberArg = v } },
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
  if (forkIdArg !== undefined && forkIdArg.trim().length === 0) {
    throw new Error('invalid --fork-id value: (must be a non-empty fork id)')
  }

  const arms = armsArg === undefined ? DEFAULT_FORK_ARMS : Number(armsArg)
  if (!Number.isInteger(arms) || arms < 1) {
    throw new Error(`invalid --arms value: "${armsArg}" (must be a positive integer)`)
  }
  const runs = runsArg === undefined ? 1 : Number(runsArg)
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`invalid --runs value: "${runsArg}" (must be a positive integer)`)
  }
  // The number names THIS arm, so it only means something when this call
  // dispatches exactly one. `--arms 3 --arm-number 2` would have to mean
  // "arms 2, 3 and 4" — a grammar nobody asked for, refused rather than guessed.
  const armNumber = armNumberArg === undefined ? undefined : Number(armNumberArg)
  if (armNumber !== undefined && (!Number.isInteger(armNumber) || armNumber < 1)) {
    throw new Error(`invalid --arm-number value: "${armNumberArg}" (must be a positive integer)`)
  }
  if (armNumber !== undefined && arms !== 1) {
    throw new Error(`--arm-number requires --arms 1 (received --arms ${arms}): the number names the one arm this call dispatches`)
  }

  return {
    lane,
    at: atArg,
    model: modelArg,
    promptFile: promptFileArg,
    arms,
    runs,
    forkId: forkIdArg,
    armNumber,
    path: pathArg,
    launch,
    help: false,
  }
}
