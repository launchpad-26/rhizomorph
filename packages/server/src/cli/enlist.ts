import { DEFAULT_PORT, type FlagSpec, parseFlags } from './args.js'
import { capabilityAwareFetch } from './rotate.js'
import { otlpEndpoint } from './telemetry-env.js'

/**
 * `rhizomorph enlist <harness>` and `rhizomorph unenlist <harness>` — prd-57
 * ruling 4's CLI twin of the dashboard's button.
 *
 * ## It reaches the hand THROUGH THE ROUTE, never by import
 *
 * This is the constraint that shapes the whole file.
 * `concierge/namespace-law.test.ts` declares exactly one importer of
 * `concierge/` — `api/concierge.ts` — and a declared importer is a TERMINUS,
 * not a preference: everything above it inherits its grant and nothing else
 * acquires one. A `cli/enlist.ts` that imported `concierge/enlist.ts` would be
 * a second, undeclared chain into the fourth hand, and **this PRD declares no
 * widening of `ALLOWED_IMPORTERS`.**
 *
 * The repo has met this wall before and its answer was not to widen the fence:
 * `harness-roster.ts` exists because `cli/doctor.ts` needed harness DATA, so
 * the data moved out rather than the grant moving in. The answer here is the
 * same shape one level up — the CLI speaks HTTP to the running server, the
 * grant stays in the one file that holds it, and this module holds none of it.
 *
 * The cost is honest and stated in the help text: `enlist` needs a server
 * already running and says so rather than starting one. A CLI that booted a
 * server to make one request would be a second way to acquire the fourth
 * hand's powers wearing a convenience's clothes.
 *
 * ## Two requests, one token scrape
 *
 * `POST /api/concierge/enlist` is token-gated, and this is a different process
 * from the one that minted the token — so it reads it the way the dashboard
 * does, through {@link capabilityAwareFetch}, the shared scrape helper
 * `rhizomorph env` and `rhizomorph doctor` already go through (prd-29 ruling
 * 7, #59). That helper's docblock records a saving it had no caller for:
 * the token is fetched **once per returned function**, so a command making
 * several requests through one `capabilityAwareFetch(port)` pays the extra
 * loopback `GET /` once. An `--apply` makes two gated requests. It is the
 * first command in this package to actually collect that saving, which is why
 * the function is built once, above both calls, rather than per request.
 *
 * ## The two-step is the ROUTE's, and this command honours it
 *
 * The first request returns the diff and writes nothing; the second sends back
 * the digest the first one carried. So `--apply` is not a flag that skips a
 * confirmation — it is the second act, and a digest the server cannot tie to a
 * diff somebody saw is a write nobody approved. Running without `--apply`
 * prints what would change and exits 0, having written nothing.
 */

export interface EnlistArgs {
  readonly harness: string
  readonly apply: boolean
  readonly port: number
  readonly help: boolean
}

/** What the caller wants. The two subcommands differ in this word and nothing else. */
export type EnlistIntent = 'enlist' | 'unenlist'

