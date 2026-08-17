import { AGENT_ROLES, type AgentRole, type Connection, type RefusalState, type SourceFlow, type UninstrumentedSession } from '@rhizomorph/core'
import { shellQuote } from '../drawer/attach.js'
import { formatSpan } from '../fleet/index.js'
import type { ConnectionStatus } from '../hooks/useEventStream.js'
import { doctorCheck, type CollectorFacts, type DoctorReading, type MetaFacts } from './meta.js'

/**
 * THE HANDSHAKE CHECKLIST'S ROWS (prd19 ruling 3, wave 3, #258).
 *
 * One row per link in the chain, each rendering **exactly one of three
 * states**: VERIFIED (a fact and its timestamp), BROKEN (a reason and the
 * exact command), UNPROVEN (honestly nothing yet). This module is the whole
 * derivation and nothing else — pure, synchronous, no fetch, no React — so
 * the rulings it encodes are testable as arithmetic over a fold rather than
 * as pixels.
 *
 * **"Connected" means data flowed, never "preconditions passed."** That is
 * ruling 3's own sentence and it decides every branch below: a row goes
 * VERIFIED because {@link SourceFlow} counts folded records, not because a
 * binary is on PATH or an env var is set somewhere. Preconditions appear
 * here only as {@link ChainLink.notes} — context for a row that has not
 * proven itself, never a substitute for the proof.
 *
 * **Where the facts come from, and why the fold is the live one.** The flow
 * facts are `selectConnection` over the SSE fold the whole app already reads,
 * so a row flips to VERIFIED the moment the event that proves it arrives —
 * no refresh, no refetch, which is prd19's own success criterion ("watch a
 * row flip to VERIFIED live"). `/api/meta` and `GET /api/doctor` fill in what
 * the fold cannot know: the rung and the per-collector `reason`/`remedy`
 * (meta), and the filesystem facts — the slug dir, version drift, the lane
 * manifest (doctor). Where meta's own `connection` snapshot and the fold
 * disagree, {@link mergeFlow} takes whichever PROVED MORE: both are witnesses
 * of the same append-only truth, and a page whose job is proof must not lose
 * a proof because one witness was polled a second earlier.
 *
 * **VERIFIED MEANS "I CHECKED, AND IT HOLDS" — NEVER "THIS WAS TRUE ONCE"**
 * (#343 and #345, ruled together: they are one question). A row may say
 * VERIFIED only on live evidence from ITS OWN source. You cannot check over a
 * fold that was never live, and you cannot check over a stream that has died;
 * in both cases the honest state is UNPROVEN, which is exactly why this page
 * has a third state rather than a choice between a green lie and a red one.
 * {@link ChainLink.evidence} names the source each row is checked by, and
 * {@link attest} is the one place both halves of that ruling are applied.
 *
 * The three states are also the hue law's own three (`theme/theme.css`):
 * verified wears the green family, broken wears the one red the instrument
 * has, and unproven wears the structural ink — **waiting is not an alarm**, so a
 * row that has nothing to say must never borrow amber's "a human is needed"
 * or red's "this is dead".
 */

export type LinkState = 'verified' | 'broken' | 'unproven'

/**
 * The one word each state is rendered as, and the glyph beside it — declared
 * HERE, beside {@link LinkState} itself, so the two cannot drift.
 *
 * Colour is never the sole carrier (hue law 9a's own condition): every state
 * has a glyph and a word as well as a hue, so the checklist survives greyscale,
 * colour-blindness and a photographed screen.
 *
 * They moved down here from `index.tsx` in wave 4 (#266), which is where the
 * three-states law (#367) still reads them from — `index.tsx` re-exports them
 * unchanged. The reason is the wizard: it shows the same three readings for the
 * same rows, and a second surface reaching back INTO the page module for its
 * vocabulary would be an import cycle between the page and the panel it
 * renders. A word about a `LinkState` belongs with `LinkState`.
 */
export const STATE_WORD: Record<LinkState, string> = {
  verified: 'VERIFIED',
  broken: 'BROKEN',
  unproven: 'UNPROVEN',
}

/** The glyph beside {@link STATE_WORD} — see its doc for why both exist. */
export const STATE_GLYPH: Record<LinkState, string> = { verified: '✓', broken: '✕', unproven: '·' }

/**
 * WHAT IS CHECKING A ROW — and therefore what has to be both real and alive
 * before it may say VERIFIED (#343, #345).
 *
 * `'fold'`: the SSE stream. These rows are proved by records the fold
 * absorbed, so their claims are only as live as the stream carrying them, and
 * only as real as the log driving it.
 *
 * `'poll'`: a GET this page re-reads on its own interval (`/api/meta`,
 * `GET /api/doctor`). These have their own freshness and their own failure
 * mode — **a dead SSE says nothing about whether the last poll succeeded**,
 * and a fixture in the fold says nothing about whether the filesystem doctor
 * just probed exists. Treating all seven rows identically is what makes
 * staleness look like a hard problem; most of the time, half of them are not
 * actually stale.
 *
 * This very nearly coincides with {@link ChainLink.tsKind} — a fold row is
 * dated by a stored event, a poll row by the probe that is this render — and
 * that is not a coincidence: both distinctions are the same one. It is
 * declared per row rather than read off `tsKind` because `tsKind` leaks on
 * one real case: a folded record whose every stamp was null is dated `'render'`
 * ({@link provenAt}) while still being a stored fact nobody is checking.
 */
export type Evidence = 'fold' | 'poll'

