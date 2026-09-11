import { rdRefusalReason } from '@rhizomorph/core'
import { type KeyboardEvent, useEffect, useState } from 'react'
import type { FetchLike } from '../../replay/api.js'
import { readChoice, readFlag, subscribeToPreferences, writePreference } from '../../settings/registry.js'
import { ExperimentComparison } from '../compare/index.js'
import { LaunchPanel } from '../launch/LaunchPanel.js'
import type { LaunchFetchLike, LaunchOutcome } from '../launch/launch.js'
import { useOfferedModels } from '../launch/models.js'
import type { LabExperiment, LabRdPattern, LabRdProposal, LabRdRun, LabRun } from '../types.js'
import { RD_NO_CORPUS_COPY, RD_NOTHING_PROPOSED_COPY } from './fixtures.js'
import { type RdFetchLike, type RdRunRequest, requestRd } from './rd.js'

/**
 * THE R&D TAB (prd-55 rulings 1, 2, 3, 4, 5, 9 and S5) — the fourth tab beside
 * Compare, Trace and Metrics, mounted by `LabPage.tsx`. Top: the R&D control
 * (a native model select over `lab.models`, a corpus switch over
 * `lab.rdCorpus`, *read and propose*, and the last run's provenance line).
 * Left: patterns by shape, count and corpus, the held-back ones dimmer. Right:
 * the selected pattern's proposals — arms, the checkpoint pick with what it
 * rejected, an estimate, *restore n arms* and *restore and run*, and *against
 * what actually happened* once an experiment exists.
 *
 * **The hand never runs without a click.** Nothing here posts to
 * the R&D route (`/api/lab/rd`) on mount or on any prop change — the one call this
 * module makes is `requestRd`, and it is reachable only from the *read and
 * propose* button's `onClick`. `RdTab.test.tsx` proves this by mutation: spy
 * on the fetch this module is handed, render, wait, and assert it was never
 * called.
 *
 * **Two widenings this tab stops at, rather than inventing around (see the
 * lane report):** *restore n arms* and *restore and run* can prefill the
 * launch review's CHECKPOINT (`LaunchPanel`'s existing `initialCheckpointId`)
 * but not its ARMS — `LaunchPanel` has no prop for that, and this module
 * reuses it by mounting, never by editing. And an operator changing the
 * checkpoint pick before launching is DETECTED and SHOWN here, but not
 * durably recorded as `rd.override`: `packages/server/src/lab/rd.ts`'s
 * `recordRdOverride` has no HTTP route, and wiring one is
 * `packages/server/src/api/lab.ts` — out of this fence. Both are named where
 * they bite, in the surface's own words, rather than silently invented
 * around.
 */

export interface RdTabProps {
  /** The lane an R&D run books its cost to — null when nothing is seated yet, which disables the control honestly. */
  lane: string | null
  /** Every experiment the workspace has read — used only for the counterfactual's baseline lookup and the launched link, never re-folded here. */
  experiments: readonly LabExperiment[]
  /** Test-only escape hatch for the one write this tab makes. */
  rdFetchImpl?: RdFetchLike
  /** Test-only escape hatch for the estimate this tab's proposal panel reads. */
  fetchImpl?: FetchLike
  /** Test-only escape hatch for the launch review's one write. */
  launchFetchImpl?: LaunchFetchLike
  /** Told once per launch the review makes — the same signal the workspace's own launch panel gives, so the rail and Metrics learn of it too. */
  onLaunched?: (outcome: LaunchOutcome) => void
}

/** *"1 issue · not yet a pattern — testing a shape that may not recur spends real money."* (ruling 3, verbatim; pluralised honestly for the count>1 case a schema violation could still carry). */
function heldBackRowCopy(count: number): string {
  return `${count} issue${count === 1 ? '' : 's'} · not yet a pattern — testing a shape that may not recur spends real money`
}

/** The sentence rendered when the operator changes a proposal's checkpoint pick before launching (ruling 4, verbatim). */
export const RD_OVERRIDE_SENTENCE = 'operator override — the choice is never re-attributed to the agent'

