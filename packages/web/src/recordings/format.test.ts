import { describe, expect, it } from 'vitest'
import { disclosureLines, type DisclosureContent } from '../disclosure/index.js'
import {
  captureHoverDisclosure,
  costHoverDisclosure,
  costSuffix,
  formatCapture,
  formatCost,
  formatDuration,
  isCaptureGap,
  isCostGap,
  isCaptureAbsent,
} from './format.js'
import type { RecordingListing } from './api.js'

/**
 * What the card actually puts on screen, joined for the assertions below.
 *
 * These used to read a `title=` string straight out of the formatter (#220).
 * Going through `disclosureLines` is strictly stronger than that was: it is the
 * same function the card renders through, and it THROWS on a disclosure with no
 * evidence, no age or an unstated remedy — so a formatter that lost its
 * evidence clause fails here rather than rendering a poorer card in silence.
 */
function lines(disclosure: DisclosureContent): string {
  const rendered = disclosureLines(disclosure)
  return [rendered.label, rendered.why, rendered.remedy, rendered.command ?? ''].join(' · ')
}


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
    expect(lines(costHoverDisclosure(BASE))).toContain('authoritative')
  })

  it('shows dollars marked estimated, still a real figure, when cost is a mixed/estimated read', () => {
    const recording = { ...BASE, costIsAuthoritative: false }
    expect(formatCost(recording)).toBe('$1.23')
    expect(isCostGap(recording)).toBe(false)
    expect(costSuffix(recording)).toBe('est.')
    expect(lines(costHoverDisclosure(recording))).toContain('estimated')
  })

  it('falls back to output tokens, and says so, when no cost telemetry ever arrived', () => {
    const recording = { ...BASE, costIsAuthoritative: null }
    expect(formatCost(recording)).toBe('12.3K tok out')
    expect(isCostGap(recording)).toBe(true)
    expect(costSuffix(recording)).toBeNull()
    expect(lines(costHoverDisclosure(recording))).toContain('no cost telemetry')
  })
})

describe('the capture cell — three honest states, never one blank', () => {
  it('says so plainly when the listing pre-dates capture entirely', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = {}
    expect(formatCapture(recording)).toContain('pre-dates transcript capture')
    expect(isCaptureGap(recording)).toBe(true)
    // #220 split this sentence into the card's triple; the claim is unchanged
    // — the recording predates the feature, so its conversations are not in it.
    const card = lines(captureHoverDisclosure(recording))
    expect(card).toContain('predates transcript capture')
    expect(card).toContain('its conversations are not in this recording')
  })

  it('says "no transcripts captured" for null — never confused with "captured nothing"', () => {
    const recording: Pick<RecordingListing, 'transcriptCapture'> = { transcriptCapture: null }
    expect(formatCapture(recording)).toBe('no transcripts captured')
    expect(isCaptureGap(recording)).toBe(true)
    expect(lines(captureHoverDisclosure(recording))).toContain('no capture ever ran')
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
    // Both halves, now the reason and its evidence rather than one string.
    const card = lines(captureHoverDisclosure(recording))
    expect(card).toContain('every attributed lane was captured')
    expect(card).toContain('9,000,000 bytes captured')
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
    expect(lines(captureHoverDisclosure(recording))).toContain('TRANSCRIPT NOT CAPTURED for "b"')
  })
})

describe('isCaptureAbsent — the norm, as distinct from the fault', () => {
  it('absence: capture never ran, or ran and attributed nothing', () => {
    expect(isCaptureAbsent({ transcriptCapture: null })).toBe(true)
    expect(isCaptureAbsent({ transcriptCapture: undefined })).toBe(true)
  })

  it('a partial capture is NOT absence — "some missing" keeps its volume', () => {
    expect(
      isCaptureAbsent({
        transcriptCapture: {
          complete: false,
          lanes: [{ laneId: 'a', captured: true }, { laneId: 'b', captured: false }],
        } as never,
      }),
    ).toBe(false)
  })
})