export interface ChainLink {
  id: string
  /** The link itself, as ruling 3 names it: `browser ↔ server`, `repo ↔ git`, … */
  label: string
  /** What this row would prove — shown always, so an UNPROVEN row still says what it is waiting for. */
  question: string
  state: LinkState
  /** What checks this row, and what therefore has to be alive for it to say VERIFIED — see {@link Evidence}. */
  evidence: Evidence
  /**
   * The fact that proves it. Always present on VERIFIED; **also present on an
   * UNPROVEN row that was demoted by {@link attest} for a dead stream** — the
   * fact and its date are still true statements about when they were last
   * proven, and #345 keeps them precisely because "UNPROVEN plus a dated fact"
   * is the whole reason a fourth LAST KNOWN state was not needed. Never
   * present on BROKEN, and never present on a row a fixture drove.
   */
  fact: string | null
  /**
   * **Never null wherever {@link fact} is set** — ruling 3's own sentence is
   * "a fact AND its timestamp", and a stale fact with nothing to date it is
   * exactly the failure this page exists to remove.
   */
  ts: number | null
  /**
   * What {@link ts} dates. `'event'` is the proving record's own timestamp;
   * `'render'` is this render, and is the honest answer where the proof IS
   * the present moment — an open stream, a fresh doctor probe — rather than a
   * stored fact. Never a fabricated event time for a live proof.
   */
  tsKind: 'event' | 'render' | null
  /** BROKEN only: why. */
  reason: string | null
  /** BROKEN only, and **never null on a BROKEN row**: the exact copy-paste command, port already interpolated. */
  command: string | null
  /** BROKEN only, beside a command: the same-process SCAR warning, verbatim. */
  warning: string | null
  /** Context — preconditions, doctor findings, standing faults. Never load-bearing for {@link state}. */
  notes: string[]
  /**
   * THE ROW'S OWN ENUMERATION, and today the uninstrumented row is the only
   * one that has one (prd-20 w7, #520). Every session this row is BROKEN
   * *about*, each carried as something the page can act on — see
   * {@link InstrumentableSession}.
   *
   * Optional because it is one row's fact, not a field every row owes an
   * answer for: a row with nothing to enumerate leaves it unset rather than
   * carrying an empty list that reads like a checked-and-found-nothing claim.
   * **{@link unproven} clears it explicitly**, which is what keeps a fixture
   * fold — or a session inside the grace window — from handing an operator a
   * button and a command for a conversation this page has not proved anything
   * about.
   */
  sessions?: InstrumentableSession[]
}

/**
 * ONE RIPE WITNESS, IN THE FORM THE PAGE CAN ACT ON (prd-20 w7, #520).
 *
 * The row above this list is unchanged — the BROKEN/UNPROVEN/VERIFIED spine
 * and the worst-offender sentence still say everything a reader needs without
 * scrolling. This is the enumeration *under* it: every ripe session, with the
 * two paths out and enough identity to tell one from another.
 *
 * **The command is not a fallback for the button** (prd-20 ruling 3). This
 * page never claims to attach to a running process, so the copyable command
 * stays visible EVEN WHERE the button exists: it is the path that needs no
 * trust in this instrument at all, and the only one that still works when the
 * instrument cannot reach the transcript.
 */
export interface InstrumentableSession {
  sessionId: string
  /** The lane whose env block would fix it — `null` when no witness named one, exactly as {@link envCommand} means it. */
  lane: string | null
  /** The role that block is generated for; `null` where no witness carried a role the schema knows. */
  role: AgentRole | null
  /**
   * How long this session has been running uninstrumented — `12m00s ago`, or
   * `undated` for the witness {@link pastGrace} refuses the window to because
   * it carried no usable first sighting. Never a bare timestamp: the question
   * this answers is "how long has this been going on", which is elapsed time.
   */
  ageLabel: string
  /**
   * Where it ran (#515's fields, rendered at last), as a reader can hold it:
   * the branch, and the LAST SEGMENT of the worktree path rather than its
   * whole depth — an option in a `<select>` has room for the part that
   * identifies a worktree, not for `/home/x/rhizomorph__worktrees/…`.
   */
  place: { branch: string | null; worktreeTail: string | null }
  /**
   * The no-trust path, composed from the two idioms this module already owns:
   * {@link envCommand} inside {@link envApplyNote}'s own `eval`, then `claude
   * --resume` on this session id. **One line, joined by `&&`, deliberately** —
   * the SCAR ({@link SAME_PROCESS_WARNING}) is precisely what happens when the
   * export and the exec are two different processes, and a two-line recipe is
   * two processes waiting to happen.
   */
  resumeCommand: string
  /** The env block alone, so a reader can see what that `eval` is about to run before running it. */
  envCommand: string
}

/**
 * THE SCAR, VERBATIM (ruling 7, and the `.workmux.yaml` incident of
 * 2026-08-04). A pane-env prefix silently never reached the agent: the env
 * block was exported in one process and `claude` was exec'd by another, so
 * every precondition read as satisfied and nothing ever arrived. Copied word
 * for word beside every env command this page shows, because paraphrasing a
 * scar is how it comes back.
 */
export const SAME_PROCESS_WARNING = 'the env block must be exported in the process that execs the agent'

/**
 * How long a session may show transcript activity with no telemetry before
 * this page is willing to call it BROKEN.
 *
 * `selectConnection`'s own doc hands this decision here by name: it "cannot
 * distinguish 'never instrumented' from 'instrumented, awaiting its first
 * batched export'", and says the elapsed-time judgment is the UI's call
 * (#258). Sixty seconds is a deliberate over-estimate of the longest first
 * batch an instrumented agent can owe us — `rhizomorph env` sets the metrics
 * interval to 5s, logs to 2s and traces to 1s (`cli/telemetry-env.ts`), so a
 * correctly wired lane proves itself an order of magnitude inside this
 * window. Under it, the row reads UNPROVEN, in the structural register: an export
 * that may still be in flight is waiting, and waiting is not an alarm.
 */
export const FIRST_EXPORT_GRACE_MS = 60_000

/** What the page knows about its own SSE connection — the browser↔server link's evidence. */
export interface StreamFacts {
  status: ConnectionStatus
  /** `state.session.eventCount` — every event the fold ever absorbed, eviction included. */
  eventCount: number
  /** `StreamContext`'s provenance string, so a fixture can never pass as live data (ruling 6). */
  provenance: string
  /**
   * True only when the fold driving this page is the LIVE log — `mode ===
   * 'live'` and no fixture key pressed. Both other cases fabricate an open
   * connection (`StreamContext` hands replay and every fixture `status:
   * 'open'` outright), so reading `status` as proof under either of them
   * would be ruling 6's forbidden costume: a fixture passing as live data.
   */
  live: boolean
}

export interface ConnectInputs {
  /** `selectConnection(state.session)` over the live SSE fold. */
  flow: Connection
  /** `state.session.refusals` — the folded `telemetry.refused` slice (ruling 2). */
  refusals: RefusalState
  stream: StreamFacts
  meta: MetaFacts | null
  /** The three-state doctor reading (#381) — `absent` and `unreadable` are different facts and this page says which. */
  doctor: DoctorReading
  /** The port this browser is actually talking to, interpolated into every command. */
  port: string
  /** The page's clock, for {@link FIRST_EXPORT_GRACE_MS}. */
  now: number
}