/** The fixed sentence a retro-or-review-sourced pattern's counterfactual renders — quoted as text, never converted to a number (S5's own words, verbatim). */
export const RD_NO_MEASURED_BASELINE = "no measured baseline — the retro's own words"

const MEASURED_SOURCE_ITEM = /^fork\.measured\/(.+)@\d+$/

/** Every run across every experiment, flattened once — the counterfactual's one place to look a `laneHandle` up. */
function allRuns(experiments: readonly LabExperiment[]): LabRun[] {
  return experiments.flatMap((experiment) => experiment.arms.flatMap((arm) => arm.runs))
}

/** The FIRST measured source item a pattern names, resolved against the runs this workspace has read — one observation, never a spread. */
function measuredBaselineFor(pattern: LabRdPattern, experiments: readonly LabExperiment[]): LabRun | null {
  const runsByHandle = new Map(allRuns(experiments).map((run) => [run.laneHandle, run]))
  for (const sourceItem of pattern.sourceItems) {
    const match = MEASURED_SOURCE_ITEM.exec(sourceItem)
    const laneHandle = match?.[1]
    if (laneHandle === undefined) continue
    const run = runsByHandle.get(laneHandle)
    if (run !== undefined && run.outcome !== undefined) return run
  }
  return null
}

/**
 * Whether a proposal, AS RENDERED, is refused — held back, or varying more
 * than one dimension (ruling 3). Runs core's OWN `rdRefusalReason` over the
 * data this tab was actually handed, so a fixture (or a malformed live
 * answer) that names a second varying dimension renders the server's refusal
 * here, never a patched proposal — the same law the server and core already
 * hold, checked again at the surface that would otherwise have to trust the
 * wire.
 */
function renderedRefusalReason(pattern: LabRdPattern, proposal: LabRdProposal): string | null {
  return rdRefusalReason({
    patternHeldBack: pattern.heldBack,
    arms: proposal.arms.map((arm) => ({ model: arm.model, brief: arm.briefDigest, checkpoint: arm.checkpointId, gate: arm.gateCommand })),
  })
}

/** ↑/↓ move focus inside the patterns list; Enter is the button's own behaviour (ruling 9 / S5's keyboard path). */
function onPatternsKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-pattern-row]')]
  if (rows.length === 0) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === 'ArrowDown' ? 1 : rows.length - 1
  rows[(Math.max(0, at) + step) % rows.length]?.focus()
}

interface ReviewFor {
  proposal: LabRdProposal
}

interface LaunchedLink {
  forkId: string
  outcome: LaunchOutcome
}

