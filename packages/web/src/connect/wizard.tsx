import { useEffect, useState } from 'react'
import { BUTTON, BUTTON_PRIMARY, FIELD } from '../ui/controls.js'
import { requestClone, type CloneFetchLike, type CloneOutcome } from '../concierge/clone.js'
import { requestInstrument, type InstrumentFetchLike, type InstrumentMode, type InstrumentOutcome } from '../concierge/instrument.js'
import type { CopyText } from '../drawer/AttachButton.js'
import { restartCommand, STATE_GLYPH, STATE_WORD, type ChainLink } from './links.js'
import {
  fetchRepos,
  isWorktreeLaneSlug,
  REPO_SELECT_CAP,
  UNAVAILABLE,
  type FetchLike,
  type MetaFacts,
  type ReposReading,
} from './meta.js'

/**
 * THE SETUP WIZARD (prd-20 wave 4, #266) — the face of the concierge, and the
 * one stop between a stranger and an instrumented conductor: **repo →
 * conductor → verify**, each step a single explicit click, no shell command
 * composed along the way.
 *
 * It lives on `/connect` because that is where the evidence already is. Its
 * third step is not a new surface at all — it is prd-19's own handshake rows,
 * the exact `ChainLink[]` the page below is already rendering, read live off
 * the same fold. Nothing here re-derives a connection fact, and nothing here
 * has a second opinion about one.
 *
 * ## Ruling 7 still holds, and this file is why the file list grew to five
 *
 * `index.test.tsx`'s ruling-7 law pins the names in this directory. That list
 * is an anti-drift device, not a size limit, and its point is that every source
 * file here is one a reviewer has looked at and found to mutate nothing. This
 * file honours that exactly: it names no verb, builds no request init and
 * reaches for no execution channel — its two acts go out through
 * `../concierge/clone.js` and `../concierge/instrument.js`, the app's fifth and
 * fourth mutating calls, each behind its own module doc and its own law, the
 * same way `InstrumentButton` already worked from inside `index.tsx`. The list
 * gains `wizard.tsx` rather than this becoming a fifth section of a 900-line
 * `index.tsx`, because the checklist and the wizard are two things a reader
 * reads separately.
 *
 * ## The one honesty this wizard turns on
 *
 * **A conductor is launched in the repo THIS server is watching, always.** The
 * launch route (`../concierge/instrument.js`'s one route) takes no repo: it
 * uses `ctx.repoPath`, and retarget-in-place is prd-20's own open question,
 * unbuilt (its spike is wave 3's, and the PRD's "Open questions" still names
 * the semantics as unruled). So the conductor step does two different things
 * depending on what the repo step chose:
 *
 * - **the watched repo** — the conductor step is live, and the launch button
 *   acts;
 * - **any other repo, including one just cloned** — the conductor step
 *   withholds the button entirely and hands over `restartCommand`, the exact
 *   line that starts a rhizomorph in THAT repo. Ruling 3's no-trust path,
 *   applied to the one thing this hand cannot do.
 *
 * Offering a launch button that silently started a conductor in a different
 * repo than the one on screen is the single most expensive lie this page could
 * tell, so the choice is not merely documented: `withheld` is a state of the
 * conductor step, and `wizard.test.tsx` pins it.
 *
 * ## The harness list is declared here, and a law holds it to the registry
 *
 * The harness facts live in `server/src/concierge/harness/` and no route serves
 * them, so this catalogue is a second statement of them (`packages/web` cannot
 * import `@rhizomorph/server`). A second statement is a drift risk, which is
 * why it comes with `wizard.test.tsx`'s honesty law: that law reads the real
 * adapter sources and fails the moment an id, a display name, an implementation
 * status or a `whatItWouldTake` here stops matching the registry's own. The
 * precedent is this directory's own `#344 — the two numbers, held together`,
 * which reads a constant out of the server's source for exactly this reason.
 *
 * ADR-0010's rule travels with the facts: **named, never ranked.** The order
 * below is alphabetical by id, which is the registry's own order and carries no
 * judgement, and a declared harness is LISTED with its reason and what it would
 * take — never omitted, never guessed at, and never "coming soon".
 *
 * ## Implemented is not instrumented (ledger #4)
 *
 * The catalogue used to carry one claim per harness — is it implemented — and
 * the conductor step framed every launch as instrumenting on the strength of
 * it. codex is fully implemented AND its adapter declares telemetry absent with
 * two named blockers, so a codex row offered "start it instrumented" over a
 * process that cannot report here at all. `telemetry` is now a second fact on
 * every implemented entry, carried under the same honesty law as the first, and
 * the button, the confirmation and the result each say what is true of the
 * harness in front of the operator rather than what is true of claude.
 */

/** Where the operator is. Three steps, and the wizard never skips one on their behalf. */
export type WizardStep = 'repo' | 'conductor' | 'verify'

export const WIZARD_STEPS: readonly WizardStep[] = ['repo', 'conductor', 'verify']

const STEP_TITLE: Record<WizardStep, string> = {
  repo: '1 · repo',
  conductor: '2 · conductor',
  verify: '3 · verify',
}

/**
 * One harness, as the picker states it. A restatement of
 * `server/src/concierge/harness/`'s own facts — see this module's header for
 * why it is restated and what holds it honest.
 */
