import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventOf, TraceSpanPayload } from '@rhizomorph/core'
import { defaultDataRoot, repoSlug, sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import { canonicalize, isInside } from '../paths/containment.js'
import { parseFlags, type FlagSpec } from './args.js'
import type { RunCliOptions } from './types.js'

/**
 * prd9's third rung, RULED 2026-08-12: an offline dump, not a live forwarder.
 * `runExportOtlp` reads back the `trace.span` events this Rhizomorph already
 * recorded — never the original exporter stream — and re-serialises them as
 * one OTLP/HTTP JSON `ExportTraceServiceRequest` body, byte-for-byte what an
 * operator would `curl -d @<file>` to Langfuse's
 * `/api/public/otel/v1/traces`. Nothing here ever sends that request: this
 * module has no socket code at all — see `export-otlp.test.ts`'s structural
 * law — so the README's Trust section needs no rewrite. The operator's own
 * hand is the only thing that ever leaves this machine.
 *
 * Reading from the stored events rather than re-parsing anything means
 * `traceSpanPayloadSchema`'s allowlist (prd9 ruling 5) already bounds what
 * can appear here: there is no attributes map on the payload for a stray
 * fact to have landed in, so there is none here to leak either.
 */

export interface ExportOtlpOptions {
  repoPath: string
  /** Overrides `~/.local/share/rhizomorph`; tests point this at a temp dir. */
  dataRoot?: string
  /** Which recorded session to export; defaults to the most recently recorded one. */
  sessionId?: string
  /** Output file path; defaults to alongside the session logs. */
  out?: string
  /** Overwrite `outPath` if it already exists; default is to refuse. */
  force?: boolean
}

export interface ExportOtlpResult {
  outPath: string
  sessionId: string
  spanCount: number
}

/** Parses `rhizomorph export-otlp [path] [--session <id>] [--out <file>] [--force] [--help]`. */
export interface ExportOtlpArgs {
  path: string | undefined
  /** Session id to export; defaults to the most recently recorded one. */
  sessionId: string | undefined
  /** Output file path; defaults to alongside the session logs (see `export-otlp.ts`). */
  out: string | undefined
  /** Overwrite an existing `--out` file instead of refusing. */
  force: boolean
  help: boolean
}

/** `rhizomorph export-otlp`'s own usage table, distinct from the main command's. */
export function exportOtlpHelpText(): string {
  return `rhizomorph export-otlp [path] [options]

Writes one of this repo's recorded sessions' trace spans as an OTLP/HTTP JSON
export-trace request — the same dialect Claude Code's own exporter sends.
The tool never sends this anywhere; replay it into Langfuse yourself, e.g.:

  curl -u <public-key>:<secret-key> \\
    https://<your-langfuse-host>/api/public/otel/v1/traces \\
    -H 'Content-Type: application/json' \\
    -d @<the file this command wrote>

The artifact is written OUTSIDE the watched repo (default: alongside its
session logs), named "<repo-slug>-<session-id>.otlp.json".

Arguments:
  path                    Repo whose recorded sessions to read (default: current directory)

Options:
  --session <id>          Session id to export (default: the most recently recorded session)
  --out <file>            Output file path (default: alongside the session logs)
  --force                 Overwrite --out if it already exists (default: refuse)
  --help, -h              Show this help and exit
`
}

export function parseExportOtlpArgs(argv: readonly string[]): ExportOtlpArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { path: undefined, sessionId: undefined, out: undefined, force: false, help: true }
  }

  let sessionArg: string | undefined
  let outArg: string | undefined
  let force = false

  const specs: FlagSpec[] = [
    { flag: '--session', read: (v) => { sessionArg = v } },
    { flag: '--out', read: (v) => { outArg = v } },
    { flag: '--force', boolean: true, read: () => { force = true } },
  ]

  const positionals = parseFlags(argv, specs)
  const path = positionals[0]

  if (sessionArg !== undefined && sessionArg.trim().length === 0) {
    throw new Error('invalid --session value: (must be a non-empty session id)')
  }
  if (outArg !== undefined && outArg.trim().length === 0) {
    throw new Error('invalid --out value: (must be a non-empty file path)')
  }

  return { path, sessionId: sessionArg, out: outArg, force, help: false }
}

