import type { MouseEvent, ReactElement, ReactNode } from 'react'
import {
  formatSpan,
  INFERRED_MARK,
  PATHOLOGY_KINDS,
  RANK_GLOW_CLASS,
  RANK_TEXT_CLASS,
  Sigil,
  SIGIL_ROW_SIZE,
  type AttentionItem,
  type AttentionKind,
  type CalmEvidence,
  type Fleet,
  type LadderRank,
  type PathologyKind,
} from '../../fleet/index.js'
import { useReducedMotion } from './useReducedMotion.js'

/**
 * THE ATTENTION STRIP's presentation (ruling 5) — a pure read of the one
 * derived fleet object, so the whole thing is testable without a stream, a
 * provider chain, or a clock: hand it a `Fleet` and a selection, get back
 * exactly what an operator would see.
 */

/**
 * C's triage rule: past four named chips, the strip counts instead of
 * naming. Ten-plus lanes needing attention must never grow the strip taller
 * than its docked height (ruling 7's density law reaches the top bar too).
 */
export const MAX_CHIPS = 4

const NON_PATHOLOGY_GLYPH: Record<'collision' | 'collector', string> = {
  collision: '⇄',
  collector: '⚑',
}

export interface AttentionStripViewProps {
  fleet: Fleet
  selectedId: string | null
  onToggle: (laneId: string) => void
}

export function AttentionStripView({
  fleet,
  selectedId,
  onToggle,
}: AttentionStripViewProps): ReactElement {
  const reducedMotion = useReducedMotion()
  const { ladder } = fleet

  return (
    <div
      role="status"
      data-panel="attention"
      className="flex h-9 min-w-0 items-center gap-3 px-4 text-xs"
    >
      {ladder.rank === 'calm' ? (
        <CalmRow evidence={ladder.evidence} />
      ) : (
        <AttentionRow
          items={ladder.items}
          rank={fleet.rank}
          selectedId={selectedId}
          onToggle={onToggle}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  )
}

/**
 * Ruling 14: never bare reassurance. The four evidence numbers come straight
 * off the model's `CalmEvidence` — the view assembles the sentence, but every
 * figure in it is something the ladder floor already guarantees was checked.
 */
function CalmRow({ evidence }: { evidence: CalmEvidence }): ReactElement {
  return (
    <>
      <Pill rank="calm">ALL CLEAR</Pill>
      <p className="truncate text-ice-400">
        <span className="figures text-ice-200">{evidence.lanes}</span> lanes ·{' '}
        <span className="figures text-ice-200">{evidence.branchesChecked}</span> branches ·{' '}
        <span className="figures text-ice-200">{evidence.filesChecked}</span> files checked ·
        collisions <span className="figures text-ice-200">{evidence.collisions}</span>
      </p>
    </>
  )
}

interface AttentionRowProps {
  items: readonly AttentionItem[]
  rank: LadderRank
  selectedId: string | null
  onToggle: (laneId: string) => void
  reducedMotion: boolean
}

/** Worst rung first is already the ladder's own order — the view renders what it says. */
function AttentionRow({
  items,
  rank,
  selectedId,
  onToggle,
  reducedMotion,
}: AttentionRowProps): ReactElement {
  const shown = items.slice(0, MAX_CHIPS)
  const overflow = items.length - shown.length

  return (
    <>
      <Pill rank={rank}>
        <span className="figures">{items.length}</span> NEED ATTENTION
      </Pill>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {shown.map((item) => (
          <Chip
            key={item.id}
            item={item}
            selected={item.laneId !== null && item.laneId === selectedId}
            onToggle={onToggle}
            reducedMotion={reducedMotion}
          />
        ))}
        {overflow > 0 ? (
          <span className="figures shrink-0 text-ice-500" data-testid="chip-overflow">
            +{overflow}
          </span>
        ) : null}
      </div>
    </>
  )
}

function Pill({ rank, children }: { rank: LadderRank; children: ReactNode }): ReactElement {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-medium uppercase tracking-[0.2em] ${RANK_TEXT_CLASS[rank]} ${RANK_GLOW_CLASS[rank]}`}
    >
      {children}
    </span>
  )
}

interface ChipProps {
  item: AttentionItem
  selected: boolean
  onToggle: (laneId: string) => void
  reducedMotion: boolean
}

/**
 * lane + WHY + how long (ruling 5). WHY is always the detector's own evidence
 * string, inference mark and all (graft g4) — never a bare pathology label.
 */
function Chip({ item, selected, onToggle, reducedMotion }: ChipProps): ReactElement {
  const clickable = item.laneId !== null
  const evidence = item.inferred ? `${INFERRED_MARK} ${item.evidence}` : item.evidence
  const age = item.forMs === null ? null : formatSpan(item.forMs)

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (item.laneId !== null) onToggle(item.laneId)
  }

  return (
    <button
      type="button"
      data-chip-id={item.id}
      data-chip-kind={item.kind}
      disabled={!clickable}
      title={evidence}
      aria-pressed={selected}
      onClick={clickable ? handleClick : undefined}
      className={[
        'flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 normal-case tracking-normal',
        RANK_TEXT_CLASS[item.rank],
        selected ? 'border-ice-200 bg-ice-900' : 'border-ice-800 bg-ice-950',
        clickable ? '' : 'cursor-default opacity-90',
        reducedMotion ? '' : 'attention-chip-flare',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ChipGlyph kind={item.kind} />
      <span className="max-w-[9rem] truncate font-medium">{item.label}</span>
      <span className="max-w-[18rem] truncate text-ice-300">{evidence}</span>
      {age === null ? null : <span className="figures shrink-0 text-ice-500">{age}</span>}
    </button>
  )
}

/** Form is kind (graft g4): the five pathologies get the scene's own glyph alphabet. */
function ChipGlyph({ kind }: { kind: AttentionKind }): ReactElement {
  if (isPathologyKind(kind)) return <Sigil kind={kind} size={SIGIL_ROW_SIZE} />
  return (
    <span aria-hidden className="text-[13px] leading-none">
      {NON_PATHOLOGY_GLYPH[kind]}
    </span>
  )
}

function isPathologyKind(kind: AttentionKind): kind is PathologyKind {
  return (PATHOLOGY_KINDS as readonly string[]).includes(kind)
}
