import { useMode } from '../app/ModeContext.js'
import { STREAM_SOURCE_KEYS, type StreamSource, useStream } from '../app/StreamContext.js'
import { envCommand, resumeCommand, type InstrumentableSession } from './links.js'
import type { SessionPreview } from './meta.js'

/**
 * THE SAMPLE-FLEET AFFORDANCE (prd-19 ruling 6, wave 3, #259).
 *
 * `useStream()` already drives three logs — `live`, `fleet20` (twenty
 * synthetic lanes) and `pathology` (one lane per staged pathology) — but
 * until now the only way to reach the last two was pressing 1 / 2 / 3 on the
 * keyboard (`StreamContext.tsx`'s `useFixtureKeys`), an undiscoverable
 * secret. This file adds no state of its own and reaches into no stream
 * machinery: it is a thin read of the same `setSource`/`provenance` every
 * other surface already reads, wired to a button instead of a keypress.
 *
 * Ruling 6's law, restated: a fixture must never pass as live data. So
 * whenever `source !== 'live'` this control *becomes* the banner — the
 * fixture's own `provenance` string, verbatim, beside the one button that
 * undoes it — rather than a toast that fades or scrolls out of view.
 * `index.tsx` mounts it in the header, which never scrolls, on purpose: this
 * is meant to be a persistent tell, not a one-time notice.
 *
 * **Replay is not one of the three logs, and this control stands down for
 * it.** `StreamContext.tsx`'s replay branch returns *before* its fixture
 * branch, so while a recording is loaded `setSource('fleet20')` changes
 * nothing about the fold and `provenance` reads `replay · recorded session`
 * whatever `source` says. Rendering the button there would offer a sample
 * fleet that never arrives and a "return to live" that does not return to
 * live — and the page's own definition of live is `mode === 'live' && source
 * === 'live'` (`index.tsx`), which this control now shares rather than
 * contradicts. The provenance bar directly below already names the recording,
 * so nothing goes unsaid by standing down.
 *
 * The key-doc line (#411) renders in *both* remaining branches, not just the
 * live one. `STREAM_SOURCE_KEYS`' keys work regardless of which source is
 * driving — `useFixtureKeys` never gates on `source` — so an operator sitting
 * in `pathology` already has a route straight to `fleet20`; the bug was that
 * the banner branch didn't say so, leaving "return to live" as the only
 * *offered* way out of a fold where the documentation is needed most.
 */
export function SampleFleetControl() {
  const { source, setSource, provenance } = useStream()
  const mode = useMode()

  if (mode === 'replay') return null

  if (source !== 'live') {
    return (
      <div data-testid="connect-sample" className="flex shrink-0 items-center gap-2">
        <span data-testid="connect-sample-banner" className="figures text-[11px] font-semibold text-notice">
          reading {provenance} — not the live log
        </span>
        <button
          type="button"
          data-testid="connect-sample-return"
          onClick={() => setSource('live')}
          className="shrink-0 rounded border border-notice/60 px-2 py-1 text-[10px] uppercase tracking-wider text-notice hover:border-notice hover:text-ice-100"
        >
          return to live
        </button>
        {/* The route onward, not just back: pressing 2 or 3 works from here exactly as it does from live. */}
        <span data-testid="connect-sample-keys" className="text-[10px] text-ice-400">
          or press {keyDoc()}
        </span>
      </div>
    )
  }

  return (
    <div data-testid="connect-sample" className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        data-testid="connect-sample-activate"
        onClick={() => setSource('fleet20')}
        className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
      >
        view a sample fleet
      </button>
      {/* The secret this control replaces, named rather than left for someone to stumble on. */}
      <span data-testid="connect-sample-keys" className="text-[10px] text-ice-400">
        or press {keyDoc()}
      </span>
    </div>
  )
}