export interface HarnessFacts {
  id: string
  displayName: string
  /** `implemented` means all four adapter members are proven; `declared` means the registry knows the name and nothing else. */
  status: 'implemented' | 'declared'
  /** `declared` only, and never optional in practice: what it would take, named. */
  whatItWouldTake?: string
  /**
   * **WHETHER A LAUNCH OF THIS HARNESS IS INSTRUMENTED AT ALL** — the adapter's
   * own `envRecipe().telemetry`, restated here under the same honesty law as
   * everything else on this interface (ledger #4).
   *
   * `implemented` and `instrumented` are two different claims and this picker
   * used to make only the first. codex is fully implemented — it detects, it
   * launches, it has a continuity story — and its adapter declares telemetry
   * ABSENT with two named blockers, so "start it instrumented" over a codex row
   * was a promise the registry itself refuses to make. Declared harnesses carry
   * no level: nothing launches them, so there is no launch to be honest about.
   */
  telemetry?: TelemetryClaim
}

/**
 * The adapter's telemetry claim, in `CapabilityDetail`'s own three levels —
 * `reason` and `remedy` VERBATIM from the adapter source, for the identical
 * reason {@link HarnessFacts.whatItWouldTake} is verbatim: a page that
 * paraphrases a refusal has invented a softer version of it, and the honesty
 * law compares these character for character.
 */
export interface TelemetryClaim {
  level: 'provided' | 'partial' | 'absent'
  reason?: string
  remedy?: string
}

/**
 * Every harness the registry knows, in its own alphabetical order.
 *
 * The `whatItWouldTake` strings are VERBATIM copies of the roster's
 * (`server/src/harness-roster.ts`, which `harness/not-implemented.ts` builds
 * its declared adapters from), because the honesty law compares them character
 * for character — a paraphrase here would be this page inventing a softer
 * version of a refusal the registry stated plainly.
 */
export const HARNESSES: readonly HarnessFacts[] = [
  { id: 'claude', displayName: 'Claude Code', status: 'implemented', telemetry: { level: 'provided' } },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    status: 'implemented',
    telemetry: {
      level: 'absent',
      reason:
        'TWO independent blockers, and either alone is enough. (1) the keys are verified against codex-cli 0.145.0, ' +
        'but codex posts OTLP to the BARE endpoint path with no /v1/<signal> suffix [Ran — repo capture, ' +
        'docs/research/2026-08-05-agnostic-adapters-spike.md], and api/otel.ts serves /v1/metrics, /v1/logs and ' +
        '/v1/traces only — so a correctly configured codex exports into a 404. (2) even once a bare-path route ' +
        'existed, api/otel.ts’s blockInstance reads the instance id from resource.attributes ONLY, while this ' +
        'recipe declares identity in otel.span_attributes — span attributes never reach that check, so the export ' +
        'would then be REFUSED as declaring no instance rather than received',
      remedy:
        'both halves: a bare-path OTLP route with body-shape routing, AND identity that reaches blockInstance — ' +
        'either a codex resource-attribute setting (prd-26:42 records codex resource-attribute support as untested) ' +
        'or an instance check that also reads span attributes. Plus a pricing table for codex cost (prd-26). ' +
        'Fixing only the route would turn a 404 into a refusal, which is not an improvement — not this lane',
    },
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    status: 'declared',
    whatItWouldTake:
      'a capture: the executable name, whether it emits OTLP or writes session files, and whether it has a resume ' +
      'verb at all. prd-15 ruling 4 shared conformance suite, then an adapter',
  },
  {
    id: 'pi',
    displayName: 'pi',
    status: 'declared',
    whatItWouldTake:
      'a captured pi launch under a real env/argv recipe pointed at this server, and a captured continuity attempt ' +
      '(a --continue/--resume-shaped flag or otherwise) — the observation half (capture, grammar, collector) is ' +
      'already done (#324/#540/#609); only the launch half remains',
  },
  {
    id: 'shell',
    displayName: 'a bare shell',
    status: 'declared',
    whatItWouldTake:
      'a different mechanism entirely rather than an adapter — wrapping the terminal (the pty-wrap route sketched in ' +
      'the agnostic-adapters spike), which is a separate decision with its own blast radius',
  },
]

/**
 * The two verbs the conductor step offers, and what each MEANS — ruling 3's
 * bar, met in the picker rather than in a footnote.
 *
 * `resume` is deliberately absent. It names one exact prior conversation, and
 * the surface that has one to name is the uninstrumented-session row further
 * down this page, which already carries `InstrumentButton` and its own
 * confirmation. A wizard step that has only just been told which repo to look
 * at has no session id, and offering the verb without one would be a control
 * that can only fail.
 */
const LAUNCH_MODES: ReadonlyArray<{ mode: Exclude<InstrumentMode, 'resume'>; label: string; means: string }> = [
  {
    mode: 'launch',
    label: 'start a new conductor',
    means: 'a fresh conversation, instrumented from its first turn. Nothing is continued and nothing is copied.',
  },
  {
    mode: 'continue',
    label: 'relaunch on the most recent conversation',
    means:
      'the harness resumes whatever conversation it saw last in this repo — not one you name. The old process is ' +
      'not stopped, and nothing spent before this point ever reaches this instrument’s record.',
  },
]