export function RdTab({ lane, experiments, rdFetchImpl, fetchImpl, launchFetchImpl, onLaunched }: RdTabProps) {
  const models = useOfferedModels()
  const [model, setModel] = useState('')
  const [corpusOn, setCorpusOn] = useState(() => readFlag('lab.rdCorpus'))
  const agentCommand = readChoice('lab.agentCommand')

  useEffect(() => subscribeToPreferences(() => setCorpusOn(readFlag('lab.rdCorpus'))), [])

  function toggleCorpus(next: boolean): void {
    writePreference('lab.rdCorpus', next)
    setCorpusOn(next)
  }

  type Phase = { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string } | { status: 'done'; run: LabRdRun }
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null)
  const [reviewFor, setReviewFor] = useState<ReviewFor | null>(null)
  const [launchedByProposal, setLaunchedByProposal] = useState<Record<string, LaunchedLink>>({})

  async function readAndPropose(): Promise<void> {
    if (lane === null || model.trim().length === 0) return
    setPhase({ status: 'running' })
    const request: RdRunRequest = { lane, model: model.trim(), corpus: corpusOn ? 'local+tracker' : 'local' }
    try {
      const run = await requestRd(request, rdFetchImpl)
      setPhase({ status: 'done', run })
      setSelectedPatternId(run.patterns.find((p) => !p.heldBack)?.patternId ?? run.patterns[0]?.patternId ?? null)
    } catch (err) {
      setPhase({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const run = phase.status === 'done' ? phase.run : null
  const noCli = run !== null && !run.available
  const disabledSentence = noCli ? run.reason : null
  const canRun = lane !== null && model.trim().length > 0 && phase.status !== 'running' && !noCli

  function handleReviewLaunched(proposal: LabRdProposal, outcome: LaunchOutcome): void {
    const forkId = outcome.arms[0]?.forkId
    if (forkId !== undefined) {
      setLaunchedByProposal((current) => ({ ...current, [proposal.proposalId]: { forkId, outcome } }))
    }
    setReviewFor(null)
    onLaunched?.(outcome)
  }

  function onReviewKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') setReviewFor(null)
  }

  return (
    <div data-testid="rd-tab" className="flex flex-col gap-4">
      <section data-testid="rd-control" aria-label="the R&D control" className="flex flex-col gap-2 border-(--line-hair) border-b pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-(--ink-body)">
            model
            <select
              data-testid="rd-model"
              aria-label="R&D model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={noCli}
              className="min-w-0 rounded-none border border-(--line-strong) bg-(--surface-floor) px-2 py-1 text-(--ink-body)"
            >
              <option value="">choose a model — a call that spends real money does not choose its own</option>
              {models.map((offered) => (
                <option key={offered} value={offered}>
                  {offered}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-(--ink-body)">
            <input
              type="checkbox"
              data-testid="rd-corpus-tracker"
              checked={corpusOn}
              onChange={(event) => toggleCorpus(event.target.checked)}
              disabled={noCli}
            />
            read the tracker with my gh too (prd-55 ruling 2)
          </label>
          <button
            type="button"
            data-testid="rd-read-and-propose"
            onClick={() => void readAndPropose()}
            disabled={!canRun}
            className="rounded-none border border-(--ink-primary) px-3 py-1.5 text-(--ink-050) disabled:opacity-40"
          >
            read and propose
          </button>
          <span className="text-(--ink-dim)">agent: {agentCommand}</span>
        </div>

        {lane === null && (
          <p data-testid="rd-no-lane" className="text-(--ink-dim)">
            seat a checkpoint first — an R&D run books its cost to a lane
          </p>
        )}

        {phase.status === 'running' && (
          <p data-testid="rd-running" className="text-(--ink-dim)">
            reading the corpus and asking the hand…
          </p>
        )}

        {phase.status === 'error' && (
          <p role="status" data-testid="rd-error" className="text-broken">
            {phase.message}
          </p>
        )}

        {noCli && (
          <p role="status" data-testid="rd-no-cli" className="text-broken">
            {disabledSentence}
          </p>
        )}

        {run !== null && run.available && run.corpus.itemCount === 0 && (
          <p data-testid="rd-no-corpus" className="text-(--ink-dim)">
            {RD_NO_CORPUS_COPY}
          </p>
        )}

        {run !== null && run.provenance !== null && (
          <p data-testid="rd-provenance" className="figures text-(--ink-dim)">
            {run.provenance.model} · ${run.provenance.total_cost_usd.toFixed(4)} · {run.turns} turn{run.turns === 1 ? '' : 's'} · corpus{' '}
            {run.provenance.corpusDigest.slice(0, 8)} · {run.provenance.claudeVersion}
          </p>
        )}
      </section>

      {run !== null && run.available && (
        <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)] gap-4">
          <aside aria-label="patterns" className="flex flex-col gap-1">
            {run.patterns.length === 0 ? (
              <p data-testid="rd-patterns-empty" className="text-(--ink-dim)">
                {RD_NO_CORPUS_COPY}
              </p>
            ) : (
              <>
                <ul onKeyDown={onPatternsKeyDown} className="flex flex-col">
                  {run.patterns.map((pattern) => {
                    const selected = pattern.patternId === selectedPatternId
                    return (
                      <li key={pattern.patternId}>
                        <button
                          type="button"
                          data-pattern-row=""
                          data-testid={`rd-pattern-${pattern.patternId}`}
                          aria-pressed={selected}
                          onClick={() => setSelectedPatternId(pattern.patternId)}
                          className={`focus-ring flex w-full flex-col gap-0.5 border-(--line-hair) border-l-2 px-2 py-2 text-left ${
                            pattern.heldBack ? 'border-l-transparent text-(--ink-dim) opacity-60' : selected ? 'border-l-(--ink-primary) bg-(--surface-raised) text-(--ink-primary)' : 'border-l-transparent text-(--ink-body)'
                          }`}
                        >
                          <span className="truncate">{pattern.shape}</span>
                          {pattern.heldBack ? (
                            <span data-testid={`rd-pattern-held-back-${pattern.patternId}`} className="figures text-(--ink-dim)">
                              {heldBackRowCopy(pattern.count)}
                            </span>
                          ) : (
                            <span className="figures text-(--ink-dim)">
                              {pattern.count} item(s) · {pattern.sourceItems.length}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {run.patterns.every((pattern) => pattern.heldBack) && (
                  <p data-testid="rd-nothing-proposed" className="px-2 text-(--ink-dim)">
                    {RD_NOTHING_PROPOSED_COPY}
                  </p>
                )}
              </>
            )}
          </aside>

          <section aria-label="the selected pattern's proposals" className="flex flex-col gap-3">
            {(() => {
              const pattern = run.patterns.find((candidate) => candidate.patternId === selectedPatternId) ?? null
              if (pattern === null) return null
              const proposal = run.proposals.find((candidate) => candidate.patternId === pattern.patternId) ?? null
              const refusal = run.refusals.find((candidate) => candidate.patternId === pattern.patternId) ?? null
              const renderedRefusal = proposal !== null ? renderedRefusalReason(pattern, proposal) : null

              if (refusal !== null || renderedRefusal !== null) {
                const reason = refusal?.reason ?? renderedRefusal
                return (
                  <div data-testid={`rd-refusal-${pattern.patternId}`} className="flex flex-col gap-2">
                    <p role="status" className="text-broken">
                      {reason}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-(--ink-dim)">raw result</summary>
                      <p className="text-(--ink-dim)">
                        not available — the R&D route (`/api/lab/rd`) reports patterns, proposals and refusals, never the hand's raw
                        text (only its digest is kept on the record). Showing it here needs that route widened.
                      </p>
                    </details>
                  </div>
                )
              }

              if (proposal === null) {
                return (
                  <p data-testid={`rd-no-proposal-${pattern.patternId}`} className="text-(--ink-dim)">
                    {pattern.heldBack ? heldBackRowCopy(pattern.count) : 'no proposal was drawn for this pattern'}
                  </p>
                )
              }

              const linked = launchedByProposal[proposal.proposalId] ?? null
              const overridden = linked !== null && linked.outcome.checkpointId !== proposal.checkpointPick.chosenCheckpointId

              return (
                <div data-testid={`rd-proposal-${proposal.proposalId}`} className="flex flex-col gap-2">
                  <p className="text-(--ink-dim)">varies: {proposal.varies}</p>
                  <ul className="flex flex-col gap-1">
                    {proposal.arms.map((arm, index) => (
                      <li key={index} data-testid={`rd-proposal-arm-${proposal.proposalId}-${index}`} className="figures text-(--ink-body)">
                        arm {index + 1} — model {arm.model ?? 'default'} · brief{' '}
                        {arm.briefDigest === null ? 'none' : arm.briefDigest.slice(0, 8)} · checkpoint {arm.checkpointId ?? 'default'} · gate{' '}
                        {arm.gateCommand ?? 'default'}
                      </li>
                    ))}
                  </ul>
                  <div data-testid={`rd-checkpoint-pick-${proposal.proposalId}`} className="text-(--ink-dim)">
                    <p>chosen: {proposal.checkpointPick.chosenCheckpointId}</p>
                    {proposal.checkpointPick.rejected.map((considered) => (
                      <p key={considered.checkpointId}>
                        rejected {considered.checkpointId} — {considered.reason}
                      </p>
                    ))}
                  </div>

                  <p className="text-(--ink-dim)">
                    arms are not prefilled below — the launch review takes the proposal's checkpoint only; match the arms
                    above by hand (this wave's widening: `LaunchPanel` has no prop to prefill them).
                  </p>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid={`rd-restore-arms-${proposal.proposalId}`}
                      onClick={() => setReviewFor({ proposal })}
                      className="rounded-none border border-(--line-strong) px-2 py-1 text-(--ink-body)"
                    >
                      restore {proposal.arms.length} arms
                    </button>
                    <button
                      type="button"
                      data-testid={`rd-restore-and-run-${proposal.proposalId}`}
                      onClick={() => setReviewFor({ proposal })}
                      className="rounded-none border border-(--ink-primary) px-2 py-1 text-(--ink-050)"
                    >
                      restore and run
                    </button>
                  </div>

                  {linked !== null && (
                    <p data-testid={`rd-launched-${proposal.proposalId}`} className="text-(--ink-dim)">
                      launched — experiment {linked.forkId}
                      {linked.outcome.failed !== null && (
                        <span data-testid={`rd-partial-${proposal.proposalId}`}>
                          {' '}
                          — {linked.outcome.arms.length} of {linked.outcome.requestedArms} requested arm(s) dispatched; arm{' '}
                          {linked.outcome.failed.arm} failed and dispatch stopped there — {linked.outcome.failed.error}
                        </span>
                      )}
                    </p>
                  )}

                  {overridden && (
                    <p data-testid={`rd-override-${proposal.proposalId}`} className="text-(--ink-dim)">
                      {RD_OVERRIDE_SENTENCE}
                    </p>
                  )}

                  {linked !== null && (
                    <div data-testid={`rd-counterfactual-${proposal.proposalId}`} className="flex flex-col gap-2 border-(--line-hair) border-t pt-2">
                      <p className="heading text-(--ink-dim)">against what actually happened</p>
                      {(() => {
                        const experiment = experiments.find((candidate) => candidate.forkId === linked.forkId) ?? null
                        const baseline = measuredBaselineFor(pattern, experiments)
                        return (
                          <>
                            {experiment !== null && <ExperimentComparison experiment={experiment} failedArms={[]} />}
                            {baseline !== null && baseline.outcome !== undefined ? (
                              <p data-testid={`rd-baseline-${proposal.proposalId}`} className="figures text-(--ink-dim)">
                                what actually happened — {baseline.laneHandle}: {baseline.outcome.verified}
                                {baseline.outcome.verifiedDetail === null ? '' : ` (${baseline.outcome.verifiedDetail})`}
                              </p>
                            ) : (
                              <p data-testid={`rd-baseline-${proposal.proposalId}`} className="text-(--ink-dim)">
                                {RD_NO_MEASURED_BASELINE}
                              </p>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )
            })()}
          </section>
        </div>
      )}

      {reviewFor !== null && (
        <div data-testid="rd-launch-review" onKeyDown={onReviewKeyDown} className="flex flex-col gap-2 border-(--line-strong) border p-3">
          <div className="flex items-center justify-between">
            <p className="heading text-(--ink-dim)">launch review — prefilled from proposal {reviewFor.proposal.proposalId}</p>
            <button type="button" data-testid="rd-launch-review-close" onClick={() => setReviewFor(null)} className="text-(--ink-dim) underline">
              esc — back
            </button>
          </div>
          <LaunchPanel
            {...(fetchImpl === undefined ? {} : { fetchImpl })}
            {...(launchFetchImpl === undefined ? {} : { launchFetchImpl })}
            initialCheckpointId={reviewFor.proposal.checkpointPick.chosenCheckpointId}
            onLaunched={(outcome) => handleReviewLaunched(reviewFor.proposal, outcome)}
          />
        </div>
      )}
    </div>
  )
}