/** `location.port` is empty on the default port for the scheme — the honest fallback, never a guess. */
export function portFrom(location: { port: string; protocol: string }): string {
  if (location.port !== '') return location.port
  return location.protocol === 'https:' ? '443' : '80'
}

/**
 * The command ruling 7 names, with the live port interpolated and the lane
 * filled in whenever the fold actually knows one. `<lane>` stays a literal
 * placeholder when it does not: a page that guessed a handle would hand the
 * operator a command that generates an env block for a lane that does not
 * exist, which is worse than the placeholder they have to fill in themselves.
 */
export function envCommand(lane: string | null, role: AgentRole | null, port: string): string {
  const roleArg = role === null || role === 'unattributed' ? '' : ` --role ${role}`
  return `rhizomorph env ${lane ?? '<lane>'}${roleArg} --port ${port}`
}

/** How that block has to be applied — the other half of the SCAR: exported, in the agent's own shell, before `claude` starts. */
export function envApplyNote(command: string): string {
  return `apply it in the shell that will exec the agent — \`eval "$(${command})"\` — then start \`claude\` from that same shell`
}

/**
 * Relaunching the instrument itself, against this repo and this port — the
 * command behind every row whose fault was decided at boot.
 *
 * A collector is enabled or disabled when the server starts (and retired
 * mid-run by its own error policy); nothing this page or its operator can do
 * from a browser re-enables one. So once the cause the row NAMES is fixed —
 * the missing binary installed, the path pointed at a real worktree — this is
 * the exact command that re-runs that decision. It is a real remedy rather
 * than an invented one precisely because the row always carries the
 * collector's own reason beside it: the reason says what to fix, this says
 * how to make the instrument look again.
 */
export function restartCommand(repoPath: string | null, port: string, extra: readonly string[] = []): string {
  return ['npm start --', repoPath ?? '<repo>', '--port', port, ...extra].join(' ')
}

/**
 * The whole no-trust path for one session, as a single pasteable line: the env
 * block evaluated in this shell, and the agent resumed from that same shell.
 *
 * Nothing here is new machinery — it is {@link envApplyNote}'s own sentence
 * ("apply it in the shell that will exec the agent … then start `claude` from
 * that same shell") written as the command it describes, with the same
 * `shellQuote` the drawer's attach commands use so a session id or lane with a
 * space in it still pastes correctly. **`&&`, never two lines**: the SCAR this
 * page repeats verbatim is what a two-process recipe does, and a one-liner
 * cannot be half-followed.
 */
export function resumeCommand(env: string, sessionId: string): string {
  return `eval "$(${env})" && claude --resume ${shellQuote(sessionId)}`
}

// `sessions` joins the state-carried fields rather than the base ones: it is a
// property of what a row PROVED, so only the three constructors below may
// decide it — which is what makes `unproven`'s explicit clear a law rather
// than a convention a caller could route around.
type LinkBase = Omit<ChainLink, 'state' | 'fact' | 'ts' | 'tsKind' | 'reason' | 'command' | 'warning' | 'notes' | 'sessions'>

/** When a row was proved, and by what kind of proof — see {@link ChainLink.tsKind}. */
export interface Proof {
  ts: number
  tsKind: 'event' | 'render'
}

/**
 * A proving record's own timestamp when it has one, and otherwise this
 * render, labelled as such. Some proofs genuinely carry no event time — a
 * folded record whose every stamp was null, a doctor probe, an open socket —
 * and ruling 3 still wants them dated. "As of now" is the true statement in
 * those cases; inventing an event timestamp would not be.
 */
function provenAt(eventTs: number | null, now: number): Proof {
  return eventTs === null ? { ts: now, tsKind: 'render' } : { ts: eventTs, tsKind: 'event' }
}

/** Dated by this render alone: the proof is the present moment, not a stored fact. */
function provenNow(now: number): Proof {
  return { ts: now, tsKind: 'render' }
}

function verified(base: LinkBase, fact: string, proof: Proof, notes: string[] = []): ChainLink {
  return { ...base, state: 'verified', fact, ts: proof.ts, tsKind: proof.tsKind, reason: null, command: null, warning: null, notes, sessions: undefined }
}

/**
 * `command` is REQUIRED, not optional — ruling 3's "a reason and the exact
 * command" restated as a type rather than as a convention a future row could
 * skip. A row that cannot name a command is not a BROKEN row this module
 * knows how to build, and that is the conversation a diff should have.
 */
function broken(
  base: LinkBase,
  reason: string,
  options: { command: string; warning?: string; notes?: string[]; sessions?: InstrumentableSession[] },
): ChainLink {
  return {
    ...base,
    state: 'broken',
    fact: null,
    ts: null,
    tsKind: null,
    reason,
    command: options.command,
    warning: options.warning ?? null,
    notes: options.notes ?? [],
    sessions: options.sessions,
  }
}

/**
 * `sessions: undefined` is written out rather than left off, and it is the one
 * line that keeps {@link fromFixture} honest. This function is what a fixture
 * row is REBUILT with, and it is handed the whole {@link ChainLink} — so a
 * field it forgets to reset is a field that survives the reset, which is
 * exactly the failure that file's doc warns about ("a hand-listed copy of the
 * same seven nulls is exactly where a field added to one and not the other
 * would survive a fixture as a fabricated claim"). An enumeration surviving it
 * would put an instrument button and a copyable `claude --resume` on a session
 * that exists only inside a synthetic fleet.
 */
function unproven(base: LinkBase, notes: string[] = []): ChainLink {
  return { ...base, state: 'unproven', fact: null, ts: null, tsKind: null, reason: null, command: null, warning: null, notes, sessions: undefined }
}

/** `1 record` / `4 records` — the count is evidence of flow and a magnitude, never an event tally (`selectConnection`'s own first limit). */
function records(count: number): string {
  return `${count} folded record${count === 1 ? '' : 's'}`
}

/**
 * Two witnesses of one append-only truth: the live fold, and `/api/meta`'s
 * own `selectConnection` snapshot. Proof is monotone — a record neither
 * witness can un-see — so the merge takes the larger count and the wider
 * window rather than preferring one source. (`selectConnection`'s second
 * limit means git/tmux/workmux flow CAN regress as entity state is
 * overwritten; this merge does not compensate for that and must not be read
 * as doing so — it reconciles two readings of the same instant, not two
 * instants.)
 */
