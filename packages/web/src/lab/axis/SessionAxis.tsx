import type { KeyboardEvent } from 'react'
import type { LabCheckpoint } from '../types.js'
import { AXIS_INSET, compareByPosition, markerX, percentLabel, sessionFraction } from './position.js'

/**
 * THE SESSION AXIS (prd53 S1, #325): one horizontal scale — the session — with
 * checkpoints as chapter markers placed by BYTE (`position.ts`), a playhead
 * seated on one of them, and the fork-from-here action on the seated marker
 * and nowhere else. The operator stands in time here: "twenty minutes ago,
 * before the summariser first ran" is a marker, not a row.
 *
 * States (ruling 7): live (markers on the track) · empty (no checkpoints —
 * the copy says how to make one) · degraded (a checkpoint whose session file
 * moved is a marker WITH ITS REASON at the axis start, never absent) ·
 * partial launch (a fork whose arms did not all dispatch names its failed arm
 * count at the marker). The playhead crosses what is on the axis and stops
 * at what is not — nothing after the last event is drawn as a shape.
 *
 * Keyboard: click a marker to seat the playhead · ←/→ step markers ·
 * Home/End first/last · Esc clears the selection.
 */
export interface SessionAxisProps {
  checkpoints: readonly LabCheckpoint[]
  /** The seated checkpoint's id, or null. */
  seated: string | null
  onSeat: (checkpointId: string | null) => void
  /** Per checkpoint id: how many arms of a fork from it never dispatched (ruling 7). */
  failedArmsByCheckpoint?: Readonly<Record<string, number>>
  /** The ONE place the action lives: fires for the seated checkpoint only. */
  onForkFromHere?: (checkpoint: LabCheckpoint) => void
  width?: number
}

export const AXIS_EMPTY_COPY = 'there are no checkpoints yet — capture one with `rhizomorph lab checkpoint <lane>`'

const HEIGHT = 84

/** The gap between the playhead line and its label, in viewBox units. */
const LABEL_GAP = 8

/**
 * One character's advance for the label's face at `fontSize={10}`, in viewBox
 * units. The label is mono (`--font-mono`, JetBrains Mono through the theme's
 * own token), so every glyph advances the same 0.6 em — 6 units at this size —
 * and a character count IS a width rather than an estimate of one. The extra
 * 0.2 is headroom for the fallback faces in that token's stack, which are
 * monospaced too but not all at 0.6.
 */
const LABEL_CHAR_WIDTH = 6.2

export interface AxisLabelPlacement {
  x: number
  anchor: 'start' | 'middle' | 'end'
  /** True when the label was moved LEFT of where it would ordinarily sit, to stay inside the drawing. */
  flipped: boolean
  /** The label's right edge, in viewBox units — the number S1′'s acceptance criterion bounds. */
  right: number
}

/**
 * WHERE THE PLAYHEAD LABEL GOES (prd-55 ruling 8; S1′: "the playhead label's
 * right edge ≤ viewport width at 100 %"). The label sits to the right of its
 * line, which is fine everywhere except the end of the session — and the end
 * of the session is exactly where the newest checkpoint sits, so the one label
 * the operator reads most was the one hanging off the edge. It FLIPS to the
 * left of the line when its right edge would otherwise leave the drawing.
 *
 * The measurement is the label's own, in viewBox units: the SVG scales its
 * viewBox to the viewport, so "inside the viewport at 100 %" and "inside the
 * viewBox" are one claim, and neither needs a layout pass to answer — which is
 * what makes the criterion executable in a DOM test rather than only visible
 * in a screenshot. Flipping cannot push the label off the other edge instead:
 * a flipped label's right edge IS the line, and the line is never further left
 * than the axis inset.
 */
export function playheadLabelPlacement(playheadX: number, text: string, width: number): AxisLabelPlacement {
  const right = playheadX + LABEL_GAP + text.length * LABEL_CHAR_WIDTH
  if (right <= width) return { x: playheadX + LABEL_GAP, anchor: 'start', flipped: false, right }
  return { x: playheadX - LABEL_GAP, anchor: 'end', flipped: true, right: playheadX - LABEL_GAP }
}

