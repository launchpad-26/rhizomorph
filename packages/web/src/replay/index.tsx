import { FIELD } from '../ui/controls.js'
import { useMemo } from 'react'
import { Disclosure, type DisclosureContent } from '../disclosure/index.js'
import { initialSessionState, reduceAll, selectSessionSpend } from '@rhizomorph/core'
import { useModeClock, useReplay } from '../app/ModeContext.js'
import { useStream } from '../app/StreamContext.js'
import { TideDock } from '../tide/TideDock.js'
import { pickRichestSession, type SessionSummary } from './api.js'
import { formatSpend } from './format.js'
import { RotateButton } from './RotateButton.js'
import { timeRangeOf } from './replayFold.js'
import { unknownEraDisclosure } from './unknownEra.js'
import { PLAYBACK_SPEEDS } from './usePlayback.js'

/**
 * `GET /api/sessions` now serves a title (a label if the operator set one
 * with `rhizomorph label`, else an auto-title derived from the session's own
 * events) and lane counts alongside the summary fields `SessionSummary`
 * already types (#156). `api.ts`/`useReplaySession.ts` sit outside this
 * issue's fence, so their `SessionSummary` type hasn't grown those fields —
 * but the raw fetch response carries them on the same objects regardless
 * (JSON passes through a type guard unchanged), so this local, optional
 * extension reads them without that file needing to change. Every field is
 * optional so a session from a server that hasn't grown them yet still
 * renders — see {@link sessionDisplayName}'s fallback.
 */
interface SessionListing extends SessionSummary {
  title?: string
  label?: string | null
  lanes?: number
  landed?: number
}

/** A label always wins; the auto-title is next; the raw timestamp is the last-resort fallback for a server that hasn't grown a title yet. */
function sessionDisplayName(session: SessionListing): string {
  if (typeof session.label === 'string' && session.label.length > 0) return session.label
  if (typeof session.title === 'string' && session.title.length > 0) return session.title
  return new Date(session.startedAt).toISOString()
}

/**
 * Session picker + scrubber. All replay state (session list, selection,
 * fetched log, scrubber clock, fold) lives in `ModeContext` — `StreamContext`
 * reads the exact same slot to serve panels, so this component only renders
 * what's already there.
 */