/** OTLP's span status codes (spec / research §1): 0 unset, 1 ok, 2 error. */
function statusCode(status: TraceSpanPayload['status']): number {
  if (status === 'ok') return 1
  if (status === 'error') return 2
  return 0
}

/** Epoch ms back to nanos, as OTLP/JSON exports it: a decimal string, not a `number` (precision). */
function msToNanoString(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString()
}

interface OtlpAttribute {
  key: string
  value: { stringValue: string } | { intValue: string }
}

function strAttr(key: string, value: string | null | undefined): OtlpAttribute | undefined {
  return value === null || value === undefined ? undefined : { key, value: { stringValue: value } }
}

function intAttr(key: string, value: number | null | undefined): OtlpAttribute | undefined {
  return value === null || value === undefined ? undefined : { key, value: { intValue: String(value) } }
}

/**
 * One span's attributes, rebuilt from the payload's own allowlisted fields —
 * the exact keys `collectors/otel/parse-traces.ts` reads on the way in, so a
 * dump fed back to our own `/v1/traces` receiver round-trips.
 */
function spanAttributes(payload: TraceSpanPayload): OtlpAttribute[] {
  return [
    strAttr('session.id', payload.sessionId ?? null),
    strAttr('model', payload.model ?? null),
    intAttr('input_tokens', payload.tokens?.input ?? null),
    intAttr('output_tokens', payload.tokens?.output ?? null),
    intAttr('cache_read_tokens', payload.tokens?.cacheRead ?? null),
    intAttr('cache_creation_tokens', payload.tokens?.cacheCreation ?? null),
    intAttr('ttft_ms', payload.ttftMs ?? null),
    strAttr('request_id', payload.requestId ?? null),
    strAttr('agent_id', payload.agentId ?? null),
    strAttr('parent_agent_id', payload.parentAgentId ?? null),
    strAttr('tool_name', payload.toolName ?? null),
    strAttr('tool_use_id', payload.toolUseId ?? null),
    strAttr('subagent_type', payload.subagentType ?? null),
    strAttr('decision', payload.decision ?? null),
  ].filter((attr): attr is OtlpAttribute => attr !== undefined)
}

function spanJson(payload: TraceSpanPayload): Record<string, unknown> {
  return {
    traceId: payload.traceId,
    spanId: payload.spanId,
    ...(payload.parentSpanId === null ? {} : { parentSpanId: payload.parentSpanId }),
    name: payload.name,
    startTimeUnixNano: msToNanoString(payload.startTs),
    endTimeUnixNano: msToNanoString(payload.endTs),
    status: { code: statusCode(payload.status) },
    attributes: spanAttributes(payload),
  }
}

/**
 * Groups spans into one `resourceSpans` entry per (lane, role) pair — the
 * same two facts `collectors/otel/attribution.ts` reads off resource
 * attributes on the way in, so re-ingesting this dump attributes identically
 * to the live receiver. Almost always one group per session, since lane/role
 * are stamped once at dispatch (`rhizomorph env`); a session that changed
 * lanes mid-flight (rare — a resumed session across a rename) still exports
 * correctly as more than one group rather than silently merging them.
 */
function buildExportTraceRequest(payloads: readonly TraceSpanPayload[]): Record<string, unknown> {
  const groups = new Map<string, { lane: string; role: string; spans: Record<string, unknown>[] }>()
  for (const payload of payloads) {
    const key = `${payload.lane}\u0000${payload.role}`
    let group = groups.get(key)
    if (!group) {
      group = { lane: payload.lane, role: payload.role, spans: [] }
      groups.set(key, group)
    }
    group.spans.push(spanJson(payload))
  }

  return {
    resourceSpans: [...groups.values()].map((group) => ({
      resource: {
        attributes: [strAttr('lane', group.lane), strAttr('role', group.role)].filter(
          (attr): attr is OtlpAttribute => attr !== undefined,
        ),
      },
      scopeSpans: [{ spans: group.spans }],
    })),
  }
}

/**
 * Reads a recorded session's `trace.span` events off disk and writes them out
 * as an OTLP http/json export-trace request — outside the watched repo, the
 * same law `export-record.ts` already keeps for its own artifact, and for
 * the same reason: an exported dump living inside the watched repo would be
 * a leak the read-only promise doesn't cover. `sessionId` defaults to the
 * most recently recorded session for this repo. `--out` may point anywhere
 * except inside `repoPath`, refused rather than silently allowed; an
 * *explicit* `--out` that already exists is refused unless `force` is set,
 * same as `export-record`'s refuse-by-default (this is a one-shot,
 * non-interactive command). The default path (derived from repo slug +
 * session id) is exempt from that overwrite guard, exactly like
 * `export-record`'s: it is regenerable, and re-running without `--out` is
 * meant to refresh it.
 */
