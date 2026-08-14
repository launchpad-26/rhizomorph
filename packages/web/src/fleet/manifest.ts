import { useEffect, useState } from 'react'
import { parseLaneManifest, type LaneManifest } from '@rhizomorph/core'

/**
 * Fetching the lane manifest the conductor wrote at dispatch (ruling 19),
 * served by `/api/lanes` (#76).
 *
 * The only two outcomes are *a validated manifest* and *no manifest*. There is
 * deliberately no third "partial" or "inferred" state: a fence is what makes an
 * off-fence accusation legitimate, so a manifest we could not fully validate
 * must not fence half the fleet and silently leave the rest unjudged. Absence
 * becomes a named gap in the fleet object (law 12), never a guess.
 */

export type FetchLike = (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

export const LANES_URL = '/api/lanes'

export interface LaneManifestState {
  manifest: LaneManifest | null
  /**
   * `loading` until the first answer arrives; `absent` covers every way of not
   * having one — endpoint missing (a server older than #76), request failed,
   * body not a manifest. They are the same fact to a reader: off-fence
   * detection is unavailable, and the gap line says how to fix it.
   */
  status: 'loading' | 'ready' | 'absent'
}

const ABSENT: LaneManifestState = { manifest: null, status: 'absent' }

/** The default fetcher, or null where there is no `fetch` to call (some test envs). */
function defaultFetch(): FetchLike | null {
  return typeof globalThis.fetch === 'function'
    ? ((input: string) => globalThis.fetch(input)) as FetchLike
    : null
}

export async function loadLaneManifest(fetchImpl?: FetchLike): Promise<LaneManifestState> {
  const impl = fetchImpl ?? defaultFetch()
  if (impl === null) return ABSENT

  try {
    const response = await impl(LANES_URL)
    if (!response.ok) return ABSENT
    const manifest = parseLaneManifest(await response.json())
    return manifest === null ? ABSENT : { manifest, status: 'ready' }
  } catch {
    // A server without #76 answers 404, and a server that is not there at all
    // throws. Both mean the same thing to the instrument.
    return ABSENT
  }
}

/**
 * The manifest for the current source. `enabled: false` (a synthetic fixture is
 * driving, and brings its own manifest) skips the request entirely rather than
 * racing a fetch whose answer would be discarded.
 *
 * `repoPath` is the repo the fold currently describes
 * (`app/streamState.ts`'s `foldedRepoPath`), and it is a **dependency, not
 * decoration**: it is what makes the manifest re-asked when the dashboard is
 * retargeted at another repository (#390 review).
 *
 * Without it the manifest was fetched once and never again, because the only
 * things that could re-run this effect were `enabled` (`source === 'live'`,
 * unchanged by a retarget) and `fetchImpl` (a stable prop). The fold beneath
 * it reset correctly while this did not, so repo B's freshly-reset lanes were
 * judged against repo A's fences — and lane ids, branches and handles
 * (`dev-1`, `main`) recur across unrelated repos, so that is not a
 * hypothetical mismatch: either a handle collides and repo A's fence silently
 * attaches to repo B's lane, or it doesn't and repo B's lanes are measured
 * against a fence file describing somewhere else. Same class as #370 — state
 * that never went through the fold cannot be fixed by resetting the fold, so
 * it has to be invalidated on the same key the fold resets on.
 *
 * A boot therefore asks twice: once at mount with no repo named yet, once when
 * `session.started` names one. That is one extra local request per page load,
 * and it is the whole cost of the invalidation being keyed rather than
 * inferred. Gating the first request on a known repo instead would leave
 * `status` at `loading` forever for any source that never names one, which is
 * a worse answer than asking twice.
 */
export function useLaneManifest(
  enabled: boolean,
  fetchImpl: FetchLike | undefined,
  repoPath: string | null,
): LaneManifestState {
  const [state, setState] = useState<LaneManifestState>(() =>
    enabled ? { manifest: null, status: 'loading' } : ABSENT,
  )

  useEffect(() => {
    if (!enabled) {
      setState(ABSENT)
      return
    }

    let live = true
    setState({ manifest: null, status: 'loading' })
    void loadLaneManifest(fetchImpl).then((next) => {
      if (live) setState(next)
    })

    return () => {
      live = false
    }
  }, [enabled, fetchImpl, repoPath])

  return state
}
