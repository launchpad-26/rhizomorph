import type { LabCheckpoint } from '../types.js'

/**
 * THE ONE FUNCTION (prd53 ruling 4, S1): every lab surface that places anything
 * on the session reads its position HERE — %-of-session is `sessionCutByte`
 * over the session's byte length, `eventIndex` the tie-break, never wall-clock.
 * `position-law.test.ts` fails the build if any other file under `lab/` does
 * the division itself; `same-x-law.test.tsx` proves the track and the frame
 * put the same byte at the same x.
 */

/** 0..1, or null when the session's length cannot be known (the file moved — S1's degraded state). */
export function sessionFraction(cutByte: number, byteLength: number | null): number | null {
  if (byteLength === null || !Number.isFinite(byteLength) || byteLength <= 0) return null
  if (!Number.isFinite(cutByte) || cutByte <= 0) return 0
  return Math.min(1, cutByte / byteLength)
}

/** The horizontal inset the axis leaves for its end labels, in viewBox units. */
export const AXIS_INSET = 40

/** A fraction of the session → an x in a viewBox `width` wide, inside the insets. */
export function axisX(fraction: number, width: number, inset: number = AXIS_INSET): number {
  const span = Math.max(0, width - 2 * inset)
  return Math.round((inset + Math.min(1, Math.max(0, fraction)) * span) * 100) / 100
}

/** A checkpoint's x on an axis `width` wide — or null when its position is unknown. */
export function markerX(checkpoint: Pick<LabCheckpoint, 'sessionCutByte' | 'sessionByteLength'>, width: number): number | null {
  const fraction = sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength)
  return fraction === null ? null : axisX(fraction, width)
}

/** Byte first, event index second — two cuts at one byte keep their recorded order. */
export function compareByPosition(a: Pick<LabCheckpoint, 'sessionCutByte' | 'eventIndex'>, b: Pick<LabCheckpoint, 'sessionCutByte' | 'eventIndex'>): number {
  return a.sessionCutByte - b.sessionCutByte || a.eventIndex - b.eventIndex
}

/** "46 %" — the readout the playhead wears; null when the position is unknown. */
export function percentLabel(fraction: number | null): string | null {
  return fraction === null ? null : `${Math.round(fraction * 100)} %`
}
