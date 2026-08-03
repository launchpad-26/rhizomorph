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
  const { playback, range, state, sessions, selectedId, selectSession } = useReplay()
  const session = state.session
  const fileName = sessions.find((candidate) => candidate.id === selectedId)?.fileName ?? null

  return (
    <div
      role="status"
      data-panel="replay-banner"
      className="flex h-9 items-center gap-3 bg-ice-900 px-4 text-xs uppercase tracking-[0.2em] text-ice-100"
    >
      <span className="font-semibold text-ice-050">Replay</span>
      <span className="normal-case tracking-normal text-ice-400">
        viewing a recorded past — not the live fleet
      </span>

      <span className="figures text-[11px] normal-case tracking-normal text-ice-200" title="timestamp being viewed">
        {formatWallClock(playback.currentTs)}
      </span>
      <span className="figures text-[11px] normal-case tracking-normal text-ice-400">
        {formatElapsed(playback.currentTs - range.start)} / {formatElapsed(range.end - range.start)}
      </span>

      {session !== null && (
        <span className="normal-case tracking-normal text-ice-400" title="session identity">
          {session.repoName}
          {fileName !== null && <span className="figures text-ice-400"> · {fileName}</span>}
        </span>
      )}

      <button
        type="button"
        onClick={() => selectSession(null)}
        className="ml-auto rounded border border-ice-700 px-2 py-0.5 normal-case tracking-normal text-ice-200 hover:border-ice-400 hover:text-ice-050"
      >
        Exit to live
      </button>
    </div>
  )
}