export interface EnlistCommandOptions {
  /** Injectable `fetch`, so a test needs no socket. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

export function enlistUrl(port: number): string {
  return `${otlpEndpoint(port)}/api/concierge/enlist`
}

export function enlistHelpText(intent: EnlistIntent): string {
  const other: EnlistIntent = intent === 'enlist' ? 'unenlist' : 'enlist'
  const what =
    intent === 'enlist'
      ? `Adds rhizomorph's telemetry variables and lifecycle hooks to a harness's own
user-level configuration, so the instrument can witness agents it did not
launch. Writes exactly one file, never inside a repository, and copies the
original beside it first.`
      : `Removes exactly what \`rhizomorph enlist\` added from a harness's user-level
configuration, leaving everything else — including your own hooks and your own
variables — untouched.`

  return `rhizomorph ${intent} <harness> [options]

${what}

Prints the diff and writes NOTHING unless --apply is given. The server refuses
an --apply that does not match the diff it just showed you, so a file edited in
between is never silently overwritten.

This asks the RUNNING server on --port, the same way 'rhizomorph rotate' and
'rhizomorph env' do. It does not start one: the power to write in your home
directory lives in exactly one module, reached through exactly one route, and a
CLI that booted a server to borrow it would be a second way in.

Arguments:
  harness                 Which harness to ${intent} (currently: claude)

Options:
  --apply                 Perform the change, after printing the diff again
  --port <n>              rhizomorph server port to target (default: ${DEFAULT_PORT})
  --help, -h              Show this help and exit

See also: rhizomorph ${other}, rhizomorph doctor
`
}

export function parseEnlistArgs(argv: readonly string[], intent: EnlistIntent): EnlistArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { harness: '', apply: false, port: DEFAULT_PORT, help: true }
  }

  let portArg: string | undefined
  let apply = false
  const specs: FlagSpec[] = [
    { flag: '--port', read: (v) => { portArg = v } },
    { flag: '--apply', boolean: true, read: () => { apply = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const harness = positionals[0]
  if (harness === undefined || harness.length === 0) {
    throw new Error(`which harness? e.g. "rhizomorph ${intent} claude"`)
  }
  const stray = positionals[1]
  if (stray !== undefined) {
    // A repo path is the natural guess and it would be wrong: enlistment is
    // about the operator's HOME, and the server on --port already knows which
    // repo it watches.
    throw new Error(
      `unexpected argument: "${stray}" (${intent} takes one harness and no path — it writes user-level configuration, not repository configuration)`,
    )
  }

  const port = portArg === undefined ? DEFAULT_PORT : Number(portArg)
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid --port value: "${portArg}" (must be a non-negative integer)`)
  }

  return { harness, apply, port, help: false }
}

/**
 * The route's answer, as much of it as this command reads.
 *
 * Every field optional and every read guarded, because this is one process
 * parsing another process's JSON — a server of a different version, or no
 * rhizomorph at all, must produce a sentence rather than a `TypeError`.
 */
export interface EnlistResponse {
  readonly kind?: unknown
  readonly why?: unknown
  readonly remedy?: unknown
  readonly error?: unknown
  readonly applied?: unknown
  readonly target?: { readonly display?: unknown }
  readonly changes?: readonly { readonly keyPath?: unknown; readonly before?: unknown; readonly after?: unknown }[]
  readonly refusals?: readonly {
    readonly keyPath?: unknown
    readonly existing?: unknown
    readonly reason?: unknown
    readonly offer?: unknown
  }[]
  readonly sourceDigest?: unknown
  readonly backupPath?: unknown
  readonly changedKeys?: unknown
}

export interface EnlistExchange {
  readonly status: number
  readonly body: EnlistResponse
}

/**
 * One request to the running server. `fetchImpl` is expected to be a
 * {@link capabilityAwareFetch}, which attaches the gate's header — this
 * function never handles a token itself.
 */
export async function requestEnlistment(
  port: number,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<EnlistExchange> {
  const response = await fetchImpl(enlistUrl(port), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: EnlistResponse = {}
  try {
    parsed = (await response.json()) as EnlistResponse
  } catch {
    // A body that is not JSON is still a status worth reporting, and the
    // caller's refusal line falls back to it.
  }
  return { status: response.status, body: parsed }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const keyOf = (value: unknown): string => (Array.isArray(value) ? value.join('.') : String(value ?? '?'))

/**
 * The plan, rendered for a terminal.
 *
 * Refusals come LAST and are never dropped on the settled arm — that arm is
 * precisely the one that otherwise reads as "everything is fine", and a second
 * enlist over a foreign OTLP endpoint changes nothing AND leaves something
 * untouched (the same fact `EnlistmentPlan` carries refusals on `already-settled`
 * for).
 */
export function renderEnlistmentPlan(body: EnlistResponse): string[] {
  const lines: string[] = []
  const display = text(body.target?.display)
  if (display !== null) lines.push(display)

  if (body.kind === 'already-settled') {
    lines.push(`  nothing to do — ${text(body.why) ?? 'already settled'}`)
  } else if (body.kind === 'refused') {
    lines.push(`  refused — ${text(body.why) ?? 'no reason given'}`)
    const remedy = text(body.remedy)
    if (remedy !== null) lines.push(`  ${remedy}`)
  } else {
    for (const change of body.changes ?? []) {
      const key = keyOf(change.keyPath)
      const before = text(change.before)
      const after = text(change.after)
      if (before === null) lines.push(`  + ${key} = ${after ?? 'null'}`)
      else if (after === null) lines.push(`  - ${key} (was ${before})`)
      else lines.push(`  ~ ${key}: ${before} -> ${after}`)
    }
  }

  for (const refusal of body.refusals ?? []) {
    lines.push(`  ! ${keyOf(refusal.keyPath)} left alone — ${text(refusal.reason) ?? 'refused'}`)
    const existing = text(refusal.existing)
    if (existing !== null) lines.push(`    found: ${existing}`)
    const offer = text(refusal.offer)
    if (offer !== null) lines.push(`    still on the table: ${offer}`)
  }
  return lines
}

/** The server's own `{ error }` when it has one, else the bare status. */
function refusal(exchange: EnlistExchange): string {
  return text(exchange.body.error) ?? `the server on this port refused with HTTP ${exchange.status}`
}

function unreachable(port: number, detail: string): string {
  return `cannot reach a rhizomorph on port ${port}: ${detail}
Enlistment is performed BY the running instrument — it is the process that knows its own port and session, which is what the written configuration points a harness at. Start it (\`npm start -- --port ${port}\`), or use the dashboard's own enlist button.`
}

/**
 * `rhizomorph enlist <harness>` / `rhizomorph unenlist <harness>`.
 *
 * Same clean-usage-error contract as every other subcommand here: a bad argv
 * or an unreachable server prints to stderr and exits 1, `--help` prints to
 * stdout and exits 0, no stack trace either way.
 */
export async function runEnlistCommand(
  rest: readonly string[],
  intent: EnlistIntent,
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: EnlistCommandOptions = {},
): Promise<never> {
  let args: EnlistArgs
  try {
    args = parseEnlistArgs(rest, intent)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${enlistHelpText(intent)}`)
    return exit(1)
  }

  if (args.help) {
    log.log(enlistHelpText(intent))
    return exit(0)
  }

  // Built once, above both requests: the token scrape is paid by the first
  // call through this function and by nothing after it.
  const rhizomorphFetch = capabilityAwareFetch(args.port, { fetch: options.fetch ?? globalThis.fetch })

  let diff: EnlistExchange
  try {
    diff = await requestEnlistment(args.port, { harness: args.harness, intent, apply: false }, rhizomorphFetch)
  } catch (err) {
    process.stderr.write(`${unreachable(args.port, err instanceof Error ? err.message : String(err))}\n`)
    return exit(1)
  }

  if (diff.status !== 200) {
    process.stderr.write(`${refusal(diff)}\n`)
    return exit(1)
  }

  for (const line of renderEnlistmentPlan(diff.body)) log.log(line)

  const digest = text(diff.body.sourceDigest)

  /**
   * A REFUSED plan exits 1, with or without `--apply`, and that is
   * `rhizomorph doctor`'s rule rather than a new one: a read-only report whose
   * content is a failure exits non-zero even though the reporting itself
   * succeeded (`cli/doctor.ts`'s `FAILING_CHECK_IDS`). Reading a refusal is not
   * a failure of the read, but it is a failure to enlist, and a script chaining
   * on this cannot tell those apart from the text.
   *
   * `already-settled` is the opposite and stays 0: the operator asked for a
   * state the machine is already in, which is what idempotence means, and a
   * boot script running `enlist --apply` every time must not start failing on
   * the second run.
   */
  const refusedCode = diff.body.kind === 'refused' ? 1 : 0

  if (!args.apply) {
    // Said explicitly rather than implied by the absence of output: the whole
    // promise of the first act is that nothing happened.
    if (diff.body.kind === 'ready') {
      log.log(`\nNothing was written. Run the same command with --apply to make these changes.`)
    }
    return exit(refusedCode)
  }
  if (diff.body.kind !== 'ready' || digest === null) {
    // Nothing to send: there is no digest, because there is nothing to write.
    // Same code as the diff-only path above, decided in one place.
    return exit(refusedCode)
  }

  let applied: EnlistExchange
  try {
    applied = await requestEnlistment(
      args.port,
      { harness: args.harness, intent, apply: true, sourceDigest: digest },
      rhizomorphFetch,
    )
  } catch (err) {
    process.stderr.write(`${unreachable(args.port, err instanceof Error ? err.message : String(err))}\n`)
    return exit(1)
  }

  if (applied.status !== 200) {
    process.stderr.write(`${refusal(applied)}\n`)
    return exit(1)
  }

  const changed = Array.isArray(applied.body.changedKeys) ? applied.body.changedKeys.length : 0
  log.log(`\napplied — ${changed} key${changed === 1 ? '' : 's'} changed`)
  const backup = text(applied.body.backupPath)
  if (backup !== null) log.log(`the file as it was is at ${backup}`)
  return exit(0)
}
