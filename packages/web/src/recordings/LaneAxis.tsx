import { laneUrl, navigate } from '../app/router.js'
import { formatDuration } from '../lib/format.js'
import type { LaneIndexPage, LaneIndexRow } from './laneIndex.js'
import {
  isLaneCostGap,
  laneCostSuffix,
  laneCostText,
  laneCostTitle,
  laneOutcome,
  laneSessionsText,
  laneSessionsTitle,
} from './laneFormat.js'

/**
 * THE LANE AXIS (prd-31 ruling 8 / S4, #558) — *what that piece of work did*.
 *
 * The session axis answers "what happened that night"; this answers "what did
 * `556-run-view` actually do", which is a question the recordings library could
 * not answer at all before ruling 5's index existed, because a lane that ran
 * across three sessions had its life in three files with nothing tying them
 * together.
 *
 * **Every row opens.** S4's first "what would make it wrong" is *a lane
 * appearing in the lane axis that cannot be opened*, so the handle is a real
 * `<a href="/lane/:handle">` — the run view resolves a handle out of the same
 * index this page read it from, so a row here always has somewhere to go, and
 * it goes there whether or not the worktree still exists.
 *
 * **Cost carries its provenance** in both axes, from `laneFormat.ts`'s
 * formatters, which mirror the session axis's word for word.
 */
export interface LaneAxisProps {
  page: LaneIndexPage
  /** Rendered when the index is empty, so both axes say the same thing about a fresh repo. */
  emptyLine: string
}

export function LaneAxis({ page, emptyLine }: LaneAxisProps) {
  if (page.lanes.length === 0) {
    return (
      <p data-testid="history-lanes-empty" className="text-(--ink-dim)">
        {emptyLine}
      </p>
    )
  }

  return (
    <table data-testid="history-lane-table" className="w-full border-collapse text-left text-read-floor">
      <thead>
        <tr className="border-b border-(--line-hair) text-(--ink-dim)">
          <th className="p-2 font-normal">lane</th>
          <th className="p-2 font-normal">issue</th>
          <th className="p-2 font-normal">when</th>
          <th className="p-2 font-normal">outcome</th>
          <th className="p-2 font-normal">spend</th>
          <th className="p-2 font-normal">sessions</th>
        </tr>
      </thead>
      <tbody>
        {page.lanes.map((lane) => (
          <LaneRow key={lane.handle} lane={lane} />
        ))}
      </tbody>
    </table>
  )
}

function LaneRow({ lane }: { lane: LaneIndexRow }) {
  const outcome = laneOutcome(lane)
  const href = laneUrl(lane.handle)

  return (
    <tr data-testid={`history-lane-row-${lane.handle}`} className="border-b border-(--line-hair) align-top">
      <td className="max-w-[16rem] p-2">
        {/*
          A real `<a href>`, modifier-aware, routed in place on a plain click —
          the same convention the fleet row's drill-down and the peek's action
          use, so every path into a run view behaves identically in a hand that
          has learned one of them.
        */}
        <a
          href={href}
          data-testid={`history-lane-open-${lane.handle}`}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0) return
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            navigate(href)
          }}
          className="focus-ring rounded font-mono text-(--ink-body) underline hover:text-(--ink-primary)"
        >
          {lane.handle}
        </a>
      </td>
      <td className="figures p-2 text-(--ink-dim)">{lane.issue === null ? '—' : `#${lane.issue}`}</td>
      <td className="figures p-2 text-(--ink-dim)" title={whenTitle(lane)}>
        {whenText(lane)}
      </td>
      <td
        className={`p-2 ${outcome.inferred ? 'text-(--ink-dim)' : 'text-(--ink-body)'}`}
        title={outcome.title}
        data-inferred={outcome.inferred}
      >
        {outcome.word}
      </td>
      <td className="figures p-2" title={laneCostTitle(lane)}>
        {laneCostText(lane)}
        {laneCostSuffix(lane) !== null && <span className="ml-1 text-(--ink-dim)">{laneCostSuffix(lane)}</span>}
        {isLaneCostGap(lane) && (
          <span data-testid={`history-lane-cost-gap-${lane.handle}`} className="ml-1 text-(--ink-dim)">
            (no cost feed)
          </span>
        )}
      </td>
      <td className="figures p-2 text-(--ink-dim)" title={laneSessionsTitle(lane)}>
        {laneSessionsText(lane)}
      </td>
    </tr>
  )
}

/**
 * WHEN, as a span rather than a wall-clock stamp: the question the lane axis
 * answers is "what did this work do", and how long it took is part of that in a
 * way that "it started at 02:14" is not. An unknown span says so rather than
 * rendering `0s`, which would read as a lane that did nothing in no time.
 */
function whenText(lane: Pick<LaneIndexRow, 'firstSeenAt' | 'lastSeenAt'>): string {
  if (lane.firstSeenAt === null || lane.lastSeenAt === null) return '—'
  return formatDuration(Math.max(0, lane.lastSeenAt - lane.firstSeenAt))
}

function whenTitle(lane: Pick<LaneIndexRow, 'firstSeenAt' | 'lastSeenAt'>): string {
  if (lane.firstSeenAt === null || lane.lastSeenAt === null) {
    return 'no event in any recording carried a timestamp for this lane'
  }
  return `${new Date(lane.firstSeenAt).toISOString()} → ${new Date(lane.lastSeenAt).toISOString()}`
}