export function mergeFlow(folded: SourceFlow, served: { firstEventTs: number | null; lastEventTs: number | null; count: number } | undefined): SourceFlow {
  if (served === undefined) return folded
  return {
    source: folded.source,
    count: Math.max(folded.count, served.count),
    firstEventTs: minTs(folded.firstEventTs, served.firstEventTs),
    lastEventTs: maxTs(folded.lastEventTs, served.lastEventTs),
  }
}

function minTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function maxTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/**
 * A collector whose signals came back `absent` with a reason — prd15 ruling
 * 5's "a disabled collector's signals read `absent` with a reason, never
 * silently `provided`". `identity` is the signal read because every collector
 * in the ladder declares it, and `honestCapabilities` overrides all six at
 * once when the fold says the collector is disabled, so any one of them
 * carries the same reason.
 */
function disabledReason(meta: MetaFacts | null, name: string): { reason: string; remedy: string | null } | null {
  const collector: CollectorFacts | undefined = meta?.collectors.find((entry) => entry.name === name)
  const identity = collector?.signals.find((signal) => signal.signal === 'identity')
  if (identity === undefined || identity.level !== 'absent' || identity.reason === null) return null
  return { reason: identity.reason, remedy: identity.remedy }
}

/** A doctor finding, in its own words, tagged with the check it came from — or nothing at all when there is no readable report to quote. */
function doctorNote(doctor: DoctorReading, id: string): string[] {
  const check = doctorCheck(doctor, id)
  if (check === null) return []
  return [`doctor · ${id}: ${check.message}${check.assumed ? ' (assumed, not measured)' : ''}`]
}

const STREAM_REASON: Record<ConnectionStatus, string> = {
  connecting: 'the event stream has not opened yet',
  open: 'the event stream is open',
  error: 'the event stream errored — nothing is arriving over it',
  closed: 'the event stream is closed — nothing is arriving over it',
}

/**
 * The statuses {@link STREAM_REASON} itself describes as "nothing is arriving
 * over it" — **the one partition of {@link ConnectionStatus} this module makes,
 * declared once.**
 *
 * Two places need it and they must not disagree: {@link browserServer}, which
 * calls the link itself BROKEN, and {@link attest}, which withdraws VERIFIED
 * from every row the dead stream was checking. Both used to encode it
 * separately — one as a predicate, one as an if/else fall-through — and agreed
 * only by the coincidence that today's `ConnectionStatus` has exactly four
 * values with exactly two of them dead. A fifth (`reconnecting`, say) would
 * have split them silently, and the split reads as a contradiction on the page:
 * a first row calling the stream dead above six rows still calling themselves
 * checked, or the reverse.
 *
 * Not-dead is therefore the default on both sides, which is also the honest one
 * — a status this module has never heard of is a stream it cannot call dead.
 */
function streamIsDead(status: ConnectionStatus): boolean {
  return status === 'error' || status === 'closed'
}

/**
 * **browser ↔ server.** The one link this page can prove by existing: the SSE
 * connection is open, so this browser reached this server. It is deliberately
 * NOT gated on events having arrived — an open stream over a repo where
 * nothing has happened yet is a working link with nothing to carry, and
 * conflating the two would make the first row lie about which link is
 * actually dead.
 */
function browserServer(input: ConnectInputs): ChainLink {
  const base = {
    id: 'browser-server',
    label: 'browser ↔ server',
    question: 'is this page actually talking to a running Rhizomorph?',
    evidence: 'fold' as const,
  }
  const notes = [`source: ${input.stream.provenance}`, ...doctorNote(input.doctor, 'node')]

  // Ruling 6 used to be enforced here, at this one row, because a fixture and
  // a replay both fabricate `status: 'open'` (`StreamContext`). #343 moved it
  // to {@link attest} so it reaches every row the fold feeds instead of only
  // the row that reads `status` — the outcome for this row is unchanged.
  if (input.stream.status === 'open') {
    const instance = input.meta?.sessionId ?? null
    const served = instance === null ? '/api/meta has not named an instance' : `/api/meta names instance ${instance}`
    const events = `${input.stream.eventCount} event${input.stream.eventCount === 1 ? '' : 's'} folded`
    // The proof here is the socket being open *now*, not any event on it —
    // so the honest date is this render, never the last event's timestamp.
    return verified(base, `${STREAM_REASON.open} — ${events}, ${served}`, provenNow(input.now), notes)
  }

  // BROKEN is exactly {@link streamIsDead}, never a list of statuses restated
  // here: this row and {@link attest} are answering the same question about
  // the same socket, and a page that called the stream dead on one row while
  // six others still called themselves checked would be contradicting itself
  // about its own connection. Everything left over — `connecting` today — is
  // waiting, and waiting is not an alarm.
  if (!streamIsDead(input.stream.status)) return unproven(base, notes)

  return broken(base, STREAM_REASON[input.stream.status], {
    command: restartCommand(input.meta?.repoPath ?? null, input.port),
    notes,
  })
}

