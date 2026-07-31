import { useStream } from '../../app/StreamContext.js'
import {
  RANK_GLOW_CLASS,
  RANK_TEXT_CLASS,
  SIGIL_ROW_SIZE,
  SIGIL_WORD,
  Sigil,
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
 * read, legend-free, in the scene. Colour is applied by the ladder rank alone
 * (law 9 / graft g4): a calm row's mark is still the ice ramp's bright end,
 * never a fifth hue.
 */
export default function FleetTable() {
  const { state, status } = useStream()
  const fleet = useFleet()
  const { selectedId, toggle } = useSelection()
  const connected = status === 'open' && state.events.length > 0

  return (
    <section className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4" data-panel="fleet">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Fleet</h2>

      {fleet.lanes.length === 0 && !connected ? (
        <p className="mt-2 text-sm text-ice-500">Waiting for the stream…</p>
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
              <tr className="text-[10px] uppercase tracking-wider text-ice-500">
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
    </section>
  )
}

interface RowProps {
  lane: Lane
  fleet: Fleet
  selected: boolean
  onToggle: () => void
}

function Row({ lane, fleet, selected, onToggle }: RowProps) {
  const sigilKind = stateSigilKind(lane)
  const rankClass = RANK_TEXT_CLASS[lane.rank]
  // Alarm marks are exempt from every fade (graft g2): the dimming below only
  // ever applies to a calm-ranked row, so a needs-you/broken sigil never dims
  // no matter how quiet or finished the lane otherwise looks.
  const faded = lane.rank === 'calm' && (lane.activity === 'idle' || lane.activity === 'done')
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
      className={`cursor-pointer border-t border-l-2 border-t-ice-850/60 hover:bg-ice-900 ${
        selected ? 'border-l-ice-100 bg-ice-900' : 'border-l-transparent'
      } ${faded ? 'opacity-60' : ''}`}
    >
      <td className="py-1 pr-2 font-mono text-ice-200" title={lane.worktreePath ?? lane.id}>
        {lane.label}
        {lane.issue === null ? null : <span className="ml-1 text-[10px] text-ice-500">#{lane.issue}</span>}
      </td>
      <td className="py-1 pr-2" title={stateTitle(lane)}>
        <span className={`inline-flex items-center gap-1 ${rankClass}`}>
          <Sigil
            kind={sigilKind}
            size={SIGIL_ROW_SIZE}
            className={lane.rank === 'calm' ? '' : RANK_GLOW_CLASS[lane.rank]}
          />
          <span className="figures uppercase tracking-wide">{SIGIL_WORD[sigilKind]}</span>
        </span>
        {lane.pathologies.some((p) => p.inferred) ? (
          <span className="ml-1 text-ice-500" title="inferred from a weaker signal">
            ~
          </span>
        ) : null}
        {lane.pathologies.length > 1 ? (
          <span className="figures ml-1 text-[10px] text-ice-500">+{lane.pathologies.length - 1}</span>
        ) : null}
      </td>
      <td className="figures py-1 pr-2 text-right text-ice-200" title={outputCellTitle(lane)}>
        {outputCellText(lane)}
      </td>
      <td
        className={`figures py-1 pr-2 text-right ${lane.costEventCount === 0 ? 'text-ice-600' : 'text-ice-200'}`}
        title={costCellTitle(lane, fleet.gaps)}
      >
        {costCellText(lane)}
        {lane.costIsAuthoritative === false ? (
          <span className="ml-1 text-[10px] font-normal text-ice-500">est.</span>
        ) : null}
      </td>
      <td className={`figures py-1 pr-2 text-right ${lane.requestCount === 0 ? 'text-ice-600' : 'text-ice-200'}`}>
        {lane.requestCount}
      </td>
      <td className={`figures py-1 pr-2 text-right ${lane.toolCallCount === 0 ? 'text-ice-600' : 'text-ice-200'}`}>
        {lane.toolCallCount}
      </td>
      <td className="py-1 pr-2 text-ice-400" title={threadsCellTitle(lane)}>
        {lane.filaments.length === 0 ? (
          <span className="text-ice-600">—</span>
        ) : branching.length === 0 ? (
          <span className="text-ice-600">main only</span>
        ) : (
          branching.map((filament, i) => (
            <span key={`${filament.thread ?? 'unk'}-${i}`} className="mr-1.5 inline-flex items-baseline gap-0.5">
              <span className="uppercase text-ice-500">{threadShort(filament.thread)}</span>
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
          fence.kind === 'breach' ? 'text-needs-you' : fence.kind === 'clean' ? 'text-ice-300' : 'text-ice-600'
        }`}
        title={fence.title}
      >
        {fence.text}
      </td>
    </tr>
  )
}
