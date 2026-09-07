import { type FlagSpec, parseFlags } from './args.js'

/** `rhizomorph lab compare <fork-id> [--verify <cmd>] [--no-verify] [--json] [--path <dir>] [--help]`. */
export interface LabCompareArgs {
  forkId: string
  /** Gate command each arm is judged by. */
  verify: string
  /** True when `--no-verify` was passed: report the runs without running anything. */
  skipVerify: boolean
  /**
   * Print the comparison as one JSON document instead of the table (prd53
   * ruling 3). The console's measure route reads the laboratory through this
   * flag — `runCli` is the only door the namespace law leaves it — and a typed
   * document is a thing a route can trust where a table is a thing it would
   * have to guess at.
   */
  json: boolean
  path: string | undefined
  help: boolean
}

/** Restated here rather than imported, for the reason given on {@link LabForkArgs} in `lab-fork.ts`. */
const DEFAULT_VERIFY = 'npm test'

/** `rhizomorph lab compare`'s own usage table. */
export function labCompareHelpText(): string {
  return `rhizomorph lab compare <fork-id> [options]

Prints a table of one fork's arms — arm, run, treatment, verified outcome,
cost, duration, commits — and nothing else. prd12 ruling 6: a table, not a
visualization. prd12 ruling 4: distributions, never a winner, and below three
arms not even that — the table shows the runs and says plainly that it will
not rank them.

Arguments:
  fork-id                 The forkId printed by 'rhizomorph lab fork'

Options:
  --verify <cmd>          Gate command run in each arm's worktree (default: "${DEFAULT_VERIFY}")
  --no-verify             Do not run any gate; every arm reports "not-run"
  --json                  Print the comparison as one JSON document instead of the table
                          (what the console's measure route reads; prd53 ruling 3)
  --path <dir>            The parent lane's worktree, whose log holds the fork (default: current directory)
  --help, -h              Show this help and exit
`
}

export function parseLabCompareArgs(argv: readonly string[]): LabCompareArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { forkId: '', verify: DEFAULT_VERIFY, skipVerify: false, json: false, path: undefined, help: true }
  }

  let verifyArg: string | undefined
  let pathArg: string | undefined
  let skipVerify = false
  let json = false

  const specs: FlagSpec[] = [
    { flag: '--verify', read: (v) => { verifyArg = v } },
    { flag: '--no-verify', boolean: true, read: () => { skipVerify = true } },
    { flag: '--json', boolean: true, read: () => { json = true } },
    { flag: '--path', read: (v) => { pathArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const forkId = positionals[0]
  if (forkId === undefined || forkId.trim().length === 0) {
    throw new Error('missing required argument: <fork-id>')
  }

  if (verifyArg !== undefined && verifyArg.trim().length === 0) {
    throw new Error('invalid --verify value: (must be a non-empty command)')
  }
  if (verifyArg !== undefined && skipVerify) {
    throw new Error('--verify and --no-verify contradict each other: pass one or the other')
  }

  return { forkId, verify: verifyArg ?? DEFAULT_VERIFY, skipVerify, json, path: pathArg, help: false }
}