export default function ReplayControls() {
  const {
    sessions,
    refreshSessions,
    selectedId,
    selectSession,
    selectAndPlay,
    error,
    playback,
    range,
    state,
    events,
    isReplaying,
    unknownVoice,
  } = useReplay()

  /** The whole loaded session's spend — cheap, since `events` is already in memory. */
  const sessionTotal = useMemo(
    () => selectSessionSpend(isReplaying ? reduceAll(events) : initialSessionState()),
    [events, isReplaying],
  )
  const scrubSpend = useMemo(() => selectSessionSpend(state), [state])

  /**
   * THE TIDE'S FEED (prd13 wave 3, #169) — live and replay read two different
   * logs, the same way `StreamContext.tsx`'s own `value` does: replay's is the
   * whole session `useReplay()` already has in memory (the band body is a map
   * of the whole recording, not just what has scrubbed into view — ruling 2's
   * "the band *is* the recording's map"); live's is the raw log the *live*
   * stream source has folded so far, read via `useStream()` exactly the way
   * every panel already does, never via `StreamContext`'s replay-scoped
   * branch (that one is a scrub prefix, the wrong shape for a map of the
   * whole session-to-now).
   */
  const stream = useStream()
  const now = useModeClock()
  const liveEvents = stream.state.events
  const liveStart = useMemo(() => timeRangeOf(liveEvents)?.start ?? now, [liveEvents, now])
  const tideEvents = isReplaying ? events : liveEvents
  const tideStart = isReplaying ? range.start : liveStart
  const tideEnd = isReplaying ? range.end : now

  /**
   * THE SCRUB INSTANT'S HEADLINE FACTS (#272), formatted here and painted
   * beside the thumb by `Scrubber` through `TideDock`.
   *
   * These are the same three facts that used to sit on a prose row at the foot
   * of the replay bar — `N worktrees · M commits · $X as of scrub time`. The
   * row is gone: "as of scrub time" was the whole of what tied it to the
   * playhead, and a caption a screen away from the thumb is what the issue
   * calls scattered. Beside the thumb the tie is the position itself, so the
   * phrase is no longer needed to explain what the numbers are about.
   *
   * `null` outside replay: live has no scrub instant, and the readout falls
   * back to the clock alone.
   */
  const scrubFacts = useMemo(
    () =>
      isReplaying
        ? `${Object.keys(state.worktrees).length} worktrees · ${state.commits.order.length} commits · ${formatSpend(scrubSpend)}`
        : null,
    [isReplaying, state.worktrees, state.commits.order.length, scrubSpend],
  )

  function replayBirth() {
    const richest = pickRichestSession(sessions)
    if (!richest) return
    if (isReplaying && selectedId === richest.id) {
      playback.play()
      return
    }
    selectAndPlay(richest.id)
  }

  const noSessions = sessions.length === 0

  /*
   * The two controls that explain their own unavailability, lifted out so each
   * can be wrapped in a card only while it HAS something to explain (#389).
   *
   * Both wear `aria-disabled` rather than `disabled` (ADR-0047) and both guard
   * inside the handler rather than on the event: an `aria-disabled` button is a
   * real button to the browser, so it fires on Enter and Space as well as on
   * click, and a pointer-only guard would leave a keyboard user able to invoke
   * an action this surface says is unavailable — strictly worse than the
   * `disabled` it replaces.
   *
   * `aria-disabled:opacity-50` and not `disabled:opacity-50`: the Tailwind
   * variant follows the attribute, and leaving it would have made both controls
   * stop LOOKING unavailable while still being it.
   */
  const birthButton = (
    <button
      type="button"
      onClick={() => {
        if (noSessions) return
        replayBirth()
      }}
      aria-disabled={noSessions}
      className="rounded-none border border-(--line-strong) px-2 py-1 normal-case tracking-normal text-(--ink-body) hover:border-(--ink-dim) hover:text-(--ink-primary) aria-disabled:opacity-50"
    >
      {"Replay this session's birth"}
    </button>
  )

  const playButton = (
    <button
      type="button"
      onClick={() => {
        if (!isReplaying) return
        if (playback.playing) playback.pause()
        else playback.play()
      }}
      aria-disabled={!isReplaying}
      className="rounded-none border border-(--line-hair) px-2 py-1 hover:border-(--ink-dim) hover:text-(--ink-primary) aria-disabled:opacity-50"
    >
      {playback.playing ? 'Pause' : 'Play'}
    </button>
  )

  /*
   * ONE DOCK, ONE CAPTION (walkthrough, 2026-08-17).
   *
   * A human read this as "two timeline bars" and it is not two components — it
   * is three sibling flex rows in this one, each opening with its own uppercase
   * caption ("REPLAY", "SESSION") above the TIDE's own axis. Three captions in a
   * vertical stack read as three docks; the transport and the session boundary
   * are one control surface for one thing, which prd-13 ruling 1 already
   * named — "they share one x-axis and read as a single TIME dock".
   *
   * So: one caption for the whole dock, the rotate control folded onto the same
   * row as the transport it belongs beside, and the row gap tightened from
   * `gap-1` to `gap-y-1` on a single wrapping row. This is a caption-and-spacing
   * fix and deliberately nothing more — no state moved, no control removed.
   *
   * It is also half of the fleet-clipping repair in the same walkthrough: this
   * bar is an `auto` row in `Shell`'s grid, so every line it does not draw is a
   * line the fleet's single `1fr` row gets back.
   */
  return (
    <div className="flex flex-col gap-1 border-t border-(--line-hair) px-4 py-1.5 text-inst uppercase tracking-wide text-(--ink-dim)">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold tracking-widest text-(--ink-body)">Time</span>
        <span className="font-semibold text-(--ink-primary)">
          {isReplaying ? 'Replay mode' : 'Live mode'}
        </span>

        {/*
          ARIA-DISABLED, NOT DISABLED (#389, ADR-0047) — the reason this control
          is unavailable is the one explanation a `disabled` button cannot give:
          it leaves the tab order, so a keyboard never reaches the card that
          carries it. The guard lives INSIDE the handler because an
          `aria-disabled` button is a real button — it fires on click, Enter and
          Space alike, and guarding only the pointer path would leave a keyboard
          user able to invoke what this surface says is unavailable.

          Disclosed only while unavailable: the enabled-state `title=` this
          retires read "Replay this session's birth", which is this button's own
          visible label repeated. A card that echoes the label discloses nothing
          and is the noise prd-30 is against.
        */}
        {noSessions ? (
          <Disclosure trigger="inline" disclosure={noSessionsDisclosure()}>
            {birthButton}
          </Disclosure>
        ) : (
          birthButton
        )}

        <label className="flex items-center gap-2 normal-case tracking-normal">
          <span className="uppercase tracking-wide text-(--ink-dim)">session</span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => selectSession(event.target.value === '' ? null : event.target.value)}
            className={FIELD}
          >
            <option value="">Replay a recorded session…</option>
            {(sessions as SessionListing[]).map((session) => (
              <option key={session.id} value={session.id}>
                {sessionDisplayName(session)}
              </option>
            ))}
          </select>
        </label>

        {isReplaying && (
          <span className="normal-case tracking-normal text-(--ink-dim)">
            <Disclosure disclosure={sessionTotalDisclosure()}>
              total {formatSpend(sessionTotal)}
            </Disclosure>
          </span>
        )}

        {/* aria-disabled + guarded handler — see the note on the birth button (#389, ADR-0047). */}
        {isReplaying ? (
          playButton
        ) : (
          <Disclosure trigger="inline" disclosure={noPlaybackDisclosure()}>
            {playButton}
          </Disclosure>
        )}

        <div className="flex items-center gap-1" role="group" aria-label="playback speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => playback.setSpeed(speed)}
              disabled={!isReplaying}
              aria-pressed={playback.speed === speed}
              className={`rounded-none border px-2 py-1 disabled:opacity-50 ${
                playback.speed === speed
                  ? 'border-(--ink-dim) text-(--ink-primary)'
                  : 'border-(--line-hair) hover:border-(--ink-dim) hover:text-(--ink-primary)'
              }`}
            >
              {speed}x
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => selectSession(null)}
          disabled={!isReplaying}
          className="rounded-none border border-(--line-hair) px-2 py-1 hover:border-(--ink-dim) hover:text-(--ink-primary) disabled:opacity-50"
        >
          Return to live
        </button>

        {/*
          THE OPERATOR'S SESSION BOUNDARY (prd16 ruling 2) — beside the picker,
          because that is where "which recording am I looking at" is already the
          question. It used to sit on a row of its own under a second caption;
          the caption was what made the dock read as two. Refreshing the listing
          on success is what puts the session it just closed in the picker,
          immediately.
        */}
        <RotateButton onRotated={refreshSessions} />
      </div>

      <TideDock
        mode={isReplaying ? 'replay' : 'live'}
        events={tideEvents}
        start={tideStart}
        end={tideEnd}
        value={playback.currentTs}
        onSeek={playback.seek}
        seekEnabled={isReplaying}
        scrubFacts={scrubFacts}
      />

      {error !== null && <p className="normal-case tracking-normal text-broken">{error}</p>}

      {/*
        THE SESSION LISTING'S OWN VOICE (prd17 ruling 3, item 1) — on the row
        under the picker, because the picker is where a recording is CHOSEN and
        "what is in it" belongs beside that choice, not only in the banner over
        the panels.
      */}
      {unknownVoice !== null && (
        <p data-testid="replay-listing-unknown-era" className="normal-case tracking-normal text-(--ink-primary)">
          {/* The card goes INSIDE the paragraph: the default trigger renders a
              <button>, and a <p> nested in a <button> is invalid markup. */}
          <Disclosure disclosure={unknownEraDisclosure()}>{unknownVoice}</Disclosure>
        </p>
      )}

      {sessions.length === 0 && error === null && (
        <p className="normal-case tracking-normal text-(--ink-dim)">no recorded sessions yet</p>
      )}
    </div>
  )
}


