import type { SessionState } from '@rhizomorph/core'
import type { TranscriptEntry } from '../drawer/useTranscript.js'
import {
  buildInteractionCards,
  phaseFor,
  type InteractionCardModel,
  type InteractionCost,
  type InteractionPhase,
} from '../interaction/index.js'
import type { LaneIndexCommit, LaneIndexEntry, LaneIndexSlice } from './laneIndex.js'

/**
 * THE PHASE SPINE (prd-31 ruling 5 and S2, region 2 · #556) — a lane's whole
 * life as one continuous reading, however many recordings it is scattered
 * across.
 *
 * **The spine's rows are SESSIONS, and that is the durability decision.** A
 * lane that ran across three nights has its events in three logs; the only
 * shape that can render "one continuous life" without pretending they are one
 * log is to make each recording a row and let the reader see the seam. The row
 * for the recording the page currently holds expands into its interaction cards
 * (`interaction/`); the rows for the others carry the facts the index holds and
 * say, out loud, that their spans are in another recording.
 *
 * **A missing recording is a row too.** S2's *partial* state: a session whose
 * log is gone shows up as a row carrying the index's own law-12 sentence, so a
 * reader is told which session is absent rather than shown a shorter life and
 * left to believe it. Dropping the row would make a partial reading look
 * complete, which is the one failure S2 names by name.
 *
 * **Phase is inferred, and every row says so.** `phaseFor` (ruling 7) decides
 * it from the tools that ran and the commits that landed, and hands back the
 * evidence in the disclosure card's own shape — so the word "landing" is never
 * one keystroke away from the reason it was chosen.
 */

export interface SpineSession {
  sessionId: string
  startedAt: number
  label: string | null
  /** Law 12's sentence when this recording could not be read; null when it read. */
  gap: string | null
  /** True for the recording the page's own fold currently holds — the only row with cards. */
  loaded: boolean
  phase: InteractionPhase
  interactionCount: number
  toolCallCount: number
  files: string[]
  commits: LaneIndexCommit[]
  outputTokens: number
  cost: InteractionCost
  /** Loaded interactions, newest first. Empty for every row but the loaded one. */
  cards: InteractionCardModel[]
}

/**
 * Dollars with provenance, from an index slice. The three arms are the same
 * three the interaction card uses, deliberately: one vocabulary for cost across
 * the whole run view, so a session row and a card inside it cannot disagree
 * about what `est.` means.
 */
function costOfSlice(slice: LaneIndexSlice, now: number): InteractionCost {
  const lastTs = slice.lastTs ?? slice.startedAt
  if (slice.costIsAuthoritative === null) {
    return {
      kind: 'gap',
      disclosure: {
        label: 'cost',
        why: {
          reason: slice.recordingPresent
            ? 'no cost record reached this lane in this recording'
            : 'this recording could not be read, so no cost could be counted',
          evidence: {
            fact: slice.recordingPresent
              ? `${slice.toolCallCount} tool call(s) and ${slice.interactionCount} interaction(s) were read, and none carried dollars — last activity`
              : 'the capture sidecar names this lane, the event log beside it does not exist — recording started',
            elapsedMs: Math.max(0, now - lastTs),
          },
        },
        remedy: {
          kind: 'none',
          because:
            'the figure is missing, not zero — an unpriced model or a session with no cost feed spends real money the log cannot name',
        },
      },
    }
  }
  if (slice.costIsAuthoritative) return { kind: 'authoritative', usd: slice.costUsd }
  return { kind: 'estimated', usd: slice.costUsd, sources: slice.estimateSources }
}

export interface BuildSpineOptions {
  /** The lane index entry, or null when the index has nothing (or is unreachable). */
  entry: LaneIndexEntry | null
  /** The fold the page currently holds — live or scrubbed. */
  state: SessionState
  /** Telemetry handle to derive the loaded recording's interactions for. */
  lane: string
  /** The reader's own position in time. Nothing here reads a clock. */
  now: number
  /** The loaded conversation, for the cards' quotes. */
  entries?: readonly TranscriptEntry[]
}

/**
 * The spine, oldest session first.
 *
 * With an index: one row per session the lane appears in, the loaded one
 * carrying its cards. Without one (an older server, or a request that failed):
 * one row for the recording in hand, so the page still reads — degraded to
 * "what is loaded", never to nothing.
 */
export function buildSpine(options: BuildSpineOptions): SpineSession[] {
  const { entry, state, lane, now } = options
  const cards = buildInteractionCards(state, lane, { now, entries: options.entries })
  const loadedSessionId = state.session?.sessionId ?? null

  if (entry === null) {
    const files = [...new Set(cards.flatMap((card) => card.facts.files))].sort()
    return [
      {
        sessionId: loadedSessionId ?? 'loaded',
        startedAt: state.firstEventTs ?? now,
        label: null,
        gap: null,
        loaded: true,
        // No index means no toolCounts and no commit list to infer from — the
        // cards' own phases are what there is, and the newest card's is the
        // lane's current one.
        phase: cards[0]?.phase ?? phaseFor([], 0, now, state.lastEventTs ?? now),
        interactionCount: cards.length,
        toolCallCount: cards.reduce((total, card) => total + card.facts.toolCount, 0),
        files,
        commits: [],
        outputTokens: cards.reduce((total, card) => total + card.facts.tokens.output, 0),
        cost: aggregateCardCost(cards, now, state.lastEventTs ?? now),
        cards,
      },
    ]
  }

  return entry.sessions.map((slice) => {
    const loaded = slice.sessionId === loadedSessionId
    return {
      sessionId: slice.sessionId,
      startedAt: slice.startedAt,
      label: slice.label,
      gap: slice.gap,
      loaded,
      phase: phaseFor(
        Object.keys(slice.toolCounts),
        slice.commits.length,
        now,
        slice.lastTs ?? slice.startedAt,
      ),
      interactionCount: slice.interactionCount,
      toolCallCount: slice.toolCallCount,
      files: slice.files,
      commits: slice.commits,
      outputTokens: slice.outputTokens,
      cost: costOfSlice(slice, now),
      cards: loaded ? cards : [],
    }
  })
}

/** The loaded cards' dollars, summed, keeping the weakest provenance any of them carried. */
function aggregateCardCost(
  cards: readonly InteractionCardModel[],
  now: number,
  lastTs: number,
): InteractionCost {
  const priced = cards.map((card) => card.facts.cost).filter((cost) => cost.kind !== 'gap')
  if (priced.length === 0) {
    return {
      kind: 'gap',
      disclosure: {
        label: 'cost',
        why: {
          reason: 'no interaction in the loaded recording could be joined to a cost record',
          evidence: {
            fact: `${cards.length} interaction(s) read, none with a request id a cost names — last span`,
            elapsedMs: Math.max(0, now - lastTs),
          },
        },
        remedy: {
          kind: 'none',
          because: 'the figure is missing, not zero — apportioning the lane total across interactions would invent it',
        },
      },
    }
  }
  const usd = priced.reduce((total, cost) => total + cost.usd, 0)
  const estimates = priced.filter((cost) => cost.kind === 'estimated')
  if (estimates.length === 0) return { kind: 'authoritative', usd }
  // Any estimate in the sum makes the whole sum an estimate: a total that is
  // part CLI figure and part our own arithmetic is not authoritative, and
  // flagging it as such would be the "estimated dollar without its flag"
  // failure S1 names, arrived at by averaging.
  return {
    kind: 'estimated',
    usd,
    sources: [...new Set(estimates.flatMap((cost) => cost.sources))].sort(),
  }
}
