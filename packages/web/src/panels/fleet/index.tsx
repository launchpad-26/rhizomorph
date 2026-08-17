import { useEffect, useState, type MouseEvent } from 'react'
import { isTypingTarget } from '../../app/keyboard.js'
import { requestPanelFocus } from '../../app/panelPrefs.js'
import { laneUrl, navigate } from '../../app/router.js'
import { useStream } from '../../app/StreamContext.js'
import { copyToClipboard, type CopyText } from '../../drawer/AttachButton.js'
import { attachPlan } from '../../drawer/attach.js'
import {
  RANK_GLOW_CLASS,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  Sigil,
  formatSpan,
  stateTextClass,
  useFleet,
  useSelection,
  type Fleet,
  type Lane,
} from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import { Sparkline } from '../../spark/index.js'
import {
  ageActiveCellText,
  ageActiveCellTitle,
  branchingFilaments,
  costCellText,
  costCellTitle,
  fenceCell,
  gitStatusIncidentTitle,
  outputCellText,
  outputCellTitle,
  PARKED_TEXT_CLASS,
  showsGitStatusIncidentMark,
  showsTerminalDoneMark,
  stateSigilKind,
  stateTitle,
  terminalDoneTitle,
  threadShort,
  threadsCellTitle,
} from './format.js'

/**
 * THE FLEET TABLE (ruling 7, issue #78) — dense rows, calm chrome, ten-plus
 * lanes without scrolling. Replaces the worktrees panel.
 *
 * Rows arrive pre-sorted by the derived fleet object (attention first, then
 * output — `buildFleet`'s `byAttentionThenSize`), so this component never
 * re-sorts; four surfaces re-deriving "who is worst" is exactly what the one
 * fleet object exists to prevent.
 *
 * The STATE column draws the scene's own {@link Sigil} at row scale (graft
 * g1) beside the pathology or activity word — the alphabet is taught here and
 * read, legend-free, in the scene. Since prd4 ruling 3 that goes for the colour
 * too: {@link stateTextClass} inks each row in the same six hues the scene
 * paints with, so the table is the legend for the *palette* and not only for the
 * glyphs. A reader learns "green means getting on with it" next to the word, and
 * then reads the picture above without one.
 *
 * ## THE LIST'S OWN PASS (prd-36 ruling 1 and S1, wave 2 · #562)
 *
 * **The list is the floor.** prd-36 ruling 1 says it in that direction because
 * it inverts the usual instinct: this table is complete at every scene quality
 * level, in still mode, on a machine that cannot hold a frame budget, and when
 * the canvas does not come up at all. The organism is the enhancement. Three
 * things changed here to make that true rather than claimed:
 *
 * 1. **The frame is the surface's, not this file's.** Until #562 this component
 *    brought its own `<h2>Fleet</h2>`, its own bordered `<section>` and its own
 *    `usePanelFocus` full-view — all three of which `FleetSurface` and its
 *    `PanelFrame` already draw around it, so the list representation rendered
 *    the heading twice and the border twice, and `f` opened a `fixed inset-0`
 *    table *inside* a frame that did not know it was focused. The verbs are
 *    unchanged; `f` now asks the frame ({@link requestPanelFocus}) rather than
 *    growing a second full-view mechanism beside it.
 * 2. **Every lane renders.** There is no virtualisation here and there must not
 *    be one: S1's acceptance is that at forty lanes the list renders every lane
 *    and no lane is dropped out of the accessibility tree. The scroll container
 *    is a real scroll container over real rows, which is the whole reason a
 *    canvas failure is survivable.
 * 3. **The empty and idle states are separate facts** ({@link FleetEmpty}).
 *    "Nothing has connected" and "this repo has no lanes running right now" read
 *    identically as a blank table and are completely different answers.
 *
 * prd5 ruling 1+6 adds two k9s-style single-key verbs, TABLE-SCOPED (see
 * `app/keyboard.ts`'s comment for the split with the page-global idle-worker
 * jump and #100's scene-scoped camera keys): with a lane row focused —
 * either the DOM's own tab focus on a row, or the shared selection — `f`
 * focuses the fleet surface's frame and `a` copies the ATTACH command
 * for that lane, over the exact same clipboard path the drawer's
 * `AttachButton` uses (`attachPlan` + `copyToClipboard`, not a second copy of
 * either). Esc's existing precedence (drawer/selection first, focus only
 * once nothing is selected) is `usePanelFocus`'s own, untouched here.
 */
export interface FleetTableProps {
  /** Test seam for the clipboard — same shape the drawer's AttachButton uses. */
  onCopy?: CopyText
}

