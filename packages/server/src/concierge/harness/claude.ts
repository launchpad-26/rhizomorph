import { createHash } from 'node:crypto'
import path from 'node:path'
import { renderTelemetryEnv } from '../../cli/telemetry-env.js'
import { detectHarness } from './detect.js'
import type {
  ContinuityPlan,
  DetectOptions,
  EnlistmentChange,
  EnlistmentIntent,
  EnlistmentPlan,
  EnlistmentRefusal,
  EnlistmentTarget,
  HarnessAdapter,
  HarnessDetection,
  HarnessEnvRecipe,
  HarnessLaunchContext,
} from './types.js'

/**
 * The claude adapter — prd-20 ruling 4's "claude first-class", implemented end
 * to end because it is the one harness whose every claim here is proven.
 *
 * ## The env recipe is read from the CLI, never restated
 *
 * `cli/telemetry-env.ts` already owns the exact block that makes a `claude`
 * process export to this server's receiver, and it is owned by the CLI: this
 * lane reuses it and does not touch it. Reuse here means *reading its output*
 * rather than copying its key list into a second place — `.workmux.yaml`, the
 * docs and `rhizomorph env` all depend on that block being byte-for-byte what
 * it always was, and a fork of the key list would be a second truth free to
 * drift from the first the next time an interval or a variable changes.
 *
 * So {@link claudeEnvRecipe} renders the `sh` form and parses it back into the
 * map a launch needs. `claude.test.ts` asserts the parse round-trips every
 * variable the renderer emits, so a new variable added to the CLI's block
 * arrives here automatically and a drift fails a test rather than shipping.
 */

/**
 * `export KEY=VALUE` lines back into a map.
 *
 * Split on the FIRST `=` only: `OTEL_RESOURCE_ATTRIBUTES` carries
 * `lane=…,role=…,instance=…`, so a naive split would truncate the one variable
 * that names the lane. The `sh` rendering is unquoted and one variable per
 * line, which is what makes this safe — and what the round-trip test pins.
 */
/**
 * The characters a lane may not contain, and why the check lives *here*.
 *
 * `renderTelemetryEnv`'s `sh` arm is `export ${key}=${value}` — unquoted, one
 * variable per line — and {@link parseShellEnv} reads it back line by line. So:
 *
 * - a **newline** in a lane becomes a whole extra `export` line, i.e. an
 *   environment variable of the caller's choosing in the launched agent's
 *   process. `OTEL_EXPORTER_OTLP_ENDPOINT` is the interesting one to overwrite:
 *   telemetry the operator believes is arriving here would be posted somewhere
 *   else entirely, and the picker would show a silent zero.
 * - an **`=`** corrupts `OTEL_RESOURCE_ATTRIBUTES`, whose own grammar is
 *   `lane=…,role=…,instance=…`, so the receiver books the telemetry against a
 *   lane nobody named. A `,` does the same by adding a bogus attribute pair.
 *
 * The renderer is `cli/telemetry-env.ts`'s and belongs to the CLI — this lane
 * reuses it and does not change it, so quoting is not the fix available here.
 * The seam is where the precondition belongs instead, and it is a **refusal**
 * rather than an escape or a silent sanitisation: escaping would fork the CLI's
 * block, and sanitising would launch an agent booked under a lane name the
 * operator did not choose. #263 inherits a thrown error, not a surprise.
 */
const LANE_FORBIDDEN = /[\n\r=,]/

/**
 * Refuse a lane the `sh` block cannot carry, before anything renders it.
 *
 * @throws {RangeError} for a lane containing a newline, `=` or `,`.
 */
function assertLaneIsRenderable(lane: string): void {
  if (!LANE_FORBIDDEN.test(lane)) return
  throw new RangeError(
    'refused: a lane name may not contain a newline, `=` or `,`. The env block is `export KEY=VALUE`, unquoted and ' +
      'one variable per line, so such a lane would inject an extra environment variable into the launched agent or ' +
      'corrupt OTEL_RESOURCE_ATTRIBUTES\u2019 own key=value grammar (see HarnessLaunchContext.lane). ' +
      `Received ${JSON.stringify(lane)}`,
  )
}

function parseShellEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const assignment = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const separator = assignment.indexOf('=')
    if (separator <= 0) continue
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
  }
  return env
}

/** The environment a `claude` launch must carry, sourced from the CLI's own renderer. */
export function claudeEnvRecipe(context: HarnessLaunchContext): HarnessEnvRecipe {
  assertLaneIsRenderable(context.lane)

  // The dialect is deliberately NOT passed. `renderTelemetryEnv` defaults to
  // `sh`, which is the form this parses — and `cli/telemetry-env.ts` records
  // that `sh` "is the default and must stay byte-for-byte what it always was",
  // because `.workmux.yaml` and every doc built on it assume that exact output.
  //
  // Naming the dialect explicitly would spell `shell:` in this file, and the
  // concierge namespace law's clause 4 now reads ANY `shell:` that is not
  // literally `false` as a shell-enabled spawn. That rewrite is right — seven
  // ordinary spellings walked through the old patterns — and this property is a
  // text-format selector rather than a spawn option, but a law over source text
  // cannot tell them apart and is not this lane's to amend. Relying on the
  // documented default is the honest resolution rather than a way around it:
  // there is now no `shell:` in this module at all. `claude.test.ts` pins the
  // rendered form, so a changed default fails a test rather than silently
  // producing a block this cannot parse.
  const block = renderTelemetryEnv({
    lane: context.lane,
    role: context.role,
    port: context.port,
    instance: context.instance,
  })

  return {
    env: parseShellEnv(block),
    // claude is configured entirely through the environment; it needs no argv.
    configArgv: [],
    telemetry: { level: 'provided' },
    evidence:
      'the block is `cli/telemetry-env.ts` rendered and parsed back, not a copy of it — the same block ' +
      '`rhizomorph env` and `.workmux.yaml` already use, whose OTLP/HTTP JSON export to this server was ' +
      'captured in the prd-9 trace-era work (claude 2.1.220, verdict GO)',
  }
}

/**
 * The Claude Code the resume evidence was actually captured against —
 * `research/2026-08-14-cross-host-resume.md`, whose caveats section pins it and
 * says in as many words that the behaviour is undocumented and unversioned
 * upstream (ledger #7).
 */
export const RESUME_EVIDENCE_VERSION = '2.1.232'

/**
 * **THE POLICY, IN ONE SENTENCE:** the resume claim stays `proven` across the
 * pinned MINOR line (`2.1.x`) and degrades everywhere else, because what the
 * note proved is a transcript-format and CLI-flag property and upstream's minor
 * bump is where that shape has room to move, while holding out for the exact
 * patch would mark every ordinary `claude` upgrade as unproven and train an
 * operator to ignore the word.
 *
 * The residual is named rather than hidden: a PATCH inside `2.1.x` could break
 * this too, since the behaviour is undocumented, so `proven` within the line is
 * an argued inference and not a re-run. What it is not is the previous state —
 * `proven` asserted over an arbitrary installed CLI nobody looked at.
 */
function onTheProvenLine(version: string): boolean {
  const pinned = RESUME_EVIDENCE_VERSION.split('.')
  const installed = version.split('.')
  return installed[0] === pinned[0] && installed[1] === pinned[1]
}

/**
 * argv[0] for a claude launch: the executable detection verified, or the bare
 * name when the caller detected nothing.
 *
 * The bare name is not a silent fallback — it is the honest answer when no path
 * was supplied, and it leaves resolution to the spawner, which is exactly what
 * a caller that skipped detection has asked for.
 */
function claudeCommand(context: HarnessLaunchContext): string {
  return context.executablePath ?? 'claude'
}

// ── enlistment (prd-57 ruling 4, ADR-0053) ───────────────────────────────────