export async function runExportOtlp(options: ExportOtlpOptions): Promise<ExportOtlpResult> {
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const sessionDir = sessionDirFor(options.repoPath, dataRoot)
  const slug = repoSlug(options.repoPath)

  let sessionId = options.sessionId
  if (sessionId === undefined) {
    const sessions = await listSessions(sessionDir)
    const latest = sessions[sessions.length - 1]
    if (!latest) {
      throw new Error(`no recorded sessions for ${options.repoPath} (looked in ${sessionDir})`)
    }
    sessionId = latest.id
  } else {
    const sessions = await listSessions(sessionDir)
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new Error(`no session with id "${sessionId}" for ${options.repoPath} (looked in ${sessionDir})`)
    }
  }

  const events = await readSessionEvents(sessionFilePath(sessionDir, sessionId))
  const spans = events
    .filter((event): event is EventOf<'trace.span'> => event.type === 'trace.span')
    .map((event) => event.payload)

  if (spans.length === 0) {
    throw new Error(
      `no trace spans recorded for session "${sessionId}" (looked in ${sessionDir}) — nothing to export`,
    )
  }

  const request = buildExportTraceRequest(spans)

  const outPath = path.resolve(options.out ?? path.join(sessionDir, `${slug}-${sessionId}.otlp.json`))

  const repoPathResolved = path.resolve(options.repoPath)
  if (isInside(repoPathResolved, outPath)) {
    throw new Error(
      `refusing to write the export inside the watched repo (${canonicalize(outPath)}) — pass --out with a path outside ${canonicalize(repoPathResolved)}`,
    )
  }

  await mkdir(path.dirname(outPath), { recursive: true })

  const refuseExisting = options.out !== undefined && options.force !== true
  try {
    await writeFile(outPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: 'utf8',
      flag: refuseExisting ? 'wx' : 'w',
    })
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EEXIST' || code === 'EISDIR') {
      const existing = await stat(outPath).catch(() => undefined)
      if (existing?.isDirectory()) {
        throw new Error(
          options.out !== undefined
            ? `--out names an existing directory (${outPath}) — pass a file path instead`
            : `the default export path is an existing directory (${outPath}) — remove it, or pass --out with a file path`,
        )
      }
    }
    if (refuseExisting && code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing file (${outPath}) — pass --force to overwrite`)
    }
    throw err
  }

  return { outPath, sessionId, spanCount: spans.length }
}

/**
 * `rhizomorph export-otlp [path]` — a standalone, one-shot subcommand, no
 * server boot: reads a recorded session's trace spans off disk and writes
 * them out as an OTLP http/json export-trace request. Same clean-usage-error
 * contract as every other subcommand here.
 */
export async function runExportOtlpCommand(
  rest: readonly string[],
  log: Pick<Console, 'log' | 'warn'>,
  exit: (code: number) => never,
  options: RunCliOptions,
): Promise<never> {
  let args
  try {
    args = parseExportOtlpArgs(rest)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${message}\n\n${exportOtlpHelpText()}`)
    exit(1)
  }

  if (args.help) {
    log.log(exportOtlpHelpText())
    exit(0)
  }

  const repoPath = path.resolve(args.path ?? process.cwd())

  if (args.force && args.out === undefined) {
    log.warn('--force has no effect without --out — the default export path is always refreshed')
  }

  try {
    const { outPath, sessionId, spanCount } = await runExportOtlp({
      repoPath,
      dataRoot: options.dataRoot,
      sessionId: args.sessionId,
      out: args.out,
      force: args.force,
    })
    log.log(
      `wrote ${outPath} — ${spanCount} span(s) from session ${sessionId}. ` +
        `Nothing was sent; replay it yourself, e.g.:\n` +
        `  curl -u <public-key>:<secret-key> https://<your-langfuse-host>/api/public/otel/v1/traces ` +
        `-H 'Content-Type: application/json' -d @${outPath}`,
    )
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    exit(1)
  }

  exit(0)
}