/** The panel id whose `PanelFrame` the `f` verb asks to focus — `PanelGrid`'s own row for this surface. */
const FLEET_PANEL_ID = 'fleet'

export default function FleetTable({ onCopy = copyToClipboard }: FleetTableProps = {}) {
  const { state, status } = useStream()
  const fleet = useFleet()
  const { selectedId, toggle } = useSelection()
  const connected = status === 'open' && state.events.length > 0
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (copyStatus === 'idle') return
    const timer = window.setTimeout(() => setCopyStatus('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [copyStatus])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'f' && key !== 'a') return

      const laneId = focusedLaneId(selectedId)
      if (laneId === null) return

      if (key === 'f') {
        event.preventDefault()
        requestPanelFocus(FLEET_PANEL_ID)
        return
      }

      const lane = fleet.lanes.find((l) => l.id === laneId)
      if (lane === undefined) return
      const plan = attachPlan(state.events, lane)
      if (plan.command === null) return
      event.preventDefault()
      void onCopy(plan.command).then(
        () => setCopyStatus('copied'),
        () => setCopyStatus('failed'),
      )
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId, fleet, state.events, onCopy])

  return (
    <section className="flex h-full min-h-0 flex-col px-4 pb-3" data-panel="fleet">
      {fleet.lanes.length === 0 ? (
        <FleetEmpty connected={connected} fleet={fleet} lastEventTs={lastEventTs(state.events)} />
      ) : (
        <div
          data-testid="fleet-rows"
          className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
        >
          <table className="w-full border-collapse text-left text-inst">
            <colgroup>
              <col style={{ width: 'auto' }} />
              <col style={{ width: '128px' }} />
              <col style={{ width: '96px' }} />
              <col style={{ width: '56px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '100px' }} />
              <col style={{ width: '96px' }} />
              <col style={{ width: '56px' }} />
            </colgroup>
            {/*
              The header stays put while the rows scroll under it. At forty
              lanes the column a figure belongs to is otherwise a scroll
              position away, which is the same failure as not rendering the
              lane: the row is in the tree and unreadable.
            */}
            <thead className="sticky top-0 z-10 bg-(--surface-panel)">
              <tr className="heading text-(--ink-dim)">
                <th className="pb-1.5 pr-2 font-medium">lane</th>
                <th className="pb-1.5 pr-2 font-medium">state</th>
                <th className="pb-1.5 pr-2 text-right font-medium">output</th>
                <th className="pb-1.5 pr-2 text-right font-medium">$</th>
                <th className="pb-1.5 pr-2 text-right font-medium">req</th>
                <th className="pb-1.5 pr-2 text-right font-medium">tool</th>
                <th className="pb-1.5 pr-2 font-medium">threads/sub</th>
                <th className="pb-1.5 pr-2 text-right font-medium">age / active</th>
                <th className="pb-1.5 text-right font-medium">fence</th>
              </tr>
            </thead>
            <tbody>
              {fleet.lanes.map((lane) => (
                <Row
                  key={lane.id}
                  lane={lane}
                  fleet={fleet}
                  selected={selectedId === lane.id}
                  onToggle={() => toggle(lane.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer
        data-testid="fleet-key-hint"
        className="mt-2 flex shrink-0 items-center gap-2 border-t border-(--line-hair) pt-1 font-mono text-inst-dense text-(--ink-dim)"
      >
        <span>n next needs-you · shift+n prev · f focus · a attach · esc close</span>
        {copyStatus === 'idle' ? null : (
          <span role="status" className={copyStatus === 'copied' ? 'text-notice' : 'text-(--ink-dim)'}>
            {copyStatus === 'copied' ? 'attach copied' : 'clipboard unavailable'}
          </span>
        )}
      </footer>
    </section>
  )
}

/** The newest event's timestamp, or null when the log is empty — "last activity" for the idle line. */
function lastEventTs(events: readonly { ts: number }[]): number | null {
  return events.length === 0 ? null : (events[events.length - 1]?.ts ?? null)
}

/**
 * THE EMPTY AND IDLE STATES (prd-36 S1, #562) — three different facts that all
 * used to render as a near-blank table.
 *
 * S1 names four no-lane readings and they are not interchangeable:
 *
 * - *loading* — the stream has not delivered anything yet. Nothing is known,
 *   and saying "no lanes" here would be a claim the instrument has not earned.
 * - *empty, repo watched* — the fold is real and holds no lanes. This is the
 *   one S1 asks to **name the repo and its last activity**: an operator reading
 *   "no lanes are running" needs to know *whose* fleet is empty and whether the
 *   silence is four seconds or four hours old, because those are opposite
 *   readings of the same sentence.
 * - *empty, nothing configured* — no repo was ever named. S1 rules that the
 *   demo fleet renders here (prd-34); prd-34 has not landed, so this states the
 *   gap in law 12's voice rather than inventing a fixture. `PanelGrid`'s own
 *   balcony pointer already stands beside this with the way to `/connect`.
 *
 * None of the three reads as broken, which is the criterion S1 actually sets.
 */
export function FleetEmpty({
  connected,
  fleet,
  lastEventTs: lastTs,
}: {
  connected: boolean
  fleet: Pick<Fleet, 'root' | 'now'>
  lastEventTs: number | null
}) {
  const repo = fleet.root.repoName

  if (!connected) {
    return (
      <p data-testid="fleet-loading" className="mt-2 text-read-floor text-(--ink-dim)">
        Waiting for the stream…
      </p>
    )
  }

  if (repo === null) {
    return (
      <p
        role="status"
        data-testid="fleet-unconfigured"
        className="mt-2 max-w-prose text-read-floor leading-snug text-(--ink-dim)"
      >
        NOTHING CONFIGURED — no repository has been named, so there is no fleet to list and nothing
        is wrong with the instrument. A simulated fleet belongs here (prd-34's doorstep) and does not
        exist yet; until it does, Connect is the way to point this at a repo.
      </p>
    )
  }

  const since = lastTs === null ? null : formatSpan(Math.max(0, fleet.now - lastTs))

  return (
    <p
      role="status"
      data-testid="fleet-idle"
      className="mt-2 max-w-prose text-read-floor leading-snug text-(--ink-dim)"
    >
      NO LANES RUNNING in <span className="font-mono text-(--ink-body)">{repo}</span> —{' '}
      {since === null
        ? 'and nothing has been recorded in this session yet.'
        : `last activity ${since} ago.`}{' '}
      This is an idle fleet, not a broken one.
    </p>
  )
}

/**
 * "A lane row focused" (prd5 ruling 1+6) reads either way the direction
 * names: the DOM's own tab focus landing on a row, or the shared selection —
 * whichever names a lane, `f`/`a` act on it.
 */
function focusedLaneId(selectedId: string | null): string | null {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.dataset.testid === 'fleet-row' && active.dataset.lane) {
    return active.dataset.lane
  }
  return selectedId
}

interface RowProps {
  lane: Lane
  fleet: Fleet
  selected: boolean
  onToggle: () => void
}

function Row({ lane, fleet, selected, onToggle }: RowProps) {
  const sigilKind = stateSigilKind(lane)
  const stateClass = lane.parked ? PARKED_TEXT_CLASS : stateTextClass(lane.rank, lane.activity)
  const fence = fenceCell(lane, fleet)
  const branching = branchingFilaments(lane)

  return (
    <tr
      data-testid="fleet-row"
      data-lane={lane.id}
      aria-selected={selected}
      tabIndex={0}
      role="button"
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      // No blanket fade on a quiet row any more. It was how an idle or landed
      // lane used to be told from a busy one back when every calm row was the
      // same ice, and it worked by dimming the lane's *name*, its cost and its
      // age along with its state — facts that are exactly as true and exactly as
      // worth reading whatever the lane is doing. Ruling 3 gives idle and done
      // their own dimness, in the one cell that is about how the lane is
      // (`stateTextClass`: dim green for landed, ice for idle), so the row
      // itself can stay legible. That is the "too dark" complaint's other half.
      className={`focus-ring cursor-pointer border-t border-l-2 border-t-(--line-hair) hover:bg-(--surface-raised) ${
        selected ? 'border-l-(--ink-primary) bg-(--surface-raised)' : 'border-l-transparent'
      }`}
    >
      <td className="py-1.5 pr-2 font-mono text-(--ink-body)" title={lane.worktreePath ?? lane.id}>
        {lane.label}
        {lane.issue === null ? null : (
          <span className="ml-1 text-inst-dense text-(--ink-dim)">#{lane.issue}</span>
        )}
        <OpenLaneLink handle={lane.id} label={lane.label} />
      </td>
      <td className="py-1.5 pr-2" title={stateTitle(lane, fleet.now)}>
        <span className={`inline-flex items-center gap-1 ${stateClass}`}>
          {lane.parked ? null : (
            <Sigil
              kind={sigilKind}
              size={SIGIL_ROW_SIZE}
              className={lane.rank === 'calm' ? '' : RANK_GLOW_CLASS[lane.rank]}
            />
          )}
          <span className="figures uppercase tracking-wide">{lane.parked ? 'PARKED' : SIGIL_WORD[sigilKind]}</span>
        </span>
        {!lane.parked && lane.pathologies.some((p) => p.inferred) ? (
          <span className="ml-1 text-(--ink-dim)" title="inferred from a weaker signal">
            ~
          </span>
        ) : null}
        {!lane.parked && lane.pathologies.length > 1 ? (
          <span className="figures ml-1 text-inst-dense text-(--ink-dim)">+{lane.pathologies.length - 1}</span>
        ) : null}
        {showsTerminalDoneMark(lane) ? (
          // Lowercase, matching SIGIL_WORD's own register (pathologies shout,
          // calm/finished states don't) — a finish must not read as loud as
          // the alarm sitting right beside it. `data-testid` because its own
          // text ("done") is otherwise indistinguishable from the sigil
          // word's — the mark only appears beside an alarm; a plain DONE
          // lane already says so via the sigil word alone.
          <span className="ml-1 text-inst-dense text-done" title={terminalDoneTitle()} data-testid="terminal-done-mark">
            done
          </span>
        ) : null}
        {showsGitStatusIncidentMark(lane) ? (
          <span
            role="status"
            aria-label={`${lane.label}: git status failing`}
            title={gitStatusIncidentTitle(lane)}
            className="ml-1 text-inst-dense text-needs-you"
          >
            ⚠ git
          </span>
        ) : null}
      </td>
      <td className="figures py-1.5 pr-2 text-right text-(--ink-body)" title={outputCellTitle(lane)}>
        <span className="inline-flex items-center justify-end gap-1.5">
          <Sparkline values={lane.recentOutputTokens} width={36} height={12} className="shrink-0 text-(--ink-dim)" />
          {outputCellText(lane)}
        </span>
      </td>
      <td
        className={`figures py-1.5 pr-2 text-right ${lane.costEventCount === 0 ? 'text-(--ink-dim)' : 'text-(--ink-body)'}`}
        title={costCellTitle(lane, fleet.gaps)}
      >
        {costCellText(lane)}
        {lane.costIsAuthoritative === false ? (
          <span className="ml-1 text-inst-dense font-normal text-(--ink-dim)">est.</span>
        ) : null}
      </td>
      <td className={`figures py-1.5 pr-2 text-right ${lane.requestCount === 0 ? 'text-(--ink-dim)' : 'text-(--ink-body)'}`}>
        {lane.requestCount}
      </td>
      <td className={`figures py-1.5 pr-2 text-right ${lane.toolCallCount === 0 ? 'text-(--ink-dim)' : 'text-(--ink-body)'}`}>
        {lane.toolCallCount}
      </td>
      <td className="py-1.5 pr-2 text-(--ink-dim)" title={threadsCellTitle(lane)}>
        {lane.filaments.length === 0 ? (
          <span className="text-(--ink-dim)">—</span>
        ) : branching.length === 0 ? (
          <span className="text-(--ink-dim)">main only</span>
        ) : (
          branching.map((filament, i) => (
            <span key={`${filament.thread ?? 'unk'}-${i}`} className="mr-1.5 inline-flex items-baseline gap-0.5">
              <span className="uppercase text-(--ink-dim)">{threadShort(filament.thread)}</span>
              <span className="figures text-(--ink-body)">{formatTokens(filament.outputTokens)}</span>
            </span>
          ))
        )}
      </td>
      <td className="figures py-1.5 pr-2 text-right text-(--ink-dim)" title={ageActiveCellTitle(lane)}>
        {ageActiveCellText(lane)}
      </td>
      <td
        className={`figures py-1.5 text-right ${
          fence.kind === 'breach' ? 'text-needs-you' : fence.kind === 'clean' ? 'text-(--ink-body)' : 'text-(--ink-dim)'
        }`}
        title={fence.title}
      >
        {fence.text}
      </td>
    </tr>
  )
}

/**
 * THE ROW DRILL-DOWN (issue #159, Grafana's data-link pattern) — a lane row
 * already selects on click (opens the peek); this is the *other* way out,
 * an explicit affordance beside the name that goes straight to `/lane/:handle`
 * (#135) instead. It must not hijack the row's own click, so it stops the
 * click (and the Enter/Space keydown the row's own handler listens for) from
 * ever reaching the `<tr>` — the same modifier-aware, real-`<a href>`
 * convention the peek's own `OpenRunViewLink` uses, so ctrl/cmd/shift/middle
 * click still open a new tab.
 */
function OpenLaneLink({ handle, label }: { handle: string; label: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation()
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(laneUrl(handle))
  }

  return (
    <a
      href={laneUrl(handle)}
      onClick={onClick}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="fleet-row-open"
      aria-label={`Open ${label}'s page`}
      className="focus-ring ml-1 rounded text-(--ink-dim) hover:text-(--ink-primary)"
    >
      ↗
    </a>
  )
}