export interface SetupWizardProps {
  /**
   * The rows the page already built, passed in rather than re-derived — the
   * verify step's whole claim is that it is showing THOSE rows, live.
   */
  links: readonly ChainLink[]
  /** `/api/meta`'s facts, for the one thing the wizard must not get wrong: which repo this instrument is watching. */
  meta: MetaFacts | null
  /**
   * `mode === 'live' && source === 'live'`, decided by the page. A fixture may
   * show this surface and must never be handed either act — the same rule
   * `UninstrumentedSessions` already follows for the instrument button.
   */
  live: boolean
  /** The port every command interpolates, already resolved by the page. */
  port: string
  /** Test seam for the one GET this component reads. */
  fetchImpl?: FetchLike
  /** Test seam for the launch — narrower than {@link fetchImpl} on purpose; see `ConnectPageProps`. */
  instrumentFetchImpl?: InstrumentFetchLike
  /** Test seam for the clone, and narrow for the same reason. */
  cloneFetchImpl?: CloneFetchLike
  onCopy: CopyText
}

type CloneState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'done'; outcome: CloneOutcome }
  | { status: 'failed'; message: string }

/**
 * **`confirming` is prd-14 ruling 4's bar, and it is not optional here.** This
 * step spawns a real process that spends real money, which is the same fact
 * that put a confirmation in front of `../concierge/InstrumentButton.tsx` — and
 * for a while this state was missing, so the wizard reached the app's fourth
 * mutating call on ONE unarmed click while `instrument.ts`'s own module doc
 * still said the act was "behind exactly one confirmation". The two callers now
 * share the bar rather than the prose about it: first click arms and shows what
 * is about to happen and what it costs, second click spends.
 */
type LaunchState =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'working' }
  | { status: 'done'; outcome: InstrumentOutcome }
  | { status: 'failed'; message: string }

