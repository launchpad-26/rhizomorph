import { parseFlags, type FlagSpec } from './args.js'

/**
 * `rhizomorph lab checkpoint <lane> [--path <dir>] [--captured-by <who>]
 * [--help]`. The `lab` namespace is prd12 ruling 1's second hand — kept out
 * of `cli/index.ts`'s flat top-level commands on purpose, so every
 * invocation reads `rhizomorph lab ...` and the second hand stays visible.
 *
 * This module intentionally does NOT import anything from
 * `server/src/lab/` — the namespace law test (`lab/namespace-law.test.ts`)
 * asserts only `cli/index.ts` may. `capturedBy`'s value set is duplicated
 * here rather than imported for exactly that reason.
 */
export interface LabCheckpointArgs {
  lane: string
  /** Worktree to snapshot; undefined defaults to the current directory. */
  path: string | undefined
  capturedBy: 'dispatch' | 'gate' | 'operator'
  help: boolean
}

const LAB_CAPTURED_BY_VALUES = ['dispatch', 'gate', 'operator'] as const
const DEFAULT_CAPTURED_BY: LabCheckpointArgs['capturedBy'] = 'operator'

function isCapturedBy(value: string): value is LabCheckpointArgs['capturedBy'] {
  return (LAB_CAPTURED_BY_VALUES as readonly string[]).includes(value)
}

/** `rhizomorph lab checkpoint`'s own usage table. */
export function labCheckpointHelpText(): string {
  return `rhizomorph lab checkpoint <lane> [options]

Captures a live checkpoint: a git workspace snapshot (temp-index recipe —
tracked-modified, staged and untracked files in one commit, working tree
byte-for-byte untouched) bound to the current byte offset and digest of the
lane's Claude Code session file. Emits an additive fork.checkpoint event
through the same recorder a running rhizomorph writes to. Writes only a ref
under refs/rhizomorph/checkpoints/ and the objects it requires — never
pushes, merges, or touches an operator branch.

Arguments:
  lane                    Lane handle this checkpoint is captured for

Options:
  --path <dir>            Worktree to snapshot (default: current directory)
  --captured-by <who>     ${LAB_CAPTURED_BY_VALUES.join(' | ')} (default: ${DEFAULT_CAPTURED_BY})
  --help, -h              Show this help and exit
`
}

export function parseLabCheckpointArgs(argv: readonly string[]): LabCheckpointArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { lane: '', path: undefined, capturedBy: DEFAULT_CAPTURED_BY, help: true }
  }

  let pathArg: string | undefined
  let capturedByArg: string | undefined

  const specs: FlagSpec[] = [
    { flag: '--path', read: (v) => { pathArg = v } },
    { flag: '--captured-by', read: (v) => { capturedByArg = v } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  const capturedBy = capturedByArg === undefined ? DEFAULT_CAPTURED_BY : capturedByArg
  if (!isCapturedBy(capturedBy)) {
    throw new Error(
      `invalid --captured-by value: "${capturedByArg}" (must be one of ${LAB_CAPTURED_BY_VALUES.join(', ')})`,
    )
  }

  return { lane, path: pathArg, capturedBy, help: false }
}