/** **repo ↔ git.** Worktrees, branches and commits reaching the fold — the L0 floor every other link is measured against. */
function repoGit(input: ConnectInputs): ChainLink {
  const base = { id: 'repo-git', label: 'repo ↔ git', question: 'is the git collector reaching this repo?', evidence: 'fold' as const }
  const flow = mergeFlow(input.flow.git, input.meta?.connection?.sources.git)
  const notes = doctorNote(input.doctor, 'lane-manifest')

  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from git — worktrees, branches, commits`, provenAt(flow.lastEventTs, input.now), notes)
  }
  const disabled = disabledReason(input.meta, 'git')
  if (disabled !== null) {
    return broken(base, disabled.reason, {
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes: disabled.remedy === null ? notes : [`remedy: ${disabled.remedy}`, ...notes],
    })
  }
  return unproven(base, notes)
}

/** **agents ↔ tmux/workmux.** One row for the two machine collectors: either proves the link, and the row names which did. */
function agentsPanes(input: ConnectInputs): ChainLink {
  const base = {
    id: 'agents-tmux',
    label: 'agents ↔ tmux/workmux',
    question: 'is anything reporting live agent panes and handles?',
    evidence: 'fold' as const,
  }
  const tmux = mergeFlow(input.flow.tmux, input.meta?.connection?.sources.tmux)
  const workmux = mergeFlow(input.flow.workmux, input.meta?.connection?.sources.workmux)
  const notes = [...doctorNote(input.doctor, 'tmux'), ...doctorNote(input.doctor, 'workmux')]

  if (tmux.count > 0 || workmux.count > 0) {
    const proved = [tmux.count > 0 ? `tmux ${records(tmux.count)}` : null, workmux.count > 0 ? `workmux ${records(workmux.count)}` : null]
      .filter((part): part is string => part !== null)
      .join(' · ')
    return verified(base, proved, provenAt(maxTs(tmux.lastEventTs, workmux.lastEventTs), input.now), notes)
  }

  const tmuxDisabled = disabledReason(input.meta, 'tmux')
  const workmuxDisabled = disabledReason(input.meta, 'workmux')
  // BROKEN only when BOTH are disabled with a reason: either one alone still
  // leaves a live mechanism that simply has not reported yet, which is
  // UNPROVEN, not dead.
  if (tmuxDisabled !== null && workmuxDisabled !== null) {
    return broken(base, `tmux: ${tmuxDisabled.reason} · workmux: ${workmuxDisabled.reason}`, {
      // Each reason names its own tool; installing it is that tool's own
      // business and has no portable command. What this page can name
      // exactly is the one thing that makes the instrument look again once
      // it is there.
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes,
    })
  }
  return unproven(base, notes)
}

/**
 * **transcripts ↔ slug, the plumbing half.** Does the session-log directory
 * this repo's slug resolves to exist at all — a filesystem fact the fold
 * cannot know, which is why ruling 5 added `GET /api/doctor` for it. Split
 * from the flow row below on purpose (ruling 3, and this issue's direction):
 * a dir that exists and a transcript that arrived are two different claims,
 * and one standing in for the other is how "connected" starts meaning
 * "preconditions passed".
 */
function transcriptSlug(input: ConnectInputs): ChainLink {
  const base = {
    id: 'transcripts-slug',
    label: 'transcripts ↔ slug (dir)',
    question: 'does the session-log directory this repo resolves to exist?',
    // The one row in the chain the fold does not feed at all, which is why it
    // survives both a fixture and a dead stream: doctor probed THIS
    // filesystem, on its own interval, whatever log is driving the page.
    evidence: 'poll' as const,
  }
  const check = doctorCheck(input.doctor, 'session-logs')
  if (check === null) {
    // THREE DIFFERENT NOTHINGS, AND WHERE TO LOOK DIFFERS FOR EACH (#346,
    // then #381). What is unavailable is the same in all three; WHY it is
    // unavailable — and therefore what the reader debugs — is not:
    //
    // - `absent`: nothing usable arrived. That still folds a dead route, a
    //   non-2xx and a non-JSON body (`readJson`'s set), so this note says "no
    //   usable answer" and sends the reader to the route — it does NOT flatly
    //   claim silence, because a 500 or an error page is an answer of a kind.
    // - `unreadable`: the route answered a non-empty report and this build
    //   could not read one entry of it. Claiming the route was silent here was
    //   the lie #346 removed one branch over — the reader's problem is the
    //   payload (a page and server from different builds), not the route.
    // - `checks` with no `session-logs` entry: the route is fine and readable;
    //   this server is older than the check, or the check did not run.
    return unproven(base, [
      input.doctor.kind === 'absent'
        ? '`GET /api/doctor` produced no usable answer — a dead route, an error status, or a non-JSON body all land here; check the server this page came from. The slug directory is unavailable from here.'
        : input.doctor.kind === 'unreadable'
          ? '`GET /api/doctor` answered, but not one entry of its report was readable by this build — the route is alive; this page and its server likely come from different builds. Reload the page, or rebuild the web bundle. The slug directory is unavailable from here.'
          : '`GET /api/doctor` answered, but carried no `session-logs` check — the route is fine; this server is older than the check, or the check did not run',
    ])
  }
  // A probe, not a stored fact: doctor answered about the filesystem as it is
  // now (the route re-probes every `PROBE_CACHE_TTL_MS`), so "as of this
  // render" is the only date this row can honestly carry.
  if (check.status === 'ok') return verified(base, check.message, provenNow(input.now), doctorNote(input.doctor, 'session-boundary'))

  // Doctor's own message carries both halves of the remedy — run `claude`
  // here once, or point elsewhere with `--extra-sessions`. The second is the
  // one that is a command, and the conductor-on-a-foreign-filesystem case
  // (`args.ts`: a mounted `/mnt/c/…/.claude/projects/<slug>`) is exactly the
  // one this row goes BROKEN for.
  return broken(base, check.message, {
    command: restartCommand(input.meta?.repoPath ?? null, input.port, ['--extra-sessions <session-log-dir>']),
    notes: doctorNote(input.doctor, 'session-boundary'),
  })
}

/**
 * **transcripts ↔ slug, the flow half.** A first `sessionlog`-origin record —
 * the dir resolving proves nothing about anything arriving from it.
 *
 * **The question this row asks is "has A transcript arrived", not "is
 * claude's own sessionlog collector the one that sent it" (#612).** Since
 * #609 pi emits its own real records under the SAME envelope `origin:
 * 'sessionlog'` claude's collector uses (ADR-0023, "a transcript dialect names
 * itself with `harness`" — filed as 0021 until #605 renumbered it out of a
 * collision, so older text cites that number: `harness` names the
 * dialect, `source` stays the shared literal so a third collector never
 * became a core schema change) — so `mergeFlow` below, keyed on `origin` and
 * not on which collector produced it, already answers the broad question.
 * The remedy path used to answer a NARROWER one: `disabledReason(meta,
 * 'sessionlog')` is keyed on the SESSIONLOG COLLECTOR's own name, i.e.
 * claude's. A fleet running pi only, with claude's collector genuinely
 * disabled, could VERIFY off pi's records (correctly, per the broad
 * question) while a BROKEN reading — had flow ever been empty at the same
 * time — would have quoted only claude's collector's reason, never naming
 * pi even though pi is the harness actually in front of the operator.
 *
 * The fix makes both halves ask the broad question: BROKEN only when EVERY
 * collector that can stamp a `sessionlog`-origin record — today, `sessionlog`
 * and `pi` — is disabled with a reason, the same "both, not either" rule
 * {@link agentsPanes} already uses for tmux/workmux, and for the same reason:
 * either one alone still leaves a live mechanism that has not reported yet,
 * which is UNPROVEN, not dead.
 */
function transcriptFlow(input: ConnectInputs): ChainLink {
  const base = {
    id: 'transcripts-flow',
    label: 'transcripts ↔ slug (flow)',
    question: 'has a single transcript event actually arrived?',
    evidence: 'fold' as const,
  }
  const flow = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from the transcript collector`, provenAt(flow.lastEventTs, input.now))
  }

  const sessionlogDisabled = disabledReason(input.meta, 'sessionlog')
  const piDisabled = disabledReason(input.meta, 'pi')
  if (sessionlogDisabled !== null && piDisabled !== null) {
    return broken(base, `sessionlog: ${sessionlogDisabled.reason} · pi: ${piDisabled.reason}`, {
      command: restartCommand(input.meta?.repoPath ?? null, input.port),
      notes: [
        ...(sessionlogDisabled.remedy === null ? [] : [`remedy (sessionlog): ${sessionlogDisabled.remedy}`]),
        ...(piDisabled.remedy === null ? [] : [`remedy (pi): ${piDisabled.remedy}`]),
      ],
    })
  }
  return unproven(base)
}

