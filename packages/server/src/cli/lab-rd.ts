import { type FlagSpec, parseFlags } from './args.js'

/**
 * `rhizomorph lab rd <lane> --model <m> [--corpus local|local+tracker]
 * [--max-turns n] [--agent-command <name>] [--path <dir>] [--json] [--help]`
 * — prd55 ruling 1's R&D hand, from the operator's own command line.
 *
 * Same rule as `parseLabForkArgs` and `parseLabCompareArgs`: nothing here
 * imports from `server/src/lab/`, because `lab/namespace-law.test.ts` allows
 * exactly one importer (`cli/index.ts`) and this is not it. So
 * {@link DEFAULT_AGENT_COMMAND_NAME} and the corpus vocabulary are RESTATED
 * rather than imported from `lab/rd.ts`, and the duplication is load-bearing
 * for the same reason `MODEL_GRAMMAR`'s two copies are: both are literal-pinned
 * in their own tests, which is the mitigation ADR-0012 already records for the
 * capability header's identical split.
 *
 * **NOT YET REGISTERED, and that is deliberate rather than forgotten.**
 * `rhizomorph lab <subcommand>` dispatches in `cli/index.ts`'s `runLabCommand`,
 * which is also the one file the namespace law lets import `lab/rd.ts` — and
 * that file is outside this lane's fence, so the registration and the runner
 * are a widening the conductor records before the change. Until then
 * `rhizomorph lab rd` prints the namespace's unknown-subcommand error, and
 * neither `labHelpText()` nor README's CLI row advertises it: a help table
 * naming a subcommand that does not dispatch is exactly the stale-row failure
 * `cli-surface-law.test.ts` exists to prevent, one level down. The parsing and
 * the usage text land ready and proven; the wiring is one commit.
 */
export interface LabRdArgs {
  /** The lane the run is booked to — every rd.* payload carries it. */
  lane: string
  /** The model the hand runs. Required: prd55 ruling 1's own signature names it, and a hand that spends money does not pick its own model. */
  model: string
  /** Which corpus the hand reads (prd55 ruling 2). `local` unless the operator declares otherwise. */
  corpus: 'local' | 'local+tracker'
  /** Bound on the hand's turns; undefined leaves the CLI's own default in place. */
  maxTurns: number | undefined
  /** The binary to look for on PATH. Undefined means the default — `lab.agentCommand`'s own default, restated below. */
  agentCommand: string | undefined
  /** The watched repo, whose record is the corpus and whose log the events land in; undefined defaults to the current directory. */
  path: string | undefined
  /**
   * Print the run as one JSON document instead of the human report. The same
   * door `lab compare --json` opens for `api/lab.ts`'s measure route: `runCli`
   * is the only way in that the namespace law leaves a route, and a typed
   * document is a thing a route can trust where prose is a thing it would have
   * to guess at.
   */
  json: boolean
  help: boolean
}

/** Restated from `lab/rd.ts`'s `DEFAULT_AGENT_COMMAND`, for the reason on {@link LabRdArgs}. Literal-pinned in `lab-rd.test.ts`. */
const DEFAULT_AGENT_COMMAND_NAME = 'claude'

/** Restated from `lab/rd.ts`'s `RdCorpusChoice`, same reason, same pinning. */
const CORPUS_CHOICES = ['local', 'local+tracker'] as const

