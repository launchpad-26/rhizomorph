import { selectSessionSpend } from '../selectors/index.js'
import type { SessionState } from '../state.js'
import type { LaneManifest } from './fences.js'
import type { Gap, Lane } from './types.js'

/**
 * `.swarm/lanes.json` is written by the operator's dispatch tooling, never by
 * this repo — `buildFleet`/`buildGaps` only ever read it (`fences.ts`'s own
 * doc comment says the same). The remedy this replaced named `dispatch.sh`,
 * a script that has never existed anywhere in this tree (issue #63): a reader
 * who searched for it was left worse off than if the gap had said nothing.
 * Named once so the two gaps below that hand it out cannot drift apart the
 * way the two copies of the old, wrong string never did either.
 */
const DISPATCH_TOOLING_REMEDY =
  'your dispatch tooling — writes .swarm/lanes.json, not part of this repo (see docs/user-guide/troubleshooting.md)'

// ── gap voice (law 12) ──────────────────────────────────────────────────────
//
// A collector speaks here in two of its four statuses: `disabled` (dead) and
// `degraded-retrying` (ruling 2's honest middle, #304 — answering, but
// retrying after consecutive failures). `healthy` and a one-off `error` stay
// silent here by design: `error` already escalates through the ladder
// (`ladder.ts`), and a collector that never failed has nothing to report.

export function buildGaps(
  state: SessionState,
  costTotals: ReturnType<typeof selectSessionSpend>,
  lanes: readonly Lane[],
  manifest: LaneManifest | null,
): Gap[] {
  const gaps: Gap[] = []
  const add = (id: string, what: string, why: string, command: string): void => {
    gaps.push({ id, what, why, command, line: `${what} — ${why} — run: ${command}` })
  }

  if (costTotals.costEventCount === 0) {
    add(
      'no-cost-feed',
      'NO COST FEED (OTel)',
      'dollars unavailable',
      'eval "$(rhizomorph env <lane>)"',
    )
  }

  if (manifest === null) {
    add(
      'no-lane-manifest',
      'NO LANE MANIFEST (.swarm/lanes.json)',
      'off-fence detection unavailable',
      DISPATCH_TOOLING_REMEDY,
    )
  } else {
    const unfenced = lanes.filter((lane) => !lane.fenced && !lane.telemetryOnly)
    if (unfenced.length > 0) {
      add(
        'unfenced-lanes',
        `NO FENCE FOR ${unfenced.length}/${lanes.length} LANES`,
        'those lanes cannot be judged off-fence',
        DISPATCH_TOOLING_REMEDY,
      )
    }
  }

  const unattributed = lanes.filter((lane) => lane.role === 'unattributed' && lane.outputTokens > 0)
  if (unattributed.length > 0) {
    add(
      'unattributed-spend',
      `UNATTRIBUTED SPEND (${unattributed.length} lane${unattributed.length === 1 ? '' : 's'})`,
      'burn has no declared owner',
      'eval "$(rhizomorph env <lane> --role worker)"',
    )
  }

  if (!state.telemetry.costs.some((record) => record.role === 'conductor')) {
    add(
      'conductor-not-instrumented',
      'CONDUCTOR NOT INSTRUMENTED',
      'orchestration overhead unknowable',
      'rhizomorph enlist claude',
    )
  }

  for (const collector of Object.values(state.collectors)) {
    if (collector.status === 'disabled') {
      add(
        `collector-disabled:${collector.name}`,
        `${collector.name.toUpperCase()} COLLECTOR DISABLED`,
        collector.disabledReason ?? 'source unavailable',
        'rhizomorph doctor',
      )
    } else if (collector.status === 'degraded-retrying') {
      add(
        `collector-degraded:${collector.name}`,
        `${collector.name.toUpperCase()} COLLECTOR DEGRADED`,
        collector.lastErrorMessage ?? 'retrying after failures',
        'rhizomorph doctor',
      )
    }
  }

  return gaps
}