/**
 * **dollars/traces ↔ OTel**, and the row prd19 was written for.
 *
 * A folded `telemetry.refused` with nothing otel-origin behind it is BROKEN,
 * never UNPROVEN, and the remedy comes out of the refusal's OWN payload: the
 * instance the export declared, and the instance it should have carried.
 * That is ruling 3's sentence and this issue's first stated law — and it is
 * the one case where "nothing arrived" is provably not "nothing has happened
 * yet": something arrived, was identified as someone else's, and was thrown
 * away.
 *
 * **A REFUSAL OUTRANKS FLOW, and that is the ruling, not a preference.** A
 * refusal is never counted as flow (`selectConnection`'s load-bearing
 * exclusion), and the fleet where both are true — two agents, one wired to
 * this instance and one to a stale one — used to read VERIFIED here with the
 * standing fault demoted to a note. That put "0 broken" on the tally for
 * exactly the fleet prd19 was written about: the operator reads the money
 * layer as healthy while one lane's dollars do not exist. The PRD's binding
 * sentence — a folded `telemetry.refused` renders this row BROKEN — wins
 * whether or not somebody else is exporting fine, and the flow that IS
 * arriving is carried as a note so neither fact erases the other. (Ruled on
 * PR #334's review; prd-19 stands as written.)
 */
function otelLink(input: ConnectInputs): ChainLink {
  const base = {
    id: 'otel',
    label: 'dollars/traces ↔ OTel',
    question: 'is any agent exporting telemetry to this instance?',
    evidence: 'fold' as const,
  }
  const flow = mergeFlow(input.flow.otel, input.meta?.connection?.sources.otel)
  const refusal = latestRefusal(input)

  if (refusal !== null) {
    const who = refusal.declared === null ? 'declared no instance at all' : `declared instance ${refusal.declared}`
    const plural = refusal.count === 1 ? '' : 's'
    const command = envCommand(null, null, input.port)
    const flowing =
      flow.count > 0
        ? [`${records(flow.count)} DID arrive from OTel — some agent is wired correctly; the refused one is not, and its dollars and traces do not exist`]
        : []
    return broken(
      base,
      `${refusal.count} telemetry export${plural} refused: this Rhizomorph is instance ${refusal.expected ?? 'unavailable'}, and the export ${who} — one repo, one Rhizomorph, so nothing from it was recorded`,
      { command, warning: SAME_PROCESS_WARNING, notes: [...flowing, envApplyNote(command), ...doctorNote(input.doctor, 'telemetry')] },
    )
  }

  if (flow.count > 0) {
    return verified(base, `${records(flow.count)} from OTel — usage, dollars, spans`, provenAt(flow.lastEventTs, input.now))
  }

  return unproven(base, [...doctorNote(input.doctor, 'telemetry'), ...doctorNote(input.doctor, 'cli-version-drift')])
}

/**
 * The standing fault, read from **one** witness — never half from each.
 *
 * The fold and `/api/meta`'s summary both report the most recent refusal, and
 * whichever holds more of them holds the fault (the fold wins a tie: it is
 * the live one). What this must not do is take the count from one and the
 * instance names from the other: a folded refusal that declared NO instance
 * would then be described using meta's offender's id, and ruling 3 says the
 * remedy comes "from its own payload". So the witness is chosen once, and
 * every field below comes from it. (Reviewer's finding on PR #334: the `??`
 * chain this replaces fell through on a legitimately-null `instance`.)
 */
function latestRefusal(input: ConnectInputs): { count: number; declared: string | null; expected: string | null } | null {
  const folded = input.refusals.records
  const latest = folded[folded.length - 1]
  const served = input.meta?.connection?.refusals ?? null
  const servedCount = served?.count ?? 0

  if (latest !== undefined && folded.length >= servedCount) {
    return { count: folded.length, declared: latest.instance, expected: latest.expectedInstance }
  }
  if (served !== null && servedCount > 0) {
    return { count: servedCount, declared: served.instance, expected: served.expectedInstance }
  }
  return null
}

/**
 * One witness's account of a session with transcript activity and no
 * telemetry — the fold's own `UninstrumentedSession`, or the same fact as
 * `/api/meta` served it, in one shape so the row cannot treat them
 * differently.
 */
export interface UninstrumentedWitness {
  sessionId: string
  lanes: string[]
  roles: AgentRole[]
  /**
   * `null` only when the witness carried no usable first sighting — a
   * session that can be named but never aged. See {@link mergeUninstrumented}
   * for why that case is not granted the grace window.
   */
  firstEventTs: number | null
  /** `UninstrumentedSession.worktreePath` / `UninstrumentedFacts.worktreePath` — not rendered by this wave (#515). */
  worktreePath: string | null
  /** See {@link worktreePath}. */
  branch: string | null
}

/** A served role string is only a role if it is one of the four the schema has — anything else is dropped rather than passed to `--role`. */
function knownRoles(roles: readonly string[]): AgentRole[] {
  return roles.filter((role): role is AgentRole => (AGENT_ROLES as readonly string[]).includes(role))
}

/**
 * TWO WITNESSES TO THE SAME ABSENCE, unioned by session id.
 *
 * `/api/meta` runs the same `selectConnection` over the same log this page's
 * SSE fold does, so its `uninstrumentedSessions` is a second reading of one
 * truth — and for the first seconds of every page load, and for as long as an
 * SSE error keeps the fold empty, it is the ONLY reading. Consuming only the
 * fold meant the row could read VERIFIED ("every session with transcript
 * activity has also exported telemetry") off a merged sessionlog count that
 * came from meta while ignoring the uninstrumented list meta served in the
 * same body — the row contradicting its own source. Reviewer's finding on
 * PR #334; ruled to merge rather than to gate the VERIFIED path down to the
 * fold's own count, since that would go quiet exactly when SSE lags.
 *
 * The fold wins on a session both witnesses name: it is the live one, and its
 * `roles`/`lanes` are typed rather than parsed. A session only meta named is
 * appended whole.
 */
