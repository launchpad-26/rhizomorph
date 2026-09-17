import type { AgentRole } from '@rhizomorph/core'
import { readOrMintInstallationId } from '../log/installation-id.js'

/**
 * Renders the exact env block a lane (or the conductor) needs so its `claude`
 * process exports OTLP/HTTP JSON straight to this server's receiver
 * (`packages/server/src/api/otel.ts`, routes registered at the app root).
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the *base* endpoint — the OTel SDK appends
 * `/v1/metrics`, `/v1/logs` and (once `OTEL_TRACES_EXPORTER` is set,
 * prd9 ruling 3) `/v1/traces` itself, which is exactly where those routes
 * live. Export intervals are shortened from the SDK's 60s (traces: 5s)
 * default so the spend ticker and the trace waterfall both read as live, not
 * stale (research note §S1 used the same env vars, just shorter still, for a
 * one-shot `-p` capture).
 *
 * Identity is declared here and nowhere else (prd2's ruling): the block names
 * the lane, its role, and — since #60 — the **instance** the telemetry belongs
 * to. The receiver refuses any export that does not carry its own instance id,
 * so an env block generated without one is telemetry that will be thrown away.
 *
 * **Which id that is changed in prd-57 ruling 7 — see {@link installationInstanceId}.**
 */
/**
 * The shells `rhizomorph env` can render for (#140): a Windows conductor has
 * no `export`/`eval` and needs its own native assignment syntax. `sh` is the
 * default and must stay byte-for-byte what it always was — `.workmux.yaml`
 * and every doc built on it assume that exact output.
 */
export const ENV_SHELLS = ['sh', 'powershell', 'cmd'] as const
export type EnvShell = (typeof ENV_SHELLS)[number]

export interface TelemetryEnvOptions {
  lane: string
  role: AgentRole
  port: number
  /**
   * The receiving Rhizomorph's instance id — the INSTALLATION id since prd-57
   * ruling 7 ({@link installationInstanceId}), where it used to be the session
   * id. Required, not defaulted: a block without it is refused.
   */
  instance: string
  /** Which shell's assignment syntax to render. Defaults to `sh` (today's only form). */
  shell?: EnvShell
}

const METRIC_EXPORT_INTERVAL_MS = 5000
const LOGS_EXPORT_INTERVAL_MS = 2000
/** Shortened from the SDK's 5000ms beta default (research note §1), same reasoning as the other two intervals. */
const TRACES_EXPORT_INTERVAL_MS = 1000

export function otlpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Where the instance id lives. Same host and port as the receiver itself. */
export function metaUrl(port: number): string {
  return `${otlpEndpoint(port)}/api/meta`
}

/** One assignment line, in the target shell's own syntax. */
function renderAssignment(shell: EnvShell, key: string, value: string): string {
  switch (shell) {
    case 'sh':
      return `export ${key}=${value}`
    case 'powershell':
      return `$env:${key} = "${value}"`
    case 'cmd':
      return `set ${key}=${value}`
  }
}

