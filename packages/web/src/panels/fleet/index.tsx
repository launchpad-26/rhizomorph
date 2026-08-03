import { useEffect, useState } from 'react'
import { isTypingTarget } from '../../app/keyboard.js'
import { usePanelFocus } from '../../app/panelPrefs.js'
import { useStream } from '../../app/StreamContext.js'
import { copyToClipboard, type CopyText } from '../../drawer/AttachButton.js'
import { attachPlan } from '../../drawer/attach.js'
import {
  RANK_GLOW_CLASS,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  Sigil,
  stateTextClass,
  useFleet,
  useSelection,
  type Fleet,
  type Lane,
} from '../../fleet/index.js'
import { formatTokens } from '../../lib/format.js'
import {
  ageCellText,
  ageCellTitle,
  branchingFilaments,
  costCellText,
  costCellTitle,
  fenceCell,
  outputCellText,
  outputCellTitle,
  PARKED_TEXT_CLASS,
  stateSigilKind,
  stateTitle,
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
 * prd5 ruling 1+6 adds two k9s-style single-key verbs, TABLE-SCOPED (see
 * `app/keyboard.ts`'s comment for the split with the page-global idle-worker
 * jump and #100's scene-scoped camera keys): with a lane row focused —
 * either the DOM's own tab focus on a row, or the shared selection — `f`
 * toggles this panel's own full-view focus and `a` copies the ATTACH command
 * for that lane, over the exact same clipboard path the drawer's
 * `AttachButton` uses (`attachPlan` + `copyToClipboard`, not a second copy of
 * either). Esc's existing precedence (drawer/selection first, focus only
 * once nothing is selected) is `usePanelFocus`'s own, untouched here.
 */
export interface FleetTableProps {
  /** Test seam for the clipboard — same shape the drawer's AttachButton uses. */
  onCopy?: CopyText
}

export default function FleetTable({ onCopy = copyToClipboard }: FleetTableProps = {}) {
  const { state, status } = useStream()
  const fleet = useFleet()
  const { selectedId, toggle } = useSelection()
  const connected = status === 'open' && state.events.length > 0
  const { focused, focus, restore } = usePanelFocus()
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
        if (focused) restore()
        else focus()
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
  }, [selectedId, focused, focus, restore, fleet, state.events, onCopy])

  return (
    <section
      className={
        focused
          ? 'fixed inset-0 z-30 flex flex-col overflow-auto bg-ice-1000 p-4'
          : 'flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4'
      }
      data-panel="fleet"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Fleet</h2>

      {fleet.lanes.length === 0 && !connected ? (
        <p className="mt-2 text-sm text-ice-400">Waiting for the stream…</p>
      ) : fleet.lanes.length === 0 ? (
        <p className="mt-2 text-sm text-ice-300" role="status">
          No lanes discovered yet.
        </p>
      ) : (
        <div className="mt-2 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <colgroup>
              <col style={{ width: 'auto' }} />
              <col style={{ width: '128px' }} />
              <col style={{ width: '56px' }} />
              <col style={{ width: '56px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '100px' }} />
              <col style={{ width: '56px' }} />
              <col style={{ width: '56px' }} />
            </colgroup>
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ice-400">
                <th className="pb-1 pr-2 font-medium">lane</th>
                <th className="pb-1 pr-2 font-medium">state</th>
                <th className="pb-1 pr-2 text-right font-medium">output</th>
                <th className="pb-1 pr-2 text-right font-medium">$</th>
                <th className="pb-1 pr-2 text-right font-medium">req</th>
                <th className="pb-1 pr-2 text-right font-medium">tool</th>
                <th className="pb-1 pr-2 font-medium">threads/sub</th>
                <th className="pb-1 pr-2 text-right font-medium">age</th>
                <th className="pb-1 text-right font-medium">fence</th>
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
        className="mt-2 flex shrink-0 items-center gap-2 border-t border-ice-850 pt-1 font-mono text-[10px] text-ice-400"
      >
        <span>n next needs-you · shift+n prev · f focus · a attach · esc close</span>
        {copyStatus === 'idle' ? null : (
          <span role="status" className={copyStatus === 'copied' ? 'text-notice' : 'text-ice-400'}>
            {copyStatus === 'copied' ? 'attach copied' : 'clipboard unavailable'}
          </span>
        )}
      </footer>
    </section>
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
      className={`cursor-pointer border-t border-l-2 border-t-ice-850/60 hover:bg-ice-900 ${
        selected ? 'border-l-ice-100 bg-ice-900' : 'border-l-transparent'
      }`}
    >
      <td className="py-1 pr-2 font-mono text-ice-200" title={lane.worktreePath ?? lane.id}>
        {lane.label}
        {lane.issue === null ? null : <span className="ml-1 text-[10px] text-ice-400">#{lane.issue}</span>}
      </td>
      <td className="py-1 pr-2" title={stateTitle(lane)}>
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
          <span className="ml-1 text-ice-400" title="inferred from a weaker signal">
            ~
          </span>
        ) : null}
        {!lane.parked && lane.pathologies.length > 1 ? (
          <span className="figures ml-1 text-[10px] text-ice-400">+{lane.pathologies.length - 1}</span>
        ) : null}
      </td>
      <td className="figures py-1 pr-2 text-right text-ice-200" title={outputCellTitle(lane)}>
        {outputCellText(lane)}
      </td>
      <td
        className={`figures py-1 pr-2 text-right ${lane.costEventCount === 0 ? 'text-ice-400' : 'text-ice-200'}`}
        title={costCellTitle(lane, fleet.gaps)}
      >
        {costCellText(lane)}
        {lane.costIsAuthoritative === false ? (
          <span className="ml-1 text-[10px] font-normal text-ice-400">est.</span>
        ) : null}
      </td>
      <td className={`figures py-1 pr-2 text-right ${lane.requestCount === 0 ? 'text-ice-400' : 'text-ice-200'}`}>
        {lane.requestCount}
      </td>
      <td className={`figures py-1 pr-2 text-right ${lane.toolCallCount === 0 ? 'text-ice-400' : 'text-ice-200'}`}>
        {lane.toolCallCount}
      </td>
      <td className="py-1 pr-2 text-ice-400" title={threadsCellTitle(lane)}>
        {lane.filaments.length === 0 ? (
          <span className="text-ice-400">—</span>
        ) : branching.length === 0 ? (
          <span className="text-ice-400">main only</span>
        ) : (
          branching.map((filament, i) => (
            <span key={`${filament.thread ?? 'unk'}-${i}`} className="mr-1.5 inline-flex items-baseline gap-0.5">
              <span className="uppercase text-ice-400">{threadShort(filament.thread)}</span>
              <span className="figures text-ice-300">{formatTokens(filament.outputTokens)}</span>
            </span>
          ))
        )}
      </td>
      <td className="figures py-1 pr-2 text-right text-ice-400" title={ageCellTitle(lane)}>
        {ageCellText(lane)}
      </td>
      <td
        className={`figures py-1 text-right ${
          fence.kind === 'breach' ? 'text-needs-you' : fence.kind === 'clean' ? 'text-ice-300' : 'text-ice-400'
        }`}
        title={fence.title}
      >
        {fence.text}
      </td>
    </tr>
  )
}