export function mergeUninstrumented(
  folded: readonly UninstrumentedSession[],
  served:
    | readonly {
        sessionId: string
        lanes: string[]
        roles: string[]
        firstEventTs: number | null
        worktreePath?: string | null
        branch?: string | null
      }[]
    | undefined,
): UninstrumentedWitness[] {
  const witnesses: UninstrumentedWitness[] = folded.map((session) => ({
    sessionId: session.sessionId,
    lanes: [...session.lanes],
    roles: [...session.roles],
    firstEventTs: session.firstEventTs,
    worktreePath: session.worktreePath,
    branch: session.branch,
  }))
  const seen = new Set(witnesses.map((witness) => witness.sessionId))

  for (const session of served ?? []) {
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    witnesses.push({
      sessionId: session.sessionId,
      lanes: [...session.lanes],
      roles: knownRoles(session.roles),
      firstEventTs: session.firstEventTs,
      worktreePath: session.worktreePath ?? null,
      branch: session.branch ?? null,
    })
  }
  return witnesses
}

/**
 * Ripe for BROKEN: the grace window has passed, **or the witness carried no
 * date to measure it against**. The window is an exemption granted to a
 * session that might still be exporting its first batch, and an exemption
 * this page cannot measure is one it must not grant — the alternative is a
 * malformed timestamp buying a permanently silent row on the one page whose
 * subject is what has been proven.
 */
function pastGrace(witness: UninstrumentedWitness, now: number): boolean {
  return witness.firstEventTs === null || now - witness.firstEventTs >= FIRST_EXPORT_GRACE_MS
}

/** The lane whose env block would fix this session, and the role to generate it for. */
function relaunchTarget(session: UninstrumentedWitness): { lane: string | null; role: AgentRole | null } {
  return {
    lane: session.lanes[0] ?? null,
    role: session.roles.includes('conductor') ? 'conductor' : (session.roles[0] ?? null),
  }
}

/**
 * The last segment of a worktree path — see {@link InstrumentableSession.place}.
 * Both separators, because the path came off a wire whose other end may be a
 * Windows checkout, and a `\`-joined path would otherwise return whole.
 */
function worktreeTail(worktreePath: string | null): string | null {
  if (worktreePath === null) return null
  const segments = worktreePath.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? null
}

/** One ripe witness, in the form the page can act on — the same target and the same env block the row's own headline command is built from. */
function instrumentable(witness: UninstrumentedWitness, port: string, now: number): InstrumentableSession {
  const { lane, role } = relaunchTarget(witness)
  const env = envCommand(lane, role, port)
  return {
    sessionId: witness.sessionId,
    lane,
    role,
    ageLabel: witness.firstEventTs === null ? 'undated' : `${formatSpan(now - witness.firstEventTs)} ago`,
    place: { branch: witness.branch, worktreeTail: worktreeTail(witness.worktreePath) },
    resumeCommand: resumeCommand(env, witness.sessionId),
    envCommand: env,
  }
}

/**
 * **THE UNINSTRUMENTED CONDUCTOR** — the PRD's own evidence case (operator
 * report, Gabe, 2026-08-07: rhizomorph ran fine and the Claude instance
 * driving it was never instrumented, and nothing on any surface said so). A
 * first-class BROKEN row with the relaunch command beside it, exactly as
 * ruling 3 requires, rather than an inference a reader has to make by
 * noticing that two other rows disagree.
 *
 * The grace window ({@link FIRST_EXPORT_GRACE_MS}) is the one judgment
 * `selectConnection` explicitly left to this layer: a session whose
 * transcript activity started moments ago may be an instrumented agent whose
 * first batch is still in flight, and calling that dead would be an alarm
 * about waiting.
 *
 * Both witnesses count ({@link mergeUninstrumented}): a session `/api/meta`
 * named is the same broken link as one the fold named, and reading only the
 * fold let this row claim the opposite of what meta had just served.
 */
function uninstrumentedConductor(input: ConnectInputs): ChainLink {
  const base = {
    id: 'uninstrumented-conductor',
    label: 'the uninstrumented conductor',
    question: 'is every agent with transcript activity also exporting telemetry?',
    evidence: 'fold' as const,
  }
  const witnesses = mergeUninstrumented(input.flow.uninstrumentedSessions, input.meta?.connection?.uninstrumentedSessions)
  const ripe = witnesses.filter((witness) => pastGrace(witness, input.now))

  if (ripe.length > 0) {
    const worst = ripe.find((session) => session.roles.includes('conductor')) ?? ripe[0]!
    const { lane, role } = relaunchTarget(worst)
    const command = envCommand(lane, role, input.port)
    const where = lane === null ? '' : role === null ? ` (lane ${lane})` : ` (lane ${lane}, ${role})`
    const named = `session ${worst.sessionId}${where}`
    const others = ripe.length === 1 ? '' : ` — and ${ripe.length - 1} more session${ripe.length === 2 ? '' : 's'} like it`
    return broken(
      base,
      `${named} has transcript activity and has exported no telemetry at all${others}: this agent was launched without the env block, so its dollars and traces do not exist`,
      {
        command,
        warning: SAME_PROCESS_WARNING,
        notes: [envApplyNote(command), 'the agent has to be relaunched — an env block exported after `claude` started never reaches it'],
        // Every ripe session, not only the worst offender the sentence above
        // names: the row says what is wrong in one line, and the enumeration
        // is where an operator picks WHICH of them to act on (#520). Ripe
        // only — a session still inside the grace window has not been shown
        // to be uninstrumented at all, and offering to relaunch it would be
        // an alarm about waiting.
        sessions: ripe.map((witness) => instrumentable(witness, input.port, input.now)),
      },
    )
  }

  if (witnesses.length > 0) {
    return unproven(base, [
      `${witnesses.length} session${witnesses.length === 1 ? '' : 's'} with transcript activity and no telemetry yet — inside the ${Math.round(FIRST_EXPORT_GRACE_MS / 1000)}s window an instrumented agent's first export is allowed to take`,
    ])
  }

  const sessionlog = mergeFlow(input.flow.sessionlog, input.meta?.connection?.sources.sessionlog)
  if (sessionlog.count > 0) {
    const otel = mergeFlow(input.flow.otel, input.meta?.connection?.sources.otel)
    return verified(base, 'every session with transcript activity has also exported telemetry', provenAt(otel.lastEventTs, input.now))
  }
  return unproven(base, ['no transcript activity has arrived yet, so there is no session to check'])
}

