import { Disclosure, type DisclosureContent } from '../../disclosure/index.js'
import type { SpanDecision } from '@rhizomorph/core'
import { useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactElement, ReactNode, RefObject } from 'react'
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
import { DECISION_WORD } from '../../trace/index.js'
import { ageBand } from './ageBands.js'
import { useReducedMotion } from './useReducedMotion.js'
import { selectWaitedChips, type WaitedChip } from './waitedChips.js'

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

/** `gap-1.5` on the chip row = 0.375rem at the 16px root. */
const CHIP_GAP_PX = 6

/**
 * The widest a chip can be: the glyph, `max-w-[9rem]` label, `max-w-[18rem]`
 * evidence, the age, three `gap-1.5`s, `px-1.5` either side and a 1px border
 * each side — 144 + 288 + ~14 + ~40 + 18 + 12 + 2, rounded up.
 *
 * DERIVED from those two caps, not observed. The widest chip on fixture 3 is
 * 462px, and a constant tuned to the fixture would under-fold on a real lane
 * whose name or evidence runs longer. If either `max-w-` below changes, this
 * changes with it — `chipCapacity`'s tests pin the arithmetic so the three
 * cannot drift apart silently. Rationale in
 * `docs/design-notes/attention-chip-width.md`.
 */
const CHIP_MAX_WIDTH_PX = 520

/**
 * How many chips the row can NAME at this width.
 *
 * Pure on purpose: jsdom reports every width as 0 and can never exercise the
 * real thing, so the arithmetic is tested directly and the wiring is proved by
 * a browser pass — the same split `shell-bounds-law.test.ts` sets out at
 * length, and for the same reason.
 *
 * Conservative by construction: it assumes every chip is `CHIP_MAX_WIDTH_PX`
 * wide, so it can fold a chip that would in fact have fitted. That direction is
 * the safe one — over-folding names one fewer lane and COUNTS it in `+N`, while
 * under-folding puts a chip off screen and makes `+N` a lie. #464 was the
 * second failure: at 1440px the row had 563px for 1522px of chips, and the `+1`
 * marker that announces the hidden ones sat 941px past the right edge.
 *
 * `rowWidth <= 0` means "not knowable yet" — before the first measurement, and
 * under jsdom — not "no room". The answer there is today's behaviour.
 *
 * **The marker's width is NOT subtracted here, and that is the whole of what a
 * browser had to tell us.** The marker is a sibling of this row, not a child of
 * it, so the flex split has already taken the marker and its gap out before the
 * row is measured: at 1440x900 the wrapper is 563px and the measured row is
 * **544px**. An earlier version reserved the marker a second time inside this
 * function, which dropped the budget below one chip-width and named ZERO lanes
 * at the primary target viewport. Every unit test passed, because they fed this
 * function the wrapper width — a number that does not exist at runtime.
 *
 * So the measured row IS the budget. When no chip is folded the marker is
 * absent and the row is 19px wider, which can only ever let one more chip in;
 * erring the other way is the direction that hides a frozen lane.
 */
export function chipCapacity(rowWidth: number): number {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return MAX_CHIPS
  const fit = Math.floor((rowWidth + CHIP_GAP_PX) / (CHIP_MAX_WIDTH_PX + CHIP_GAP_PX))
  return Math.max(0, Math.min(MAX_CHIPS, fit))
}

/**
 * The chip row's own rendered width in whole pixels — `0` until it is knowable.
 * Same shape as `Scrubber`'s `useTrackWidth` and `TideDock`'s `useElementWidth`,
 * deliberately: measure once, then follow a `ResizeObserver` where the platform
 * has one.
 *
 * A layout effect rather than a plain one so the first painted frame is already
 * folded, instead of showing one frame of the unmeasured fallback. That last
 * sentence is NOT held by anything in this file's tests: swapping it for
 * `useEffect` leaves the suite green, because RTL flushes passive effects inside
 * `act()` and jsdom never paints. `Scrubber.tsx` records the same gap. It is a
 * limit of the harness, not permission.
 */
function useRowWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return

    const measure = () => setWidth(Math.max(0, Math.floor(el.getBoundingClientRect().width)))
    measure()

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [])

  return [ref, width]
}

const NON_PATHOLOGY_GLYPH: Record<'collision' | 'collector', string> = {
  collision: '⇄',
  collector: '⚑',
}

/** The word beside the two non-pathology glyphs — pathology kinds already carry
 * their own legend via `Sigil`/`SIGIL_WORD`; these two never did. */
const NON_PATHOLOGY_LABEL: Record<'collision' | 'collector', string> = {
  collision: 'Collide',
  collector: 'Flag',
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
      className="flex h-9 min-w-0 items-center gap-3 px-4 text-inst"
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
      <WaitedChipsRow lanes={fleet.lanes} selectedId={selectedId} onToggle={onToggle} />
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
      <p className="truncate text-(--ink-dim)">
        <span className="figures text-(--ink-body)">{evidence.lanes}</span> lanes ·{' '}
        <span className="figures text-(--ink-body)">{evidence.branchesChecked}</span> branches ·{' '}
        <span className="figures text-(--ink-body)">{evidence.filesChecked}</span> files checked ·
        collisions <span className="figures text-(--ink-body)">{evidence.collisions}</span>
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
  const [rowRef, rowWidth] = useRowWidth()
  const shown = items.slice(0, chipCapacity(rowWidth))
  const overflow = items.length - shown.length

  return (
    <>
      <Pill rank={rank}>
        <span className="figures">{items.length}</span> NEED ATTENTION
      </Pill>
      {/*
        The marker is a SIBLING of the clipping row, not its last child (#464).
        As a child it was the first thing an overflowing row pushed out — the one
        element whose entire job is to say that something is hidden. The inner
        row clips; the marker is `shrink-0` beside it and cannot be reached by
        the clip. `shell-bounds-law.test.ts` holds this structurally.
      */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {shown.map((item) => (
            <Chip
              key={item.id}
              item={item}
              selected={item.laneId !== null && item.laneId === selectedId}
              onToggle={onToggle}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
        {overflow > 0 ? (
          <span className="figures shrink-0 text-(--ink-dim)" data-testid="chip-overflow">
            +{overflow}
          </span>
        ) : null}
      </div>
    </>
  )
}

/**
 * THE STRIP'S RETROSPECTIVE CHIPS (#143, prd9 ruling 6 / prd10 ruling 9) — a
 * QUIET right-aligned region for what a lane SAT waiting, not what it is
 * doing now. This is memory, not a summons: it reads no rung, raises no
 * item, and its ink never leaves the ice ramp — no `RANK_TEXT_CLASS`, no
 * `RANK_GLOW_CLASS`, no cartouche, no arrival flare. Every text node still
 * clears the legibility floor (`ice-400` or brighter; prd9's operator
 * ruling), which is what "sub-ceiling" means for a DOM chip rather than a
 * canvas mark: dim enough to defer to an alarm, never so dim it fails
 * `9b`'s own floor test.
 */
function WaitedChipsRow({
  lanes,
  selectedId,
  onToggle,
}: {
  lanes: Fleet['lanes']
  selectedId: string | null
  onToggle: (laneId: string) => void
}): ReactElement | null {
  const chips = selectWaitedChips(lanes)
  if (chips.length === 0) return null

  return (
    <div
      data-testid="waited-chips"
      // `shrink-0` here is what put 533px of horizontal scroll on the DOCUMENT
      // (#655). This region is the strip's memory, not its summons — the doc
      // comment above says so — which makes it the one part that SHOULD give
      // way first when the header runs out of room. It was instead the one part
      // that could not, so the alarm row (correctly `min-w-0 flex-1`) yielded
      // its share, ran out, and the overflow left the page entirely.
      //
      // `min-w-0` is the load-bearing half: without it this flex item's
      // automatic minimum is its content width, and the `overflow-hidden`
      // already here never gets the chance to clip.
      className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden"
    >
      {chips.map((chip) => (
        <WaitedChipButton
          key={chip.laneId}
          chip={chip}
          selected={chip.laneId === selectedId}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

/** A fact already decided is never a ladder hue (same law `trace/glyphs.tsx`'s `DECISION_CLASS` follows). */
const DECISION_GLYPH: Record<SpanDecision, string> = {
  accept: '✓',
  reject: '✕',
  unknown: '·',
}

function WaitedChipButton({
  chip,
  selected,
  onToggle,
}: {
  chip: WaitedChip
  selected: boolean
  onToggle: (laneId: string) => void
}): ReactElement {
  const glyph = chip.decision === null ? '?' : DECISION_GLYPH[chip.decision]
  const duration = formatSpan(chip.waitMs)

  return (
    <Disclosure disclosure={waitedChipDisclosure(chip)} trigger="inline">
    <button
      type="button"
      data-waited-chip={chip.laneId}
      aria-pressed={selected}
      onClick={() => onToggle(chip.laneId)}
      className={[
        // Shrinkable, but the duration is not: a chip whose whole point is
        // "this lane waited 6m" must lose its LABEL before it loses the span,
        // so the label carries `min-w-0` and the duration keeps
        // `whitespace-nowrap`. The full text lives in the chip's disclosure
        // card now (#220), so nothing is lost when the label truncates.
        'flex min-w-0 items-center gap-1 rounded-none border px-1.5 py-0.5 normal-case tracking-normal text-(--ink-dim)',
        selected ? 'border-(--ink-primary) bg-(--surface-raised)' : 'border-(--line-strong) bg-(--surface-panel)',
      ].join(' ')}
    >
      <span className="min-w-0 max-w-[7rem] truncate font-medium text-(--ink-body)">{chip.label}</span>
      <span className="figures shrink-0 whitespace-nowrap">waited {duration}</span>
      <span aria-hidden>▸</span>
      <span aria-hidden className="text-(--ink-body)">
        {glyph}
      </span>
    </button>
    </Disclosure>
  )
}

function Pill({ rank, children }: { rank: LadderRank; children: ReactNode }): ReactElement {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-none px-2.5 py-1 font-medium uppercase tracking-[0.2em] ${RANK_TEXT_CLASS[rank]} ${RANK_GLOW_CLASS[rank]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
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
 *
 * Ruling 5 (prd5): how long that WHY has been true also modulates INSISTENCE,
 * never rung — only a needs-you chip ages (broken is already maximal, notice
 * deliberately stays quiet; see {@link agingClass}).
 */
function Chip({ item, selected, onToggle, reducedMotion }: ChipProps): ReactElement {
  const clickable = item.laneId !== null
  const evidence = item.inferred ? `${INFERRED_MARK} ${item.evidence}` : item.evidence
  const age = item.forMs === null ? null : formatSpan(item.forMs)
  const aging = agingClass(item)
  const kind = item.kind
  const kindLabel = isPathologyKind(kind) ? null : NON_PATHOLOGY_LABEL[kind]

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (item.laneId !== null) onToggle(item.laneId)
  }

  return (
    <Disclosure disclosure={chipDisclosure(item, evidence)} trigger="inline">
    <button
      type="button"
      data-chip-id={item.id}
      data-chip-kind={item.kind}
      disabled={!clickable}
      aria-pressed={selected}
      onClick={clickable ? handleClick : undefined}
      className={[
        'flex shrink-0 items-center gap-1.5 rounded-none border px-1.5 py-0.5 normal-case tracking-normal',
        aging.ink,
        selected ? 'border-(--ink-primary) bg-(--surface-raised)' : 'border-(--line-strong) bg-(--surface-panel)',
        clickable ? '' : 'cursor-default opacity-90',
        reducedMotion ? '' : 'attention-chip-flare',
        aging.pulsing && !reducedMotion ? 'attention-chip-age-pulse' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ChipGlyph kind={item.kind} />
      {kindLabel === null ? null : <span className={`heading shrink-0 ${aging.ink}`}>{kindLabel}</span>}
      <span className="max-w-[9rem] truncate font-medium">{item.label}</span>
      <span className="max-w-[18rem] truncate text-(--ink-body)">{evidence}</span>
      {age === null ? null : (
        <span className={`figures shrink-0 ${aging.ageEmphasized ? 'text-needs-you font-semibold' : 'text-(--ink-dim)'}`}>
          {age}
        </span>
      )}
    </button>
    </Disclosure>
  )
}

interface AgingClass {
  /** The chip's ink class — replaces the plain `RANK_TEXT_CLASS` lookup. */
  ink: string
  /** Whether the chip should carry the slow age pulse (motion-gated by the caller). */
  pulsing: boolean
  /** Whether the age figure itself should read brighter than the rest of the chip. */
  ageEmphasized: boolean
}

/**
 * The only place a rung's ink becomes age-aware. BROKEN is already the
 * ladder's maximum, and NOTICE is deliberately a heads-up rather than a
 * summons — ruling 5 confines all of this to NEEDS-YOU, so neither ever
 * escalates or mutes regardless of how long the item has been true.
 */
function agingClass(item: AttentionItem): AgingClass {
  if (item.rank !== 'needs-you') {
    return { ink: RANK_TEXT_CLASS[item.rank], pulsing: false, ageEmphasized: false }
  }
  const band = ageBand(item.forMs)
  return {
    ink: band === 'quiet' ? 'text-waiting-benign' : RANK_TEXT_CLASS['needs-you'],
    pulsing: band === 'pulse',
    ageEmphasized: band === 'pulse',
  }
}

/** Form is kind (graft g4): the five pathologies get the scene's own glyph alphabet. */
function ChipGlyph({ kind }: { kind: AttentionKind }): ReactElement {
  if (isPathologyKind(kind)) return <Sigil kind={kind} size={SIGIL_ROW_SIZE} />
  return (
    <span aria-hidden className="text-read-floor leading-none">
      {NON_PATHOLOGY_GLYPH[kind]}
    </span>
  )
}

function isPathologyKind(kind: AttentionKind): kind is PathologyKind {
  return (PATHOLOGY_KINDS as readonly string[]).includes(kind)
}

/**
 * A waited chip's disclosure (#220) — and the one place in this sweep where the
 * elapsed time needed no sourcing at all: the wait IS the observation, and
 * `chip.waitMs` is its age.
 */
function waitedChipDisclosure(chip: WaitedChip): DisclosureContent {
  const decisionWord = chip.decision === null ? 'unknown' : DECISION_WORD[chip.decision]
  return {
    label: chip.label,
    why: {
      reason: `this lane waited on a decision — ${decisionWord}`,
      evidence: {
        fact: chip.toolName === null ? 'it was blocked on a prompt' : `it was blocked on ${chip.toolName}`,
        elapsedMs: chip.waitMs,
      },
    },
    remedy:
      chip.decision === null
        ? { kind: 'action', action: 'open the lane and answer it' }
        : { kind: 'none', because: `the wait is over — it was ${decisionWord}` },
  }
}

/**
 * A pathology chip's disclosure. The evidence sentence is the strip's own,
 * passed in rather than rebuilt, so the card and the chip beside it cannot
 * phrase one condition two ways — and `item.forMs` is the age the strip
 * already measured for it. A chip with no `forMs` is a continuously-true
 * reading (core's rule) and reports 0 rather than a fabricated span.
 */
function chipDisclosure(item: AttentionItem, evidence: string): DisclosureContent {
  return {
    label: item.kind,
    why: {
      reason: isPathologyKind(item.kind) ? `this lane is ${item.kind}` : NON_PATHOLOGY_LABEL[item.kind],
      evidence: { fact: evidence, elapsedMs: item.forMs ?? 0 },
    },
    remedy:
      item.laneId === null
        ? { kind: 'none', because: 'this chip names a fleet-wide condition rather than one lane, so there is nowhere to open' }
        : { kind: 'action', action: 'select it to filter the fleet to this lane' },
  }
}