/**
 * THE SAMPLE FLEET'S OWN UNINSTRUMENTED SESSIONS (prd-20 w7, #520).
 *
 * The 20-lane fixture is deliberately ALL CLEAR (`fleet/fixtures.ts`: "nothing
 * is staged in it"), and the uninstrumented row is further cleared outright by
 * `links.ts`'s own fixture law — `unproven()` drops the enumeration, because a
 * button and a `claude --resume` for a synthetic session id would be ruling 6's
 * forbidden costume in its worst form. So the sample page would otherwise show
 * this surface as an empty space, which is the one thing a demonstration must
 * not do: the enumeration is exactly what a stranger came to `/connect` to
 * understand.
 *
 * These sessions are therefore the fixture's own, declared here beside the
 * control that summons the fixture, and they are the SAME SHAPE a real witness
 * takes — commands included — so the page renders them through one component
 * with no fixture-only branch in its data. What the fixture never gets is the
 * ACT: `index.tsx` renders these without the instrument button and without a
 * copy block, and says why in the panel itself. A fixture may show what the
 * surface looks like; it may never hand anyone something to run.
 */
export interface SampleUninstrumented {
  sessions: InstrumentableSession[]
  /** Seeded, never fetched — a request for a session id that exists only in a fixture is a request with no honest answer. */
  previews: Record<string, SessionPreview>
}

/**
 * The two shapes the PRD is actually about: the conductor nobody instrumented
 * (the operator report of 2026-08-07), and one ordinary lane beside it so the
 * `<select>` has something to select between.
 *
 * `port` is the live one, as every other command on this page interpolates it
 * — the fixture is synthetic in its lanes and its ids, not in the recipe.
 */
export function sampleUninstrumented(port: string): SampleUninstrumented {
  const conductorEnv = envCommand('conductor', 'conductor', port)
  const laneEnv = envCommand('lane-07', 'worker', port)
  return {
    sessions: [
      {
        sessionId: 'sample-conductor-0f21',
        lane: 'conductor',
        role: 'conductor',
        ageLabel: '41m00s ago',
        place: { branch: 'main', worktreeTail: 'rhizomorph' },
        resumeCommand: resumeCommand(conductorEnv, 'sample-conductor-0f21'),
        envCommand: conductorEnv,
      },
      {
        sessionId: 'sample-lane-07-b3c8',
        lane: 'lane-07',
        role: 'worker',
        ageLabel: '6m30s ago',
        place: { branch: '412-drawer-vitals', worktreeTail: '412-drawer-vitals' },
        resumeCommand: resumeCommand(laneEnv, 'sample-lane-07-b3c8'),
        envCommand: laneEnv,
      },
    ],
    previews: {
      'sample-conductor-0f21': {
        sessionId: 'sample-conductor-0f21',
        text: 'dispatch wave 4 across the three ready issues, and gate each landing yourself',
        dropped: 0,
        reason: null,
      },
      'sample-lane-07-b3c8': {
        sessionId: 'sample-lane-07-b3c8',
        text: 'the vitals strip should read the same numbers the drawer header does',
        // `0`, not a flourish: the route only ever reports a cut alongside a
        // text it actually capped, so a short preview claiming dropped
        // characters is a shape the real route cannot produce.
        dropped: 0,
        reason: null,
      },
    },
  }
}

/**
 * What each key actually does, in this instrument's own words. The `Record`
 * is exhaustive by type — a fourth source is a compile error here, not a line
 * of copy that quietly goes stale.
 */
const SOURCE_WORDS: Record<StreamSource, string> = {
  live: 'live',
  fleet20: 'sample fleet',
  pathology: 'staged pathologies',
}

/**
 * Derived from `STREAM_SOURCE_KEYS` rather than typed out beside it: the one
 * thing this line can get wrong is the mapping, and prose copied from a map
 * is prose that can disagree with it. Reading the map means it cannot.
 */
function keyDoc(): string {
  return Object.entries(STREAM_SOURCE_KEYS)
    .map(([key, id]) => `${key} ${SOURCE_WORDS[id]}`)
    .join(' · ')
}