export function renderTelemetryEnv({ lane, role, port, instance, shell = 'sh' }: TelemetryEnvOptions): string {
  const vars: Array<[string, string]> = [
    ['CLAUDE_CODE_ENABLE_TELEMETRY', '1'],
    ['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', '1'],
    ['OTEL_METRICS_EXPORTER', 'otlp'],
    ['OTEL_LOGS_EXPORTER', 'otlp'],
    ['OTEL_TRACES_EXPORTER', 'otlp'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', otlpEndpoint(port)],
    ['OTEL_METRIC_EXPORT_INTERVAL', String(METRIC_EXPORT_INTERVAL_MS)],
    ['OTEL_LOGS_EXPORT_INTERVAL', String(LOGS_EXPORT_INTERVAL_MS)],
    ['OTEL_TRACES_EXPORT_INTERVAL', String(TRACES_EXPORT_INTERVAL_MS)],
    ['OTEL_RESOURCE_ATTRIBUTES', `lane=${lane},role=${role},instance=${instance}`],
  ]

  return `${vars.map(([key, value]) => renderAssignment(shell, key, value)).join('\n')}\n`
}

export interface FetchInstanceIdOptions {
  /** Injectable `fetch`, so a unit test needs no socket. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

/** What `rhizomorph env` needs from the running instance: which run this is, and which repo it watches. */
export interface InstanceMeta {
  sessionId: string
  repoPath: string
}

/**
 * The running Rhizomorph's identity and the repo it watches, read from its
 * `/api/meta`.
 *
 * **The server must be running when env is generated.** That is not a
 * limitation worth working around: at dispatch time it always is (a lane is
 * started to be watched), and the alternative — inventing an id locally — is
 * precisely the guessed identity prd2 exists to remove. If nothing answers,
 * this throws with a message saying what to start, because a lane dispatched
 * with no instance id would export telemetry the receiver then refuses.
 *
 * `--hooks` reads `repoPath` off this same `/api/meta` scrape for the same
 * reason the instance id is read there — only the running Rhizomorph knows
 * which repo's beacon directory a hook should write to.
 */
export async function fetchInstanceMeta(
  port: number,
  options: FetchInstanceIdOptions = {},
): Promise<InstanceMeta> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const url = metaUrl(port)

  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (err) {
    throw new Error(unreachable(port, err instanceof Error ? err.message : String(err)))
  }
  if (!response.ok) {
    throw new Error(unreachable(port, `${url} answered HTTP ${response.status}`))
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(unreachable(port, `${url} did not answer JSON: ${err instanceof Error ? err.message : String(err)}`))
  }

  const sessionId = typeof body === 'object' && body !== null ? (body as { sessionId?: unknown }).sessionId : undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(unreachable(port, `${url} reported no session id — is an Rhizomorph really listening there?`))
  }

  const repoPath = typeof body === 'object' && body !== null ? (body as { repoPath?: unknown }).repoPath : undefined
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    throw new Error(unreachable(port, `${url} reported no repo path — is an Rhizomorph really listening there?`))
  }

  return { sessionId, repoPath }
}

/**
 * THE ID AN ENV BLOCK DECLARES — prd-57 ruling 7.
 *
 * It was the session id, fetched from the running server, and the module doc
 * above used to say why in as many words: *inventing an id locally is precisely
 * the guessed identity prd2 exists to remove.* That sentence was right about a
 * session id and is not right about this one, and the difference is worth
 * stating rather than quietly dropping.
 *
 * A session id is known only to the process holding it — minted at boot, never
 * written anywhere a second process could read, so a caller that did not ask
 * the server would be GUESSING. An installation id is the opposite kind of
 * thing: one file under the data root, minted once, and the server reads that
 * same file rather than owning the value (`api/otel.ts`). Two processes reading
 * one file cannot disagree, so there is nothing left to guess and nothing to
 * ask for.
 *
 * **The bound, stated:** they agree when they resolve the same data root, which
 * is the same `RHIZOMORPH_DATA_DIR`-or-default resolution both run
 * (`log/paths.ts`). An operator who deliberately pointed one of them elsewhere
 * gets two ids and a refusal that names both — which is the loud failure, not
 * the invisible one.
 *
 * Minting here is correct and not a side effect to apologise for: whichever of
 * the CLI or the server touches it first mints it, the create is atomic, and a
 * loser re-reads the winner's id (`log/installation-id.ts`).
 */
export function installationInstanceId(options: { dataRoot?: string } = {}): string {
  return readOrMintInstallationId({ dataRoot: options.dataRoot }).id
}

/**
 * The SESSION id of the Rhizomorph listening on `port`, read from its
 * `/api/meta`. A thin wrapper over {@link fetchInstanceMeta} for callers that
 * need to know which run this is — which, since ruling 7, is no longer what an
 * env block declares. Not the same value as {@link installationInstanceId} and
 * never interchangeable with it.
 */
export async function fetchInstanceId(
  port: number,
  options: FetchInstanceIdOptions = {},
): Promise<string> {
  return (await fetchInstanceMeta(port, options)).sessionId
}

function unreachable(port: number, detail: string): string {
  return `cannot read this Rhizomorph's instance id on port ${port}: ${detail}
Start the server first (\`npm start -- --port ${port}\`) — \`rhizomorph env\` reads the id from its /api/meta, and the receiver refuses telemetry that doesn't carry it.`
}