/**
 * THE SAME RULE FOR THE SCALE'S OWN TICK LABELS. A tick label is CENTRED on
 * its tick, so half of it hangs to the right — and the last tick sits at
 * `width - AXIS_INSET` while its label is the longest of the five
 * ("100 % of session"). At any width, half of sixteen mono characters is 49.6
 * units against an inset of 40, so the end label overhung the drawing by ~10
 * units at every size; it was invisible at 1000 and clipped at the viewport
 * edge at 2560, which is where the operator found it.
 *
 * `AXIS_INSET` exists precisely so the end labels have room, and a centred
 * label spends more of that room than there is. So a tick label whose right
 * edge would leave the drawing anchors at its tick instead of straddling it,
 * putting the whole label inside the track — the same measured decision the
 * playhead's label makes, from the same character-count width.
 *
 * The left end needs no mirror of this today and does not get one on
 * speculation: the first tick's label is "0 %", three characters whose half is
 * 9.3 against the same 40 of inset. If a tick label ever grows long enough to
 * reach past the left edge, this is where that rule belongs.
 */
export function tickLabelPlacement(tickX: number, text: string, width: number): AxisLabelPlacement {
  const right = tickX + (text.length * LABEL_CHAR_WIDTH) / 2
  if (right <= width) return { x: tickX, anchor: 'middle', flipped: false, right }
  return { x: tickX, anchor: 'end', flipped: true, right: tickX }
}