/** `rhizomorph lab rd`'s own usage table. */
export function labRdHelpText(): string {
  return `rhizomorph lab rd <lane> --model <m> [options]

Reads this repo's own record, hands it to YOUR agent CLI in print mode with no
tools granted, and records the patterns it grouped and the experiments it
proposes. prd55 ruling 1: the R&D hand is your CLI, spawned as an explicit act
— this instrument holds no credential, and whatever the call spends is spent
under your own login (ADR-0048).

The corpus is local first (prd55 ruling 2): the measured verdicts and their
details, the lab's own experiments, and this repo's 'docs/research/*-retro.md'
and 'docs/review/*.md'. Reading closed issues through your own 'gh' is a
second, separately declared act — '--corpus local+tracker' — and which corpus
produced a run is recorded on every event it writes.

A proposal against a pattern that occurred once, or one whose arms differ in
more than one dimension, is REFUSED and recorded as a refusal with its reason
(prd55 ruling 3). Nothing is patched into legality on the way through.

Arguments:
  lane                    The lane this run is booked to

Options:
  --model <m>             Which model the hand runs. Required: a call that spends
                          money does not choose its own model
  --corpus <c>            "${CORPUS_CHOICES[0]}" (default) or "${CORPUS_CHOICES[1]}"
  --max-turns <n>         Bound the hand to n turns
  --agent-command <name>  The binary to look for on this machine's PATH
                          (default: "${DEFAULT_AGENT_COMMAND_NAME}"; the console reads the
                          operator's own 'lab.agentCommand' setting and passes it here).
                          Absent from PATH, nothing is spawned and the answer says so
  --path <dir>            The watched repo, whose record is the corpus (default: current directory)
  --json                  Print the run as one JSON document instead of the report
  --help, -h              Show this help and exit
`
}

export function parseLabRdArgs(argv: readonly string[]): LabRdArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return {
      lane: '',
      model: '',
      corpus: 'local',
      maxTurns: undefined,
      agentCommand: undefined,
      path: undefined,
      json: false,
      help: true,
    }
  }

  let modelArg: string | undefined
  let corpusArg: string | undefined
  let maxTurnsArg: string | undefined
  let agentCommandArg: string | undefined
  let pathArg: string | undefined
  let json = false

  const specs: FlagSpec[] = [
    { flag: '--model', read: (v) => { modelArg = v } },
    { flag: '--corpus', read: (v) => { corpusArg = v } },
    { flag: '--max-turns', read: (v) => { maxTurnsArg = v } },
    { flag: '--agent-command', read: (v) => { agentCommandArg = v } },
    { flag: '--path', read: (v) => { pathArg = v } },
    { flag: '--json', boolean: true, read: () => { json = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const lane = positionals[0]
  if (lane === undefined || lane.trim().length === 0) {
    throw new Error('missing required argument: <lane>')
  }

  // Required rather than defaulted. prd55 ruling 1's signature names
  // `--model <m>`, and the reason it is not optional is the money: a default
  // would pick, silently, which model an operator pays for.
  if (modelArg === undefined) {
    throw new Error('missing required option: --model <m> (a call that spends money does not choose its own model)')
  }
  if (modelArg.trim().length === 0) {
    throw new Error('invalid --model value: (must be a non-empty model name)')
  }

  const corpus = corpusArg ?? CORPUS_CHOICES[0]
  if (corpus !== CORPUS_CHOICES[0] && corpus !== CORPUS_CHOICES[1]) {
    throw new Error(
      `invalid --corpus value: "${corpusArg}" (must be "${CORPUS_CHOICES[0]}" or "${CORPUS_CHOICES[1]}" — ` +
        'reading the tracker is a second act, and there is no third corpus)',
    )
  }

  const maxTurns = maxTurnsArg === undefined ? undefined : Number(maxTurnsArg)
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error(`invalid --max-turns value: "${maxTurnsArg}" (must be a positive integer)`)
  }

  if (agentCommandArg !== undefined && agentCommandArg.trim().length === 0) {
    throw new Error('invalid --agent-command value: (must be a non-empty binary name)')
  }
  // A binary name is one word this instrument hands to a spawn, never to a
  // shell — but a name carrying whitespace is a name that would look like two
  // arguments to any reader of the recorded argv, so it is refused here rather
  // than reported later as a missing binary.
  if (agentCommandArg !== undefined && /\s/.test(agentCommandArg.trim())) {
    throw new Error(`invalid --agent-command value: "${agentCommandArg}" (a binary name is one word, not a command line)`)
  }

  return {
    lane,
    model: modelArg,
    corpus,
    maxTurns,
    agentCommand: agentCommandArg,
    path: pathArg,
    json,
    help: false,
  }
}
