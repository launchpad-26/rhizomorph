import type { AnyCollector, Collector, RhizomorphEvent } from '@rhizomorph/core'
import { reduceAll } from '@rhizomorph/core'
import { type BeaconCollectorConfig, createBeaconCollector } from '../collectors/beacon/index.js'
import { gitCollector } from '../collectors/git/index.js'
import { createJudgeCollector, DEFAULT_JUDGE_CADENCE_MS } from '../collectors/judge/index.js'
import { createPiCollector, type PiCollectorConfig } from '../collectors/pi/index.js'
import { createProcessCollector, type ProcessCollectorOptions } from '../collectors/process/index.js'
import type { DisableableSnapshot } from '../collectors/resilience.js'
import { withResilience } from '../collectors/resilience.js'
import {
  withAgentReconciliation,
  withBranchReconciliation,
  withDirtyStatusReconciliation,
  withResumeReconciliation,
} from '../collectors/resume-reconcile.js'
import { createSessionlogCollector, type SessionlogCollectorConfig } from '../collectors/sessionlog/index.js'
import { tmuxCollector } from '../collectors/tmux/index.js'
import { createWorkmuxCollector } from '../collectors/workmux/index.js'

/**
 * prd11 ruling 6b, phase 1: the judge organ's cadence, flag-adjustable — but
 * this issue's fence doesn't reach `cli/args.ts`, so there is no `--` flag
 * yet. An env var is the fence-scoped stand-in a future lane can promote to a
 * real CLI flag without touching this file's wiring shape.
 */
const JUDGE_CADENCE_ENV = 'RHIZOMORPH_JUDGE_CADENCE_MS'

function judgeCadenceMs(): number {
  const raw = process.env[JUDGE_CADENCE_ENV]
  if (raw === undefined) return DEFAULT_JUDGE_CADENCE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_JUDGE_CADENCE_MS
}

/**
 * Registers the seven collectors via static imports, so Vite/Rollup can
 * bundle them (a variable dynamic import like `import(\`./${slug}\`)` cannot be
 * statically analysed and fails at runtime). A collector whose binary is
 * missing (no tmux, no workmux) still loads fine here — it degrades to
 * `collector.disabled` at poll time, which is the collector's job, not this
 * one's. The judge (prd11 ruling 6b) self-throttles its own cadence below the
 * poll loop's tick; sessionlog (#240) and pi (#546) are the two that take
 * their own config (sessionlog: `claudeProjectsRoot`, `home`,
 * `backfill`; pi: `piSessionsRoot`, `backfill`), threaded through by the
 * caller instead of a zero-arg factory like their peers.
 *
 * Every collector here is wrapped in `withResilience` (#110) — the shared
 * retry/backoff/self-heal policy, applied once at the seam where collectors
 * are assembled for the poll loop rather than copied into each collector.
 * A collector's own poll() still decides *whether* a tick failed (it emits
 * `collector.disabled` exactly as before); the wrapper decides how many
 * consecutive failures to tolerate before that actually sticks, and keeps
 * probing afterwards so it can un-stick itself. #240: sessionlog used to be
 * constructed and spliced in *outside* this function (`cli/run.ts`), so it
 * never got this wrap at all — one failed `stat(~/.claude/projects)` latched
 * it disabled forever. Registering it here, through the same `wrap()`, is
 * the fix: `loadCollectors` is now the only place any collector is built for
 * the live poll loop.
 *
 * Then wrapped again in `withResumeReconciliation` (#111), fed the folded
 * status of whatever session this boot is resuming (`priorEvents`, empty for
 * a fresh session). `withResilience`'s self-heal only fires on an in-process
 * failing→succeeding transition — a freshly booted collector starts healthy
 * in memory and never makes that transition, so a stale `collector.disabled`
 * already in the log would otherwise outlive every restart. This is the seam
 * that lets the live poll catch the fold up to reality on boot.
 */