/**
 * The five lifecycle events ruling 5's vocabulary is derived from, and only
 * those.
 *
 * Each is named in the ruling's own table: `tool-running` is `PreToolUse`
 * without its `PostToolUse`; `waiting-permission` is a `Notification` carrying
 * a permission request, withdrawn by the matching `PostToolUse` or `Stop`;
 * `stopped` is `SessionEnd`. Nothing else is subscribed, because a hook this
 * hand installs fires on the operator's machine for every session they run, and
 * subscribing to an event no word is derived from would be collecting for its
 * own sake — the non-goal ADR-0052 draws hardest.
 */
export const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'] as const

/**
 * The environment key that means the operator already exports somewhere.
 *
 * Ruling 4's merge-never-clobber clause names this one by hand, and it is the
 * only key in the recipe whose pre-existing value could be load-bearing for
 * something that is not us: pointing it at this server would silently redirect
 * an export the operator set up deliberately.
 */
const FOREIGN_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT'

/** The shape this hand reaches into. Everything else in the document is passed through untouched. */
interface ClaudeSettings {
  env?: Record<string, unknown>
  hooks?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * The hook entry this hand writes, per event.
 *
 * `command` is the ABSOLUTE path resolved at enlist time plus the subcommand —
 * ruling 6, and the reason is a measurement rather than a preference: `npx`'s
 * cold start would eat the harness's hook timeout. On Windows that path is the
 * `.cmd` shim, which is the caller's to resolve and this file's to write down.
 */
function claudeHookEntry(runnerPath: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command: `${runnerPath} hook` }] }
}

/** True when an entry is one of ours — matched by the subcommand it invokes, never by position. */
function isOurHookEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const hooks = (entry as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((hook) => {
    if (typeof hook !== 'object' || hook === null) return false
    const command = (hook as { command?: unknown }).command
    return typeof command === 'string' && OUR_RUNNER_RE.test(command.trim())
  })
}

/** `<anything>/rhizomorph hook`, with the Windows shim spellings. Anchored at the basename. */
const OUR_RUNNER_RE = /(^|[/\\])rhizomorph(\.cmd|\.exe|\.bat)?["']?\s+hook$/

/**
 * The source's own indentation and trailing newline, so a rewrite looks like
 * the file it replaces rather than like `JSON.stringify`'s house style.
 *
 * **The limit of the byte-for-byte claim, stated here rather than discovered
 * later.** This round-trips through `JSON.parse`, so what survives is the
 * indent width, the key order (insertion-ordered for string keys) and the
 * trailing newline. What cannot survive is anything a parse does not see:
 * aligned values, blank lines between blocks, tabs mixed with spaces. So ruling
 * 4's *"restores the file byte-for-byte except those keys"* holds exactly for a
 * canonically formatted document and holds as DEEP EQUALITY for every other
 * one. `claude.test.ts` asserts both halves, and names which is which.
 */
function formatOf(source: string | null): { indent: number | string; trailingNewline: boolean } {
  if (source === null) return { indent: 2, trailingNewline: true }
  const match = /\n([ \t]+)"/.exec(source)
  const lead = match?.[1] ?? '  '
  return { indent: lead.includes('\t') ? '\t' : lead.length, trailingNewline: source.endsWith('\n') }
}

function renderSettings(value: ClaudeSettings, format: { indent: number | string; trailingNewline: boolean }): string {
  return JSON.stringify(value, null, format.indent) + (format.trailingNewline ? '\n' : '')
}

/** A digest of the exact text a plan was computed from. Pure — hashing is not IO. */
function digestOf(text: string | null): string {
  return createHash('sha256').update(text ?? '').digest('hex')
}

const jsonOf = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

/**
 * The env keys unenlist takes back.
 *
 * **Derived from the recipe rather than listed**, so a variable added to
 * `cli/telemetry-env.ts` is removed by unenlist automatically. That is the same
 * no-second-truth argument this file's header makes about the recipe itself,
 * and here it has teeth: a hand-written list would strand every new key in the
 * operator's file forever, which is a fingerprint left behind by an act whose
 * whole promise is reversibility.
 */
const ENLISTED_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(claudeEnvRecipe({ lane: 'unenlist-probe', role: 'worker', port: 0, instance: 'unenlist-probe' }).env),
)

