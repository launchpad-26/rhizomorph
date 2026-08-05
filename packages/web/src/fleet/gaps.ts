import { selectSessionSpend, type SessionState } from '@rhizomorph/core'
import type { LaneManifest } from './fences.js'
import type { Gap, Lane } from './types.js'

// ── gap voice (law 12) ──────────────────────────────────────────────────────

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
      'dispatch.sh (writes the fence manifest)',
    )
  } else {
    const unfenced = lanes.filter((lane) => !lane.fenced && !lane.telemetryOnly)
    if (unfenced.length > 0) {
      add(
        'unfenced-lanes',
        `NO FENCE FOR ${unfenced.length}/${lanes.length} LANES`,
        'those lanes cannot be judged off-fence',
        'dispatch.sh (writes the fence manifest)',
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
      'rhizomorph --extra-sessions <dir>:conductor',
    )
  }

  for (const collector of Object.values(state.collectors)) {
    if (collector.status !== 'disabled') continue
    add(
      `collector-disabled:${collector.name}`,
      `${collector.name.toUpperCase()} COLLECTOR DISABLED`,
      collector.disabledReason ?? 'source unavailable',
      'rhizomorph doctor',
    )
  }

  return gaps
}