/**
 * **A FIXTURE FOLD IS NOT EVIDENCE, PER ROW** (#343).
 *
 * Ruling 6 was already satisfied to the letter by the page-level
 * `connect-not-live` banner, and that was not enough: a banner is a label on a
 * page, not a property of a row, and a reader who scrolls past it sees six
 * green ticks. The whole design of this checklist is that each row carries its
 * own truth so nobody has to hold context in their head, and that design is
 * worth nothing if the single most important caveat on the page is the one
 * thing kept outside the rows.
 *
 * Everything goes — the fact, the reason, the command — not just the green.
 * **A synthetic lane's `env` command must never be copyable**: handing someone
 * `rhizomorph env lane-17 …` for a lane that exists only inside a 20-lane
 * fixture is worse than an unhelpful row, because it is an instruction to do
 * something pointless and then wonder why nothing changed. Clearing `command`
 * is what removes the copy button (`index.tsx` renders one only where there is
 * a command), so the row stops offering the action rather than offering it
 * with a warning attached.
 *
 * **The notes go with it, all of them.** Every note on a row was written to
 * support a claim this row is no longer making — and one of them,
 * {@link envApplyNote}, carries the exact command the copy button was just
 * denied, wrapped in an `eval` a reader can select and paste. Clearing
 * `command` while leaving that in prose would remove the button and keep the
 * instruction. Doctor's own findings are not lost by this: they are unchanged
 * and unranked in the panel below the rows, which is what that panel is for.
 *
 * What this costs, stated rather than hidden: a row that would have gone
 * BROKEN on `/api/meta`'s own evidence — a collector disabled at boot — goes
 * quiet under a fixture too. That is the right trade and not merely an
 * accepted one. {@link mergeFlow} and {@link mergeUninstrumented} have by then
 * FUSED the fabricated fold with the real poll into single counts and single
 * session lists; the row can no longer say which witness it is quoting, and a
 * page whose subject is proof must not make a claim it cannot attribute.
 *
 * "Everything goes" is {@link unproven}'s own definition, so this calls it
 * rather than restating the reset field by field: a row rebuilt UNPROVEN from
 * a fixture must be indistinguishable from one that was born UNPROVEN, and a
 * hand-listed copy of the same seven nulls is exactly where a field added to
 * one and not the other would survive a fixture as a fabricated claim.
 */
function fromFixture(link: ChainLink, input: ConnectInputs): ChainLink {
  return unproven(link, [
    `${input.stream.provenance} is driving this fold — a recording or a synthetic fleet, not this instrument, so nothing folded from it is evidence about this instrument's own wiring`,
  ])
}

/**
 * **A DEAD STREAM IS NOT EVIDENCE EITHER** (#345).
 *
 * VERIFIED on this page does not mean "this was true once"; it means "I
 * checked, and it holds". A fold row's checker is the SSE stream, so when the
 * stream dies nothing is checking and the strongest word this page has has to
 * be withdrawn — however recently it was earned. A green row with a timestamp
 * forty minutes old still reads green at a glance, and glancing is exactly what
 * people do on a page they opened because something was already wrong.
 *
 * **The fact and its date stay.** They are not a lie and they are worth
 * showing: "UNPROVEN, and here is the last thing that WAS proven, dated" says
 * everything a fourth LAST KNOWN state would have said, using a word the
 * reader has already had to learn. Three states are already a vocabulary a
 * stranger picks up mid-incident; a fourth is not worth the precision.
 *
 * **Only VERIFIED is withdrawn.** A BROKEN fold row stays BROKEN: a refusal
 * that folded, or a conductor that ran uninstrumented, is something that
 * happened, and the stream dying afterwards does not un-happen it. The
 * asymmetry with {@link fromFixture} is the same distinction one step on — a
 * fixture's fault never happened at all.
 *
 * **`connecting` is not dead.** It is the ordinary first moment of every page
 * load, and demoting there would make the first paint contradict the
 * `/api/meta` body it had just read — the precise failure
 * {@link mergeUninstrumented} was ruled into existence to remove ("that would
 * go quiet exactly when SSE lags").
 */
function lastProven(link: ChainLink, input: ConnectInputs): ChainLink {
  return {
    ...link,
    state: 'unproven',
    notes: [
      ...link.notes,
      `${STREAM_REASON[input.stream.status]} — the fact above is the last one that WAS proven, and nothing has checked it since`,
    ],
  }
}

/**
 * The one gate both #343 and #345 pass through, because they are one question:
 * **VERIFIED requires live evidence from that row's own source.** Poll-derived
 * rows have their own source and their own freshness and are untouched by
 * either — a dead SSE says nothing about whether the last `GET /api/doctor`
 * succeeded, and a fixture in the fold says nothing about whether the
 * directory doctor just probed exists.
 */
function attest(link: ChainLink, input: ConnectInputs): ChainLink {
  if (link.evidence === 'poll') return link
  if (!input.stream.live) return fromFixture(link, input)
  if (link.state === 'verified' && streamIsDead(input.stream.status)) return lastProven(link, input)
  return link
}

/**
 * The chain, in the order ruling 3 lists it: browser↔server · repo↔git ·
 * agents↔tmux/workmux · transcripts↔slug (plumbing, then flow) ·
 * dollars/traces↔OTel — and last, the named case the whole PRD is evidence
 * for. Every row is then held to {@link attest}, in one place, so no row can
 * be added that quietly skips it.
 */
export function buildLinks(input: ConnectInputs): ChainLink[] {
  return [
    browserServer(input),
    repoGit(input),
    agentsPanes(input),
    transcriptSlug(input),
    transcriptFlow(input),
    otelLink(input),
    uninstrumentedConductor(input),
  ].map((link) => attest(link, input))
}

/** How many rows are in each state — the page's one-line summary, and never a score. */
export function tally(links: readonly ChainLink[]): Record<LinkState, number> {
  const counts: Record<LinkState, number> = { verified: 0, broken: 0, unproven: 0 }
  for (const link of links) counts[link.state] += 1
  return counts
}