/**
 * The three conditions this dock discloses (#389, prd-30 w4).
 *
 * Each `reason` is the exact string of the native `title=` it retires — ported,
 * never reworded. What the vocabulary requires alongside it (an evidence clause
 * and a remedy) is written from facts this surface already holds, in the
 * register `app/Nav.tsx`'s `disabledNavDisclosure` established for the same
 * job: `elapsedMs: 0`, because each is re-derived from the fold on every render
 * and so is confirmed just now rather than a dated observation.
 */
function noSessionsDisclosure(): DisclosureContent {
  return {
    label: 'no recorded sessions',
    why: {
      reason: 'No recorded sessions yet',
      evidence: { fact: 'the instrument has listed no session recording in its own data directory', elapsedMs: 0 },
    },
    remedy: {
      kind: 'action',
      action: 'record one first — this becomes available as soon as a single session exists',
    },
  }
}

function noPlaybackDisclosure(): DisclosureContent {
  return {
    label: 'playback unavailable',
    why: {
      reason: 'Select a session first to enable playback',
      evidence: { fact: 'no recorded session is loaded, so there is nothing to play', elapsedMs: 0 },
    },
    remedy: { kind: 'action', action: 'choose a recording from the session picker beside this control' },
  }
}

function sessionTotalDisclosure(): DisclosureContent {
  return {
    label: 'total spend',
    why: {
      reason: 'total spend for this whole recorded session, not just up to the scrub time',
      evidence: { fact: 'summed across every usage event in the recording, not the fold at the playhead', elapsedMs: 0 },
    },
    remedy: {
      kind: 'none',
      because: 'it is a fact about the recording rather than a condition — scrubbing changes the picture, never this figure',
    },
  }
}