/**
 * What enlisting or unenlisting would do to `current` — the whole of ruling 4's
 * bound, touching no filesystem and reading no clock.
 */
export function planClaudeEnlistment(
  current: string | null,
  target: EnlistmentTarget,
  intent: EnlistmentIntent,
): EnlistmentPlan {
  let document: ClaudeSettings
  if (current === null || current.trim().length === 0) {
    // A missing or empty settings file is an ordinary first run, not an error:
    // an operator who has never written one still gets enlisted, into a file
    // this creates. Unenlist on the same file answers `already-settled`.
    document = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch (error) {
      // Refused, never repaired. A hand that "fixed" a malformed settings file
      // would be rewriting something it does not understand, and the backup it
      // took would be of a file nobody asked it to touch.
      return {
        kind: 'refused',
        target,
        reason: `${target.display} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        remedy: 'fix the file by hand and run this again — this hand will not rewrite a document it cannot parse',
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        kind: 'refused',
        target,
        reason: `${target.display} is valid JSON but not an object, so there is nowhere to merge into`,
        remedy: 'inspect the file by hand; this hand will not replace a document whose shape it did not expect',
      }
    }
    document = parsed as ClaudeSettings
  }

  const format = formatOf(current)
  const env: Record<string, unknown> = { ...(document.env as Record<string, unknown> | undefined) }
  const hooks: Record<string, unknown> = { ...(document.hooks as Record<string, unknown> | undefined) }
  const changes: EnlistmentChange[] = []
  const refusals: EnlistmentRefusal[] = []

  if (intent.kind === 'enlist') {
    for (const [key, value] of Object.entries(claudeEnvRecipe(intent.context).env)) {
      const existing = env[key]
      if (existing === value) continue
      if (key === FOREIGN_ENDPOINT_KEY && typeof existing === 'string' && existing.length > 0) {
        // Ruling 4, by name. The operator already exports somewhere, and this
        // hand does not get to decide that we are a better destination.
        refusals.push({
          keyPath: ['env', key],
          existing,
          reason:
            `${key} is already set, so this machine already exports somewhere. Overwriting it would silently ` +
            'redirect telemetry the operator configured deliberately',
          offer:
            'hooks-only enlist, which installs the lifecycle hooks and touches no environment variable. That ' +
            'still delivers the agent-status witness (prd-57 ruling 5); only the OTLP export is left alone',
        })
        continue
      }
      changes.push({
        keyPath: ['env', key],
        before: existing === undefined ? null : jsonOf(existing),
        after: jsonOf(value),
      })
      env[key] = value
    }

    for (const event of CLAUDE_HOOK_EVENTS) {
      const existing = hooks[event]
      const list = Array.isArray(existing) ? existing : []
      // Merge, never clobber: an operator's own hooks on this event survive,
      // and re-enlisting adds nothing, because ours is already in the list.
      if (list.some(isOurHookEntry)) continue
      const next = [...list, claudeHookEntry(intent.context.runnerPath)]
      changes.push({
        keyPath: ['hooks', event],
        before: existing === undefined ? null : jsonOf(existing),
        after: jsonOf(next),
      })
      hooks[event] = next
    }
  } else {
    for (const key of Object.keys(env)) {
      if (!ENLISTED_ENV_KEYS.has(key)) continue
      changes.push({ keyPath: ['env', key], before: jsonOf(env[key]), after: null })
      delete env[key]
    }

    // Our hook entries are identified by the command they invoke rather than by
    // where they sit, so an operator who reordered their hooks still gets a
    // clean removal and keeps their own.
    for (const event of CLAUDE_HOOK_EVENTS) {
      const existing = hooks[event]
      if (!Array.isArray(existing)) continue
      const kept = existing.filter((entry) => !isOurHookEntry(entry))
      if (kept.length === existing.length) continue
      changes.push({ keyPath: ['hooks', event], before: jsonOf(existing), after: kept.length === 0 ? null : jsonOf(kept) })
      if (kept.length === 0) delete hooks[event]
      else hooks[event] = kept
    }
  }

  if (changes.length === 0) {
    return {
      kind: 'already-settled',
      target,
      why:
        intent.kind === 'enlist'
          ? `${target.display} already carries every key this hand installs`
          : `${target.display} carries nothing this hand installed`,
    }
  }

  // Rebuilt rather than mutated in place, so a container this hand emptied
  // disappears instead of being left behind as `{}`. That is the difference
  // between unenlist restoring the file and unenlist leaving a fingerprint.
  const next: ClaudeSettings = { ...document }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks

  return { kind: 'ready', target, changes, refusals, next: renderSettings(next, format), sourceDigest: digestOf(current) }
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  implementation: { status: 'implemented' },

  detect(options: DetectOptions = {}): Promise<HarnessDetection> {
    return detectHarness('claude', 'claude', options)
  },

  envRecipe: claudeEnvRecipe,

  launchArgv(context: HarnessLaunchContext): readonly string[] {
    // The telemetry rides in the environment, so a fresh launch is just the
    // command — but WHICH file that is matters. `detectOnPath` skipped empty and
    // relative PATH entries so a file inside the watched repo's working tree
    // could never become the thing this hand launches; returning a bare
    // `['claude']` would throw that away, because the spawner would re-resolve
    // the name against its own PATH at spawn time with none of that filtering.
    // So the verified path wins when the caller has one.
    //
    // An array, never a command string — ADR-0019 clause 4.
    return [claudeCommand(context)]
  },

  /**
   * `claude --continue` — the one proven continuity story in this registry, and
   * the evidence prd-20 ruling 3 and ADR-0019's option D both rest on.
   *
   * What is lost is stated because the ruling requires it, and because it is
   * the honest half of the offer: instrumentation attaches at launch and never
   * retroactively (`docs/telemetry.md`), so the *conversation* continues but
   * the previous process's work is not back-filled. Nothing it did before this
   * relaunch will ever appear in this instrument. A front door that quietly
   * implied otherwise would be the lie ADR-0019 refused to tell.
   */
  continueArgv(): ContinuityPlan {
    return {
      kind: 'proven',
      argv: ['--continue'],
      whatContinues: 'the previous conversation — its history and context are resumed in the new process',
      whatIsLost:
        'everything the old process already did. Instrumentation attaches at launch, so telemetry begins at this ' +
        'relaunch and the prior turns are never back-filled; the old process must be ended by the operator, and ' +
        'anything it was mid-way through is not carried over',
      evidence:
        'prd-20 evidence and ADR-0019 option D both name `claude --continue` as the reachable form of ' +
        'relaunch-with-continuity; docs/telemetry.md records the attach-at-launch physics it is a response to',
    }
  },

  /**
   * `claude --resume <sessionId>` — proven, not merely plausible:
   * `research/2026-08-14-cross-host-resume.md` ran this exact form, same-host
   * and cross-host (Windows-origin transcripts resumed on Linux, 2 KB and
   * 23 MB), and recorded that it appends in place, preserves the sessionId
   * verbatim, and that OTLP telemetry books under that preserved id. Pinned to
   * **Claude Code 2.1.232** — the note's own caveats section is explicit that
   * this behaviour is undocumented and unversioned upstream, so a claude
   * upgrade is the thing that would unsettle this claim, not a re-reading of
   * the note.
   *
   * What is lost is the same honest half `continueArgv` states, because the
   * physics are identical: instrumentation attaches at launch and is never
   * back-filled, so the resumed process's telemetry starts at THIS relaunch —
   * nothing the prior process already did arrives here — and that prior
   * process is not attached to or replaced; it keeps running until the
   * operator ends it.
   *
   * **`proven` is now conditional on the machine, not just on the note**
   * (ledger #7). The note pins its evidence to 2.1.232 and says the behaviour
   * is undocumented and unversioned upstream — so this used to answer `proven`
   * for whatever `claude` happened to be installed, which is an evidence claim
   * about a CLI nobody looked at. {@link HarnessLaunchContext.harnessVersion}
   * is what the caller probed; off the pinned minor line, or with nothing
   * probed at all, the same argv comes back as `unproven` with `toProve` naming
   * the re-run. The argv is never withheld: the flag is right, and hiding it
   * would help nobody — what it will not do is let a caller reach it without
   * reading the word.
   */
  resumeArgv(context: HarnessLaunchContext, sessionId: string): ContinuityPlan {
    const { harnessVersion } = context
    if (harnessVersion === undefined || harnessVersion === null || !onTheProvenLine(harnessVersion)) {
      const installed =
        harnessVersion === undefined
          ? 'nothing probed this machine for a claude version'
          : harnessVersion === null
            ? 'this machine was probed and would not report a claude version'
            : `this machine has claude ${harnessVersion}`
      return {
        kind: 'unproven',
        argv: ['--resume', sessionId],
        reason:
          `the resume evidence is pinned to Claude Code ${RESUME_EVIDENCE_VERSION} ` +
          '(research/2026-08-14-cross-host-resume.md, whose caveats section records the behaviour as undocumented ' +
          `and unversioned upstream), and ${installed} — so in-place append, a preserved sessionId and telemetry ` +
          'booked under it are not established here the way they are on the pinned line',
        toProve:
          'run the cross-host-resume note’s own procedure against the installed CLI — resume a transcript by id, ' +
          'confirm the file is appended in place rather than forked, confirm the sessionId comes back verbatim, and ' +
          'confirm OTLP books under that same id — then move the pin in `harness/claude.ts`',
      }
    }
    return {
      kind: 'proven',
      argv: ['--resume', sessionId],
      whatContinues:
        'the transcript for this exact sessionId — its history and context resume in the new process, under the ' +
        'SAME sessionId, appended in place',
      whatIsLost:
        'everything the old process already did. Instrumentation attaches at launch, so telemetry begins at this ' +
        'relaunch and the prior turns are never back-filled; the old process is not attached to and keeps running ' +
        'until the operator ends it, and anything it was mid-way through is not carried over',
      evidence:
        'research/2026-08-14-cross-host-resume.md (VERDICT: GO) ran `claude --resume <id>` same-host and ' +
        'cross-host and confirmed in-place append, a preserved sessionId, and telemetry booked under that id; ' +
        `pinned to Claude Code ${RESUME_EVIDENCE_VERSION} per the note’s caveats section, and the installed CLI ` +
        'was probed and found on that minor line (a patch inside the line is an argued inference, not a re-run)',
    }
  },

  /**
   * `~/.claude/settings.json` — the USER-level file, which is the whole of what
   * ADR-0053 grants.
   *
   * Not `.claude/settings.local.json` inside a repo, and not a project-level
   * file: ADR-0019 clause 4 is *"never inside the watched repo"*, and enlisting
   * a repo-local file would put this hand's writes inside somebody's working
   * tree, where they would show up as a dirty file the instrument then reports
   * on. The same path on every platform — Claude Code does not use
   * `%APPDATA%` — so `platform` is accepted and deliberately unused, because a
   * caller should not have to know that to call this.
   */
  enlistmentTarget(home: string): EnlistmentTarget {
    return { path: path.join(home, '.claude', 'settings.json'), display: '~/.claude/settings.json' }
  },

  planEnlistment: planClaudeEnlistment,
}