export function SessionAxis({ checkpoints, seated, onSeat, failedArmsByCheckpoint = {}, onForkFromHere, width = 1000 }: SessionAxisProps) {
  const ordered = [...checkpoints].sort(compareByPosition)
  const seatedIndex = ordered.findIndex((checkpoint) => checkpoint.checkpointId === seated)
  const seatedCheckpoint = seatedIndex === -1 ? null : (ordered[seatedIndex] ?? null)

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (ordered.length === 0) return
    const step = (to: number) => {
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, to))]
      if (next !== undefined) onSeat(next.checkpointId)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      step(seatedIndex === -1 ? 0 : seatedIndex + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      step(seatedIndex === -1 ? ordered.length - 1 : seatedIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      step(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      step(ordered.length - 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onSeat(null)
    }
  }

  if (ordered.length === 0) {
    return (
      <div data-testid="session-axis" data-state="empty" className="text-read-body text-(--ink-dim)">
        <p data-testid="axis-empty">{AXIS_EMPTY_COPY}</p>
      </div>
    )
  }

  const playheadX = seatedCheckpoint === null ? null : markerX(seatedCheckpoint, width)
  const playheadLabel = seatedCheckpoint === null ? null : percentLabel(sessionFraction(seatedCheckpoint.sessionCutByte, seatedCheckpoint.sessionByteLength))

  return (
    <div data-testid="session-axis" data-state="live" className="flex flex-col gap-1 text-read-body text-(--ink-body)">
      <div role="listbox" aria-label="the session, as one scale" tabIndex={0} onKeyDown={onKeyDown} className="focus-ring outline-none">
        <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="block h-auto w-full" data-testid="axis-svg">
          <line x1={AXIS_INSET} y1={50} x2={width - AXIS_INSET} y2={50} stroke="var(--line-strong)" strokeWidth={1} />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const tickX = axisXFor(tick, width)
            const label = tick === 0 ? '0 %' : tick === 1 ? '100 % of session' : `${tick * 100}`
            const placement = tickLabelPlacement(tickX, label, width)
            return (
              <g key={tick}>
                <line x1={tickX} y1={46} x2={tickX} y2={54} stroke="var(--line-strong)" strokeWidth={1} />
                <text
                  data-testid={`axis-tick-${tick}`}
                  data-flipped={placement.flipped ? 'true' : 'false'}
                  data-label-right={String(placement.right)}
                  x={placement.x}
                  y={72}
                  textAnchor={placement.anchor}
                  fill="var(--ink-dim)"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                >
                  {label}
                </text>
              </g>
            )
          })}
          {ordered.map((checkpoint) => {
            const x = markerX(checkpoint, width)
            const isSeated = checkpoint.checkpointId === seated
            const failed = failedArmsByCheckpoint[checkpoint.checkpointId] ?? 0
            const degraded = x === null
            const drawX = x ?? AXIS_INSET
            return (
              <g
                key={checkpoint.eventId}
                role="option"
                aria-selected={isSeated}
                aria-label={`checkpoint ${checkpoint.checkpointId}${degraded ? ' — session file moved, position unknown' : ''}`}
                data-testid={`axis-marker-${checkpoint.checkpointId}`}
                data-x={x === null ? 'unknown' : String(x)}
                data-degraded={degraded ? 'true' : undefined}
                data-failed-arms={failed > 0 ? String(failed) : undefined}
                onClick={() => onSeat(checkpoint.checkpointId)}
                className="cursor-pointer"
              >
                {degraded ? (
                  <circle cx={drawX} cy={50} r={3.5} fill="var(--ink-dim)" />
                ) : (
                  <rect x={drawX - 5} y={42} width={10} height={16} rx={1} fill="var(--surface-panel)" stroke={failed > 0 ? 'var(--color-broken)' : isSeated ? 'var(--ink-primary)' : 'var(--ink-body)'} strokeWidth={1.25} />
                )}
                <text x={drawX} y={32} textAnchor="middle" fill={degraded ? 'var(--ink-dim)' : 'var(--ink-dim)'} fontSize={10} fontFamily="var(--font-mono)">
                  {degraded ? 'ckpt · session file moved' : `ckpt · ${percentLabel(sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength)) ?? ''}`}
                  {failed > 0 ? ` · fork: ${failed} arm${failed === 1 ? '' : 's'} failed` : ''}
                </text>
              </g>
            )
          })}
          {playheadX === null ? null : (
            <g data-testid="axis-playhead" data-x={String(playheadX)}>
              <line x1={playheadX} y1={6} x2={playheadX} y2={HEIGHT - 4} stroke="var(--color-calm, var(--ink-primary))" strokeWidth={1.5} />
              <polygon points={`${playheadX - 6},6 ${playheadX + 6},6 ${playheadX},14`} fill="var(--color-calm, var(--ink-primary))" />
              {(() => {
                // The label's placement is measured, not assumed: at the end of
                // the session it flips to the left of its own line rather than
                // hanging off the drawing (S1′). Both numbers ride on the
                // element so the criterion can be read off the DOM.
                const text = `playhead · ${playheadLabel}`
                const placement = playheadLabelPlacement(playheadX, text, width)
                return (
                  <text
                    data-testid="axis-playhead-label"
                    data-flipped={placement.flipped ? 'true' : 'false'}
                    data-label-right={String(placement.right)}
                    x={placement.x}
                    y={16}
                    textAnchor={placement.anchor}
                    fill="var(--color-calm, var(--ink-primary))"
                    fontSize={10}
                    fontFamily="var(--font-mono)"
                  >
                    {text}
                  </text>
                )
              })()}
            </g>
          )}
        </svg>
      </div>
      {seatedCheckpoint === null ? (
        <p className="text-(--ink-dim)">click a marker, or → to seat the playhead on a checkpoint</p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="figures text-(--ink-primary)">{seatedCheckpoint.checkpointId}</span>
          <span className="text-(--ink-dim)">
            lane {seatedCheckpoint.lane} · byte {seatedCheckpoint.sessionCutByte}
            {seatedCheckpoint.sessionByteLength === null ? ' · session file moved — position unknown' : ` of ${seatedCheckpoint.sessionByteLength}`}
          </span>
          {onForkFromHere === undefined ? null : (
            <button
              type="button"
              data-testid="axis-fork-from-here"
              onClick={() => onForkFromHere(seatedCheckpoint)}
              className="focus-ring heading border border-(--ink-primary) px-1.5 py-0.5 text-(--ink-primary)"
            >
              fork from here
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function axisXFor(fraction: number, width: number): number {
  return AXIS_INSET + fraction * (width - 2 * AXIS_INSET)
}
