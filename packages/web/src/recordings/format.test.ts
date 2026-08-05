import { describe, expect, it } from 'vitest'
import {
  captureHoverTitle,
  costHoverTitle,
  costSuffix,
  formatCapture,
  formatCost,
  formatDuration,
  isCaptureGap,
  isCostGap,
} from './format.js'
import type { RecordingListing } from './api.js'

const BASE: Pick<RecordingListing, 'costUsd' | 'costIsAuthoritative' | 'outputTokens'> = {
  costUsd: 1.23,
  costIsAuthoritative: true,
  outputTokens: 12_345,
}

describe('formatDuration', () => {
  it('renders mm:ss under an hour', () => {
    expect(formatDuration(65_000)).toBe('1:05')
  })

  it('renders h:mm:ss at an hour and beyond — mm:ss alone would misread as under sixty minutes', () => {
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })
})

describe('the cost cell — a null costIsAuthoritative is never a $0', () => {
  it('shows dollars when cost is authoritative', () => {
    expect(formatCost(BASE)).toBe('$1.23')
    expect(isCostGap(BASE)).toBe(false)
    expect(costSuffix(BASE)).toBeNull()
    expect(costHoverTitle(BASE)).toContain('authoritative')
  })

  it('shows dollars marked estimated, still a real figure, when cost is a mixed/estimated read', () => {
    const recording = { ...BASE, costIsAuthoritative: false }
    expect(formatCost(recording)).toBe('$1.23')
    expect(isCostGap(recording)).toBe(false)
    expect(costSuffix(recording)).toBe('est.')
    expect(costHoverTitle(recording)).toContain('estimated')
  })

  it('falls back to output tokens, and says so, when no cost telemetry ever arrived', () => {
    const recording = { ...BASE, costIsAuthoritative: null }
    expect(formatCost(recording)).toBe('12.3K tok out')
    expect(isCostGap(recording)).toBe(true)
    expect(costSuffix(recording)).toBeNull()
    expect(costHoverTitle(recording)).toContain('no cost telemetry')
  })
})

describe('the capture cell — three honest states, never one blank', () => {
  it('says so plainly when the listing pre-dates capture entirely', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = {}
    expect(formatCapture(recording)).toContain('pre-dates transcript capture')
    expect(isCaptureGap(recording)).toBe(true)
    expect(captureHoverTitle(recording)).toContain('before transcript capture')
  })

  it('says "no transcripts captured" for null — never confused with "captured nothing"', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = { transcriptCapture: null }
    expect(formatCapture(recording)).toBe('no transcripts captured')
    expect(isCaptureGap(recording)).toBe(true)
    expect(captureHoverTitle(recording)).toContain('no capture ever ran')
  })

  it('reports full capture cleanly when every attributed lane made it in', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = {
      transcriptCapture: {
        sessionId: '1000',
        capturedAt: 2000,
        complete: true,
        totalBytes: 9_000_000,
        lanes: [
          { lane: 'a', claudeSessionId: 'x', captured: true, bytes: 4_500_000 },
          { lane: 'b', claudeSessionId: 'y', captured: true, bytes: 4_500_000 },
        ],
      },
    }
    expect(formatCapture(recording)).toBe("2 of 2 lanes' transcripts captured")
    expect(isCaptureGap(recording)).toBe(false)
    expect(captureHoverTitle(recording)).toContain('9,000,000 bytes captured, every attributed lane')
  })

  it('names which lanes are missing, and why, when capture is partial', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = {
      transcriptCapture: {
        sessionId: '1000',
        capturedAt: 2000,
        complete: false,
        totalBytes: 100,
        lanes: [
          { lane: 'a', claudeSessionId: 'x', captured: true, bytes: 100 },
          { lane: 'b', claudeSessionId: 'y', captured: false, bytes: 0, reason: 'TRANSCRIPT NOT CAPTURED for "b"' },
        ],
      },
    }
    expect(formatCapture(recording)).toBe("1 of 2 lanes' transcripts captured — some missing")
    expect(isCaptureGap(recording)).toBe(true)
    expect(captureHoverTitle(recording)).toContain('TRANSCRIPT NOT CAPTURED for "b"')
  })
})