export function SetupWizard({
  links,
  meta,
  live,
  port,
  fetchImpl,
  instrumentFetchImpl,
  cloneFetchImpl,
  onCopy,
}: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>('repo')
  const [repos, setRepos] = useState<ReposReading | null>(null)
  const [chosenRepo, setChosenRepo] = useState<string | null>(null)
  const [cloneUrl, setCloneUrl] = useState('')
  const [clone, setClone] = useState<CloneState>({ status: 'idle' })
  const [harness, setHarness] = useState<string>('claude')
  const [mode, setMode] = useState<Exclude<InstrumentMode, 'resume'>>('launch')
  const [launch, setLaunch] = useState<LaunchState>({ status: 'idle' })

  // ONE READ, ONCE — never on the page's poll. The repo list is a filesystem
  // walk over the operator's home directory; re-running it every five seconds
  // to answer a question nobody asked again would be the unbounded-walk cost
  // #274 is about, paid on a timer. It is a read, so it is allowed to live in
  // an effect at all; neither of this file's two ACTS ever appears in one, and
  // `../concierge/explicit-invocation-law.test.ts` is what proves that.
  useEffect(() => {
    let alive = true
    void fetchRepos(fetchImpl).then((reading) => {
      if (alive) setRepos(reading)
    })
    return () => {
      alive = false
    }
  }, [fetchImpl])

  const watched = meta?.repoPath ?? null
  const target = chosenRepo ?? watched
  const isWatched = target !== null && target === watched

  async function confirmClone() {
    setClone({ status: 'working' })
    try {
      const outcome = await requestClone({ url: cloneUrl.trim() }, cloneFetchImpl)
      setClone({ status: 'done', outcome })
      if (outcome.kind === 'cloned') setChosenRepo(outcome.path)
    } catch (err) {
      setClone({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function confirmLaunch() {
    setLaunch({ status: 'working' })
    try {
      const outcome = await requestInstrument({ harness, mode }, instrumentFetchImpl)
      setLaunch({ status: 'done', outcome })
    } catch (err) {
      setLaunch({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <section data-testid="connect-wizard" className="rounded-none border border-(--line-hair) bg-(--surface-panel) px-3 py-3">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="heading text-(--ink-dim)">set up</h2>
        <span className="text-read-floor text-(--ink-dim)">
          repo → conductor → verify. Every step is one explicit click, and the last one is the checklist below, live.
        </span>
      </header>

      <nav className="mt-2 flex flex-wrap gap-2">
        {WIZARD_STEPS.map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`wizard-step-${name}`}
            aria-current={step === name ? 'step' : undefined}
            onClick={() => setStep(name)}
            className={step === name ? BUTTON_PRIMARY : BUTTON}
          >
            {STEP_TITLE[name]}
          </button>
        ))}
      </nav>

      {step === 'repo' && (
        <RepoStep
          repos={repos}
          watched={watched}
          chosen={target}
          onChoose={setChosenRepo}
          live={live}
          cloneUrl={cloneUrl}
          onCloneUrlChange={setCloneUrl}
          clone={clone}
          onClone={() => void confirmClone()}
        />
      )}

      {step === 'conductor' && (
        <ConductorStep
          harness={harness}
          onHarness={setHarness}
          mode={mode}
          onMode={setMode}
          links={links}
          live={live}
          isWatched={isWatched}
          target={target}
          port={port}
          launch={launch}
          onArm={() => setLaunch({ status: 'confirming' })}
          onCancelLaunch={() => setLaunch({ status: 'idle' })}
          onLaunch={() => void confirmLaunch()}
          onCopy={onCopy}
        />
      )}

      {step === 'verify' && <VerifyStep links={links} />}
    </section>
  )
}

/**
 * STEP 1 — WHICH REPO. Two ways in, and they are not ranked: the repos this
 * machine already has (`GET /api/concierge/repos`, ruling 5's read-only
 * discovery) and a URL the operator types.
 *
 * Everything the route says about the LIMITS of its own answer is shown, not
 * swallowed: a truncated scan, a directory it could not read, a `~/.claude`
 * slug it could not walk back to a real path. A picker that showed a short list
 * with no note would be saying "these are your repos" while meaning "these are
 * some of them", on the one page whose subject is whether this instrument tells
 * the truth.
 */
function RepoStep({
  repos,
  watched,
  chosen,
  onChoose,
  live,
  cloneUrl,
  onCloneUrlChange,
  clone,
  onClone,
}: {
  repos: ReposReading | null
  watched: string | null
  chosen: string | null
  onChoose: (path: string) => void
  live: boolean
  cloneUrl: string
  onCloneUrlChange: (url: string) => void
  clone: CloneState
  onClone: () => void
}) {
  const listed = repos?.kind === 'repos' ? repos.repos : []
  // The watched repo is always offered, even when discovery found nothing and
  // even when it sits nowhere a common-roots scan would look: it is the one
  // repo this instrument can actually launch into, so a list that omitted it
  // would hide the only fully working answer.
  const options = watched !== null && !listed.some((repo) => repo.path === watched)
    ? [{ path: watched, origin: 'claude-history' as const }, ...listed]
    : listed

  return (
    <div data-testid="wizard-repo" className="mt-3 flex flex-col gap-2">
      <p className="text-read-body text-(--ink-body)">
        this instrument is watching{' '}
        <span data-testid="wizard-watched" className="figures text-(--ink-primary)">
          {watched ?? UNAVAILABLE}
        </span>
      </p>

      {repos === null && (
        <p data-testid="wizard-repos-reading" className="text-read-floor italic text-(--ink-dim)">
          reading the repos this machine already has…
        </p>
      )}

      {repos?.kind === 'absent' && (
        <p data-testid="wizard-repos-absent" className="text-read-floor italic text-(--ink-dim)">
          {UNAVAILABLE} — no usable answer from the repo discovery route; the repo this instrument is already watching
          is still a choice you can make below
        </p>
      )}

      {repos?.kind === 'unavailable' && (
        <p data-testid="wizard-repos-unavailable" className="text-read-floor text-(--ink-dim)">
          {repos.reason}
        </p>
      )}

      {options.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-inst uppercase tracking-wider text-(--ink-dim)">
          <span>{options.length === 1 ? 'the repo' : `${options.length} repos`}</span>
          <select
            data-testid="wizard-repo-select"
            value={chosen ?? ''}
            onChange={(event) => onChoose(event.target.value)}
            className={FIELD}
          >
            {/* Never a phantom selection: with nothing chosen and no watched
                repo to default to, the control shows that rather than
                displaying the first option while the wizard's own target is
                still null. */}
            {chosen === null && <option value="">— choose a repo —</option>}
            {options.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.path}
                {repo.path === watched ? ' · watched now' : ''}
                {repo.origin === 'claude-history' && repo.path !== watched ? ' · claude has history here' : ''}
                {repo.origin === 'scan' ? ' · found by scanning' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {repos?.kind === 'repos' && (
        <ul data-testid="wizard-repos-limits" className="flex flex-col gap-0.5 text-read-floor leading-snug text-(--ink-dim)">
          {repos.historyUnavailable !== null && <li>{repos.historyUnavailable}</li>}
          {repos.truncated && (
            <li>
              the scan stopped at its own visit budget before it finished — this list is true and incomplete, so a repo
              you expected may simply not have been reached
            </li>
          )}
          {repos.unreadable.length > 0 && (
            <li>{repos.unreadable.length} director{repos.unreadable.length === 1 ? 'y was' : 'ies were'} reached and could not be read: {repos.unreadable.join(', ')}</li>
          )}
          {repos.overflow > 0 && (
            <li>
              {repos.overflow} more repo{repos.overflow === 1 ? ' was' : 's were'} found and {repos.overflow === 1 ? 'is' : 'are'} not
              listed — the picker caps at {REPO_SELECT_CAP}, and the clone box below reaches any of them
            </li>
          )}
          {repos.nonRepos.length > 0 && (
            <li data-testid="wizard-repos-nonrepos">
              claude has history in {repos.nonRepos.length} place{repos.nonRepos.length === 1 ? '' : 's'} that {repos.nonRepos.length === 1 ? 'is' : 'are'} not
              inside a git repo — not offered above
              {repos.nonRepos.length <= 3 ? `: ${repos.nonRepos.join(', ')}` : ''}
              {repos.nonRepos.length > 3 && (
                <details className="mt-0.5">
                  <summary className="cursor-pointer">show them</summary>
                  <span>{repos.nonRepos.join(', ')}</span>
                </details>
              )}
            </li>
          )}
          {/* THE FOLD (walkthrough, 2026-08-20). This list used to render every
              unresolved slug as its own full sentence, and a machine that had
              run one swarm held 289 worktree-lane slugs whose directories died
              with their lanes — a wall of text that buried the four lines
              above, which are the ones that can actually change what a person
              does. "Unknown is not absent" survives intact: every slug is
              still counted in the sentence, every non-worktree one is still
              named with its reason, and the worktree-shaped crowd is one
              grouped line inside the details — the FACT kept, the noise
              folded. A native <details> so this stays render-only state, no
              hook, no store, nothing for ruling 7's mutation laws to see. */}
          {repos.unresolved.length > 0 && (
            <li>
              claude has history in {repos.unresolved.length} more place{repos.unresolved.length === 1 ? '' : 's'} this
              instrument could not resolve
              <details data-testid="wizard-repos-unresolved" className="mt-0.5">
                <summary className="cursor-pointer">show why</summary>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {repos.unresolved.filter((entry) => isWorktreeLaneSlug(entry.slug)).length > 0 && (
                    <li data-testid="wizard-repos-worktree-fold">
                      {repos.unresolved.filter((entry) => isWorktreeLaneSlug(entry.slug)).length} of these are
                      worktree-lane slugs — workmux lanes whose directories are gone, one per lane of past swarm runs —
                      e.g. “{repos.unresolved.find((entry) => isWorktreeLaneSlug(entry.slug))?.slug}”
                    </li>
                  )}
                  {repos.unresolved
                    .filter((entry) => !isWorktreeLaneSlug(entry.slug))
                    .map((entry) => (
                      <li key={entry.slug}>
                        claude has history under “{entry.slug}”, and this instrument could not say where: {entry.reason}
                      </li>
                    ))}
                </ul>
              </details>
            </li>
          )}
        </ul>
      )}

      <div className="mt-1 border-t border-(--line-hair) pt-2">
        <label className="flex flex-wrap items-center gap-2 text-inst uppercase tracking-wider text-(--ink-dim)">
          <span>or clone one</span>
          <input
            type="text"
            data-testid="wizard-clone-url"
            value={cloneUrl}
            onChange={(event) => onCloneUrlChange(event.target.value)}
            placeholder="https://host/owner/repo.git"
            className={`${FIELD} w-80`}
          />
          <button
            type="button"
            data-testid="wizard-clone"
            disabled={!live || cloneUrl.trim().length === 0 || clone.status === 'working'}
            onClick={onClone}
            className={BUTTON_PRIMARY}
          >
            clone
          </button>
        </label>
        <p className="mt-1 text-read-floor leading-snug text-(--ink-dim)">
          It clones with this machine’s own git credentials — no account, no token, and a URL carrying one is refused
          before it reaches the wire. The repository lands in this instrument’s own clones directory, never inside the
          repo it is watching, and the answer arrives when git finishes rather than as it runs.
        </p>
        {!live && (
          <p data-testid="wizard-clone-fixture" className="mt-1 text-read-floor leading-snug text-notice">
            this page is reading a fixture, not the live log — nothing here will clone anything. Return to live to act.
          </p>
        )}

        {clone.status === 'working' && (
          <p data-testid="wizard-clone-working" className="mt-1 text-read-body text-(--ink-dim)">
            cloning… this waits for git to finish
          </p>
        )}
        {clone.status === 'failed' && (
          <p role="status" data-testid="wizard-clone-error" className="mt-1 text-read-body text-broken">
            {clone.message}
          </p>
        )}
        {clone.status === 'done' && (
          <div data-testid="wizard-clone-result" className="mt-1 flex flex-col gap-1">
            <p role="status" className={`text-read-body ${clone.outcome.kind === 'cloned' ? 'text-notice' : 'text-broken'}`}>
              {clone.outcome.kind === 'cloned'
                ? `cloned to ${clone.outcome.path} — chosen below. This instrument is still watching ${watched ?? UNAVAILABLE}.`
                : clone.outcome.message}
            </p>
            {clone.outcome.progress.length > 0 && (
              <pre
                data-testid="wizard-clone-progress"
                className="max-h-32 overflow-auto whitespace-pre-wrap rounded-none bg-(--surface-floor) px-2 py-1 font-mono text-inst-dense text-(--ink-body)"
              >
                {clone.outcome.progress.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * STEP 2 — WHICH CONDUCTOR, and whether this hand may start it at all.
 *
 * Two refusals live here and neither is a failure: a harness the registry only
 * NAMES has no launch line and says what it would take instead of a button, and
 * a repo that is not the one this server is watching gets the command that
 * starts a rhizomorph there. Both are ADR-0010's shape — the honest answer is
 * listed, never omitted and never guessed at.
 */
function ConductorStep({
  harness,
  onHarness,
  mode,
  onMode,
  links,
  live,
  isWatched,
  target,
  port,
  launch,
  onArm,
  onCancelLaunch,
  onLaunch,
  onCopy,
}: {
  harness: string
  onHarness: (id: string) => void
  mode: Exclude<InstrumentMode, 'resume'>
  onMode: (mode: Exclude<InstrumentMode, 'resume'>) => void
  links: readonly ChainLink[]
  live: boolean
  isWatched: boolean
  target: string | null
  port: string
  launch: LaunchState
  /** The first click — it shows what is about to happen and spends nothing. */
  onArm: () => void
  /** The way back out of an armed launch, which must exist for the arming to mean anything. */
  onCancelLaunch: () => void
  /** The second click, and the only thing in this file that reaches the act. */
  onLaunch: () => void
  onCopy: CopyText
}) {
  const facts = HARNESSES.find((entry) => entry.id === harness) ?? HARNESSES[0]
  const chosenMode = LAUNCH_MODES.find((entry) => entry.mode === mode) ?? LAUNCH_MODES[0]
  const uninstrumented = links.find((link) => link.id === 'uninstrumented-conductor')
  const canAct = live && isWatched && facts?.status === 'implemented'
  // IMPLEMENTED IS NOT INSTRUMENTED (ledger #4). Two separate claims, and this
  // step used to make only the first: codex detects, launches and has a
  // continuity story, and its adapter declares telemetry absent with two named
  // blockers. Everything the affordance says is chosen off this line rather
  // than assuming the verb.
  const instrumented = facts?.telemetry?.level === 'provided'

  return (
    <div data-testid="wizard-conductor" className="mt-3 flex flex-col gap-2">
      <label className="flex flex-wrap items-center gap-2 text-inst uppercase tracking-wider text-(--ink-dim)">
        <span>conductor</span>
        <select
          data-testid="wizard-harness-select"
          value={harness}
          onChange={(event) => onHarness(event.target.value)}
          className={FIELD}
        >
          {HARNESSES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
              {entry.status === 'implemented' ? '' : ' · named, not implemented'}
            </option>
          ))}
        </select>
      </label>

      {facts !== undefined && facts.status === 'declared' && (
        <p data-testid="wizard-harness-declared" className="text-read-body leading-snug text-waiting-benign">
          this instrument knows {facts.displayName} by name and cannot start it. What it would take:{' '}
          {facts.whatItWouldTake}
        </p>
      )}

      {/* WHETHER A LAUNCH OF THIS ONE IS INSTRUMENTED AT ALL, said where the
          harness is chosen rather than discovered after the money is spent
          (ledger #4). The registry's own reason and remedy, verbatim — a page
          that paraphrased a refusal would have invented a softer version of
          it. Declared harnesses are skipped: nothing launches them, so there
          is no launch to be honest about, and their own line above already
          says what it would take. */}
      {facts !== undefined && facts.status === 'implemented' && facts.telemetry !== undefined && (
        <p
          data-testid="wizard-harness-telemetry"
          className={`text-read-body leading-snug ${facts.telemetry.level === 'provided' ? 'text-(--ink-body)' : 'text-waiting-benign'}`}
        >
          {facts.telemetry.level === 'provided' ? (
            <>
              telemetry: proven for {facts.displayName} — a conductor started here is instrumented from its first turn,
              and the rows in step 3 are what confirm it.
            </>
          ) : (
            <>
              telemetry: {facts.telemetry.level} for {facts.displayName}. This hand can start it, and what it starts
              will not report to this instrument — the rows in step 3 will not flip for it. The registry’s own reason:{' '}
              {facts.telemetry.reason}
              {facts.telemetry.remedy !== undefined && <> — what it would take: {facts.telemetry.remedy}</>}
            </>
          )}
        </p>
      )}

      {/* THE STATUS, FROM THE FOLD'S OWN FACTS — never a second probe, and
          never attributed to a harness the fold cannot name. The
          uninstrumented row is the whole of what the event log knows about
          conductors running unwired, so this states it and says exactly whose
          fact it is. */}
      <p data-testid="wizard-conductor-status" className="text-read-body leading-snug text-(--ink-body)">
        {conductorStatus(uninstrumented)}{' '}
        <span className="text-(--ink-dim)">
          (the event log attributes a session to a lane and a worktree, never to a harness, so this is a fact about this
          repo rather than about {facts?.displayName ?? 'this harness'})
        </span>
      </p>

      {!isWatched ? (
        <div data-testid="wizard-not-watched" className="flex flex-col gap-1 rounded-none border border-(--line-hair) px-2 py-2">
          <p className="text-read-body leading-snug text-waiting-benign">
            {target ?? UNAVAILABLE} is not the repo this instrument is watching, and this hand cannot retarget one —
            switching the watched repo is prd-20’s own open question and is not built. Nothing below will start a
            conductor there. Run a rhizomorph in that repo instead, and its own wizard picks up from here:
          </p>
          <CopyableCommand
            id="wizard-start-there"
            command={restartCommand(target, port)}
            onCopy={onCopy}
          />
        </div>
      ) : (
        <>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-inst uppercase tracking-wider text-(--ink-dim)">what to start</legend>
            {LAUNCH_MODES.map((entry) => (
              <label key={entry.mode} className="flex items-baseline gap-2 text-read-body text-(--ink-primary)">
                <input
                  type="radio"
                  name="wizard-mode"
                  data-testid={`wizard-mode-${entry.mode}`}
                  checked={mode === entry.mode}
                  onChange={() => onMode(entry.mode)}
                />
                <span>{entry.label}</span>
              </label>
            ))}
          </fieldset>
          <p data-testid="wizard-mode-means" className="text-read-body leading-snug text-(--ink-dim)">
            {chosenMode?.means}
          </p>

          {/* ARMS, NEVER ACTS (prd-14 ruling 4). Its sibling
              `../concierge/InstrumentButton.tsx` has always worked this way,
              and for the same reason: what is on the other side of this click
              is a process that spends money, so the click that starts it is
              the one on the panel below, after the operator has read what it
              is about to do. */}
          {launch.status !== 'confirming' && (
            <button
              type="button"
              data-testid="wizard-launch"
              disabled={!canAct || launch.status === 'working'}
              onClick={onArm}
              className={BUTTON_PRIMARY}
            >
              {/* The verb the harness has actually earned. "start it
                  instrumented" over a codex row was a promise the registry
                  refuses to make, so the button says what IS true instead. */}
              {instrumented ? 'start it instrumented' : `start it — ${facts?.displayName ?? 'this harness'} launches uninstrumented`}
            </button>
          )}

          {launch.status === 'confirming' && (
            <div data-testid="wizard-launch-confirm-dialog" className="flex flex-col gap-2 rounded-none border border-(--line-strong) p-3">
              <p className="text-read-body text-(--ink-primary)">
                Start a {facts?.displayName ?? harness} conductor in {target ?? UNAVAILABLE}, {chosenMode?.label}?
              </p>
              <p className="text-read-body leading-snug text-(--ink-dim)">
                {chosenMode?.means} This spawns a real process on this machine and it spends real money from the moment
                it starts. Nothing here stops a process you already have running, and nothing spent before this point
                ever reaches this instrument’s record.
              </p>
              {/* Said again HERE, in the panel that spends, and not only beside
                  the picker: an operator who chose the harness a minute ago is
                  reading this sentence at the moment the money goes. */}
              {!instrumented && (
                <p data-testid="wizard-launch-uninstrumented" className="text-read-body leading-snug text-waiting-benign">
                  It will not be instrumented. {facts?.displayName ?? 'This harness'}’s adapter declares telemetry{' '}
                  {facts?.telemetry?.level ?? 'unstated'}, so what this starts spends money this instrument cannot see
                  and the rows in step 3 will not flip for it.
                </p>
              )}
              <div className="flex gap-2">
                <button type="button" data-testid="wizard-launch-cancel" onClick={onCancelLaunch} className={BUTTON}>
                  cancel
                </button>
                <button type="button" data-testid="wizard-launch-confirm" onClick={onLaunch} className={BUTTON_PRIMARY}>
                  start it
                </button>
              </div>
            </div>
          )}
          {!live && (
            <p data-testid="wizard-launch-fixture" className="text-read-floor leading-snug text-notice">
              this page is reading a fixture, not the live log — nothing here will start a process. Return to live to
              act.
            </p>
          )}

          {launch.status === 'working' && (
            <p data-testid="wizard-launch-working" className="text-read-body text-(--ink-dim)">
              starting…
            </p>
          )}
          {launch.status === 'failed' && (
            <p role="status" data-testid="wizard-launch-error" className="text-read-body text-broken">
              {launch.message}
            </p>
          )}
          {launch.status === 'done' && <LaunchResult outcome={launch.outcome} />}
        </>
      )}
    </div>
  )
}

/**
 * WHETHER A CONDUCTOR IS ALREADY RUNNING UNWIRED, in the row's own three
 * readings — never a fourth, and never a number the row did not carry.
 *
 * The count comes from the row's own enumeration and is stated ONLY when there
 * is one: `links.ts` gives a BROKEN uninstrumented row every ripe session it
 * found and clears the list on every other state, so a broken row with no
 * enumeration is a shape this page has not seen — and "0 sessions running
 * uninstrumented" is precisely the wrong sentence to invent for it, since the
 * row's whole finding is that at least one is.
 */
export function conductorStatus(link: ChainLink | undefined): string {
  if (link === undefined) return 'this page has no reading yet for whether a conductor is running unwired'
  if (link.state === 'verified') return 'no conductor is running uninstrumented — the fold has seen none'
  if (link.state === 'unproven') return 'nothing is proven either way yet about a conductor running uninstrumented'
  const count = link.sessions?.length
  if (count === undefined || count === 0) {
    return 'a conductor is running uninstrumented — the row below says which, and carries its own resume'
  }
  return `the fold names ${count} session${count === 1 ? '' : 's'} running uninstrumented right now — the rows below say which, and each carries its own resume`
}

/**
 * WHAT THE LAUNCH ACTUALLY DID (#532's four outcomes, each said as itself).
 *
 * The defect #532 named was a response that said `launched` over a process that
 * had already exited, so the one thing this must never do is compress the
 * answers back together. A tmux launch names the window to attach to; a
 * detached one says nobody is attached; a death says so and points at the
 * command; and a spawn that never happened says that.
 */
function LaunchResult({ outcome }: { outcome: InstrumentOutcome }) {
  if (outcome.kind === 'no-transcript-reachable') {
    return (
      <p role="status" data-testid="wizard-launch-result" className="text-read-body leading-snug text-waiting-benign">
        nothing was started and nothing was copied — {outcome.reason}
      </p>
    )
  }

  const { spawn } = outcome
  return (
    <div data-testid="wizard-launch-result" className="flex flex-col gap-1 rounded-none border border-(--line-hair) px-2 py-2">
      {spawn.launched && spawn.via === 'tmux' && (
        <p role="status" className="text-read-body leading-snug text-notice">
          started in the tmux window {spawn.window} (pid {spawn.pid}) — attach with{' '}
          <span className="font-mono">tmux attach -t {spawn.window}</span> and it is yours to type in.
        </p>
      )}
      {spawn.launched && spawn.via === 'detached' && (
        <p role="status" className="text-read-body leading-snug text-waiting-benign">
          started detached (pid {spawn.pid}) — there was no tmux window to put it in, so nothing is attached to it. An
          interactive harness with no terminal may exit on its own (#532); watch the rows below rather than trusting
          this line, and run the harness yourself in a terminal if nothing arrives.
        </p>
      )}
      {!spawn.launched && (
        <p role="status" className="text-read-body leading-snug text-broken">
          {spawn.message}
        </p>
      )}
      {/* THE SERVER'S OWN TELEMETRY CLAIM, not the catalogue's (ledger #4).
          The route has sent `telemetry` on every answer since #264 and the
          browser used to drop it at the destructure; it is the authoritative
          statement about the launch that actually happened, so it outranks the
          picker's restatement of the same adapter fact and is shown instead of
          it when it arrives. `null` means this answer did not say, which is
          reported as itself rather than assumed either way. */}
      {outcome.telemetry === null ? (
        <p data-testid="wizard-launch-telemetry" className="text-read-floor leading-snug text-(--ink-dim)">
          This answer said nothing about whether telemetry reaches this instrument, so nothing here claims it does.
          Step 3 is what settles it: watch the rows change, and believe those rather than this sentence.
        </p>
      ) : outcome.telemetry.level === 'provided' ? (
        <p data-testid="wizard-launch-telemetry" className="text-read-floor leading-snug text-(--ink-dim)">
          A started process is not yet a flowing one. That is what step 3 is for: watch the rows change, and believe
          those rather than this sentence.
        </p>
      ) : (
        <p data-testid="wizard-launch-telemetry" className="text-read-floor leading-snug text-waiting-benign">
          This harness reports no telemetry to this instrument ({outcome.telemetry.level}), so the rows in step 3 will
          not flip for what was just started, however well it runs. {outcome.telemetry.reason}
          {outcome.telemetry.remedy !== null && <> — what it would take: {outcome.telemetry.remedy}</>}
        </p>
      )}
    </div>
  )
}

/**
 * STEP 3 — VERIFY, and it is deliberately not a new checklist.
 *
 * These are the SAME `ChainLink` objects the page renders in full below,
 * handed straight in: the same derivation off the same fold, so a row flips
 * here the instant the record that proves it arrives, with no refetch and no
 * second opinion. What this adds is only compression — one line per link, so
 * the whole chain is readable from inside the wizard — and a pointer to the
 * full rows, which carry the reasons and the commands.
 */
function VerifyStep({ links }: { links: readonly ChainLink[] }) {
  return (
    <div data-testid="wizard-verify" className="mt-3 flex flex-col gap-1">
      <p className="text-read-body leading-snug text-(--ink-dim)">
        these are the checklist rows below, live — not a copy of them. Each says what would prove it; the full row
        carries the reason and the command.
      </p>
      <ul className="flex flex-col gap-0.5">
        {links.map((link) => (
          <li key={link.id} data-testid={`wizard-verify-${link.id}`} className="flex flex-wrap items-baseline gap-2 text-inst">
            <span
              className={`figures shrink-0 text-inst font-semibold uppercase tracking-[0.18em] ${
                link.state === 'verified' ? 'text-working' : link.state === 'broken' ? 'text-broken' : 'text-(--ink-dim)'
              }`}
            >
              <span aria-hidden="true">{STATE_GLYPH[link.state]}</span> {STATE_WORD[link.state]}
            </span>
            <span className="text-(--ink-primary)">{link.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A command, always visible, with a copy button beside it — the drawer's own
 * precedent (`AttachButton`) and this page's own `CommandBlock`, restated in
 * miniature rather than imported, because `index.tsx`'s version is a private
 * helper of that module and exporting a component from the page into the panel
 * it renders is the cycle this file already avoids once for `STATE_WORD`.
 */
function CopyableCommand({ id, command, onCopy }: { id: string; command: string; onCopy: CopyText }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`connect-copy-${id}`}
          onClick={() => {
            void onCopy(command).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            )
          }}
          className={BUTTON}
        >
          copy
        </button>
        {copied !== 'idle' && (
          <span role="status" className="figures text-inst-dense text-(--ink-dim)">
            {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
          </span>
        )}
      </div>
      <code
        data-testid={`connect-command-${id}`}
        className="block overflow-x-auto whitespace-pre rounded-none bg-(--surface-floor) px-2 py-1 font-mono text-inst text-(--ink-primary)"
      >
        {command}
      </code>
    </div>
  )
}
