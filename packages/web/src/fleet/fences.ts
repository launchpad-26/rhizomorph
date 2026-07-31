/**
 * Lane geography (prd3 ruling 19) — the prd's one data addition.
 *
 * At dispatch the conductor writes `.swarm/lanes.json`: handle → fence globs →
 * issue → model. The server serves it at `/api/lanes` (#76). Off-fence
 * detection falls out of it: a lane's recently-touched files are matched
 * against its own fence, and anything that matches somebody *else's* fence
 * instead is a trespass with a named victim.
 *
 * **A fence is a contract, never a guess.** Nothing here infers a fence from a
 * lane name, a branch prefix or where a lane has already committed. Accusing a
 * lane of trespass on an invented fence would be worse than saying nothing:
 * the operator would learn to ignore the flag. When the manifest is absent the
 * detector is simply unavailable and the gap voice says so (law 12), which is
 * why {@link parseLaneManifest} returns `null` rather than a best effort.
 */

export interface LaneFence {
  /** The workmux handle the conductor dispatched under. */
  handle: string
  /** Glob patterns, repo-relative — `packages/core/**` style. */
  fence: string[]
  issue: string | null
  model: string | null
}

/** handle → its fence. The whole of `.swarm/lanes.json`, validated. */
export type LaneManifest = Record<string, LaneFence>

export interface Trespass {
  path: string
  /** The lane whose fence claims this path, when exactly one does. */
  victim: string | null
}

/**
 * Git reports paths relative to the repo root already, so this is a guard
 * against an absolute path sneaking in from a dirty-file payload rather than a
 * real normalisation step.
 */
export function repoRelative(path: string): string {
  return path.replace(/^\/+/, '')
}

const regexCache = new Map<string, RegExp>()

/**
 * Minimal glob matcher: `**` crosses directory separators, `*` does not, `?` is
 * one character, and `a/**` also matches `a` itself. Small enough to read at a
 * glance on purpose — a fence is an accusation, so its matcher should be
 * inspectable rather than delegated to a dependency.
 */
export function globMatches(pattern: string, path: string): boolean {
  return globRegex(pattern).test(path)
}

function globRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern)
  if (cached !== undefined) return cached

  let source = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `a/**/b` must match `a/b` — `**/` may stand for zero directories.
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  source += '$'

  const regex = new RegExp(source)
  regexCache.set(pattern, regex)
  return regex
}

/** True when the path sits inside the lane's declared fence. */
export function insideFence(fence: LaneFence, path: string): boolean {
  const relative = repoRelative(path)
  return fence.fence.some((pattern) => globMatches(pattern, relative))
}

/**
 * Files this lane touched that its own fence does not claim, each attributed to
 * the lane whose fence *does* claim it. A path claimed by nobody is still a
 * trespass — it is outside the fence the lane agreed to — but has no victim to
 * name, and a path claimed by several lanes has no single victim either.
 *
 * A handle the manifest does not mention yields nothing at all: an
 * undispatched lane never agreed to a fence, so it cannot have crossed one.
 */
export function findTrespasses(
  manifest: LaneManifest,
  handle: string,
  touched: readonly string[],
): Trespass[] {
  const own = manifest[handle]
  if (own === undefined) return []

  const trespasses: Trespass[] = []
  const seen = new Set<string>()

  for (const raw of touched) {
    const path = repoRelative(raw)
    if (seen.has(path) || insideFence(own, path)) continue
    seen.add(path)

    const claimants = Object.values(manifest)
      .filter((fence) => fence.handle !== handle && insideFence(fence, path))
      .map((fence) => fence.handle)

    trespasses.push({ path, victim: claimants.length === 1 ? (claimants[0] as string) : null })
  }

  return trespasses.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Validate `/api/lanes`' payload into a manifest, or `null` when it is not one.
 *
 * Hand-rolled rather than schema-driven because this is the *consumer* side of
 * a contract core does not own, and because the failure mode has to be a flat
 * "no manifest" — a half-parsed manifest would fence some lanes and silently
 * un-fence others, which reads on screen as "those lanes are behaving".
 *
 * Accepts either the bare object (`{ "<handle>": {...} }`) or the `{ lanes: … }`
 * envelope the API is expected to serve, so a shape decision on #76 cannot
 * strand this side of the wire.
 */
export function parseLaneManifest(value: unknown): LaneManifest | null {
  if (value === null || typeof value !== 'object') return null

  const envelope = value as { lanes?: unknown }
  const raw: unknown = envelope.lanes !== undefined ? envelope.lanes : value
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null

  const manifest: LaneManifest = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>

    const handle = typeof record.handle === 'string' && record.handle.length > 0 ? record.handle : key
    if (handle.length === 0) return null

    const fence = record.fence
    if (!Array.isArray(fence)) return null
    if (!fence.every((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)) {
      return null
    }

    manifest[key] = {
      handle,
      fence: [...fence],
      issue: typeof record.issue === 'string' ? record.issue : null,
      model: typeof record.model === 'string' ? record.model : null,
    }
  }

  // An empty manifest is not a manifest: it would silently mean "every lane is
  // unfenced", which is exactly the reassurance the gap voice exists to refuse.
  return Object.keys(manifest).length === 0 ? null : manifest
}
