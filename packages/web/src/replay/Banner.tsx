import { useReplay } from '../app/ModeContext.js'
import { formatElapsed, formatWallClock } from './format.js'

/**
 * The REPLAY banner (ruling 16) — the keystone's mode-switched slot replaces
 * the attention strip with this while a recorded session is loaded. It has
 * to make a first-time viewer say "this is the past" unprompted (demo
 * criterion 4), so it states that directly instead of leaning on color: the
 * ice register carries the mode shift, never a ladder hue (law 9) — a mode
 * is not a status, and an amber or magenta banner would read as a summons
 * off a recording of a calm night.
 *
 * Reads the same `ModeContext` slot `StreamContext` and the scrubber read —
 * there is only ever one replay state (architecture.md).
 */
export function ReplayBanner() {
  const { playback, range, state, sessions, selectedId, selectSession, unknownVoice } = useReplay()
  const session = state.session
  const fileName = sessions.find((candidate) => candidate.id === selectedId)?.fileName ?? null

  return (
    <div
      role="status"
      data-panel="replay-banner"
      className="flex h-9 items-center gap-3 bg-(--surface-raised) px-4 heading text-(--ink-primary)"
    >
      <span className="font-semibold text-(--ink-primary)">Replay</span>
      <span className="normal-case tracking-normal text-(--ink-dim)">
        viewing a recorded past — not the live fleet
      </span>

      <span className="figures text-inst normal-case tracking-normal text-(--ink-primary)" title="timestamp being viewed">
        {formatWallClock(playback.currentTs)}
      </span>
      <span className="figures text-inst normal-case tracking-normal text-(--ink-dim)">
        {formatElapsed(playback.currentTs - range.start)} / {formatElapsed(range.end - range.start)}
      </span>

      {session !== null && (
        <span className="normal-case tracking-normal text-(--ink-dim)" title="session identity">
          {session.repoName}
          {fileName !== null && <span className="figures text-(--ink-dim)"> · {fileName}</span>}
        </span>
      )}

      {/*
        THE HONEST GAP (prd17 ruling 3, item 1) — a recording carrying events
        from an era this bundle was not taught says so, here, where "what am I
        looking at" is already the question. Never silently a shorter history.

        Ice register like the rest of the banner, never a ladder hue (law 9): an
        unreadable event is a gap in our comprehension, not a summons about the
        fleet — and this banner is a mode, not a status. It is set apart by
        weight and a border instead, so it reads as a caveat on the recording
        rather than as an alarm off it.
      */}
      {unknownVoice !== null && (
        <span
          data-testid="replay-unknown-era"
          className="rounded border border-(--line-strong) px-2 py-0.5 normal-case tracking-normal text-(--ink-primary)"
          title="this recording came from a newer instrument; these events were kept in the log but this build cannot fold them"
        >
          {unknownVoice}
        </span>
      )}

      <button
        type="button"
        onClick={() => selectSession(null)}
        className="ml-auto rounded border border-(--line-strong) px-2 py-0.5 normal-case tracking-normal text-(--ink-body) hover:border-(--ink-dim) hover:text-(--ink-primary)"
      >
        Exit to live
      </button>
    </div>
  )
}