export async function loadCollectors(
  _log: { warn: (msg: string) => void } = console,
  priorEvents: readonly RhizomorphEvent[] = [],
  sessionlogConfig: SessionlogCollectorConfig = {},
  piConfig: PiCollectorConfig = {},
  beaconConfig: BeaconCollectorConfig = {},
  processConfig: ProcessCollectorOptions = {},
): Promise<AnyCollector[]> {
  const folded = reduceAll(priorEvents)
  function wrap<S extends DisableableSnapshot>(collector: Collector<S>): AnyCollector {
    return withResumeReconciliation(withResilience(collector), folded.collectors[collector.name])
  }

  // #418: withAgentReconciliation must sit inside withResilience — it reads
  // the raw WorkmuxSnapshot's `agents`, not the ResilientSnapshot envelope —
  // so workmux can't go through the generic wrap() alone. foldedHandles is
  // the resumed session's still-`present` agent handles (an agent record is
  // a soft delete, see resume-reconcile.ts's withAgentReconciliation).
  //
  // This placement used to carry a second, unwritten dependency: on a failed
  // first poll, withAgentReconciliation would still compute "every folded
  // handle is a ghost" against the carried-forward (possibly empty) snapshot
  // and emit agent.removed for each — invisible only because withResilience,
  // sitting outside it, discards an inner result's events wholesale on
  // failure (resilience.ts's collector.disabled handling). Had withResilience
  // ever forwarded inner events alongside a degraded/disabled report, every
  // folded agent would have been retired on one workmux hiccup after a
  // resume. Fixed at the source instead (#418, verify findings): withAgentReconciliation now
  // bails without latching whenever the poll it just ran reports
  // collector.disabled, so this placement is a pure snapshot-shape necessity
  // again, not a correctness dependency on the outer wrapper's behaviour.
  const foldedPresentAgentHandles = new Set(
    Object.entries(folded.agents)
      .filter(([, agent]) => agent.present)
      .map(([handle]) => handle),
  )

  // #449: branches are a hard delete from the fold (`reduce.ts`'s
  // `branchRemoved`), unlike agents' soft `present: false` — so the ghost
  // set is every folded branch name, not a filtered subset. Object.keys is
  // deliberate here; do not copy the agent wrapper's `.present` filter.
  const foldedBranchNames = new Set(Object.keys(folded.branches))

  // #536: dirtyStatusFailedSince is a per-worktree fact the collector's own
  // dirtyFailures counter cannot reconcile on a resume with no memory of a
  // prior incident — same shape as foldedBranchNames just above, scoped to
  // this one field instead of branch identity.
  const foldedDirtyStatusFailedPaths = new Set(
    Object.entries(folded.worktrees)
      .filter(([, worktree]) => worktree.dirtyStatusFailedSince !== null)
      .map(([path]) => path),
  )

  return [
    wrap(
      withBranchReconciliation(
        withDirtyStatusReconciliation(gitCollector, foldedDirtyStatusFailedPaths),
        foldedBranchNames,
      ),
    ),
    wrap(tmuxCollector),
    wrap(withAgentReconciliation(createWorkmuxCollector(), foldedPresentAgentHandles)),
    wrap(createJudgeCollector({ cadenceMs: judgeCadenceMs() })),
    wrap(createSessionlogCollector(sessionlogConfig)),
    wrap(createPiCollector(piConfig)),
    wrap(createBeaconCollector(beaconConfig)),
    // prd-57 ruling 1, licensed by ADR-0052. Registered here by STATIC
    // import like every sibling — a variable dynamic specifier cannot be
    // bundled, which is what this file's own comment records. Its reader
    // answers null on every platform with no leg built, so on macOS and
    // Windows this collector polls, emits nothing, and says so through
    // `doctor` rather than reporting an empty process table as an empty
    // fleet.
    wrap(createProcessCollector(processConfig)),
  ]
}
