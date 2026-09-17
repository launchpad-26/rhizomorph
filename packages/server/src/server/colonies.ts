import type { AgentProcess } from '@rhizomorph/core'
import { repoSlug } from '../log/paths.js'
import type { RepoRootResolver } from '../paths/repo-root.js'

/**
 * A colony is a repo this instrument has seen an agent working in — prd-58
 * ruling 1.
 *
 * **The identity is not new.** `repoSlug(repoPath)` is prd-16's recorder slug —
 * a sanitized basename plus a short hash of the absolute path — and ruling 2
 * names it when it says each colony records "under its own slug, exactly as
 * prd-16 writes it". Inventing a second identity here would mean the thing the
 * selector shows and the thing the recorder writes could disagree, which is the
 * class of defect prd-27's "assembled once" exists to prevent.
 */
export interface Colony {
  /** `repoSlug(path)`. Stable across runs, and the recorder's directory name. */
  readonly id: string
  /** The repo root, canonical. Comparable by plain string equality. */
  readonly path: string
  /**
   * True for the repo the instrument was started in.
   *
   * Ruling 1: *"an operator may still pin one, and starting inside a repo pins
   * that repo first — so today's behaviour is the zero-configuration case of
   * the new one."* This is that pin, and wave 0 ruled it means ORDERING and
   * nothing else: a pinned colony sorts first and is watched on exactly the
   * same terms as any other.
   */
  readonly pinned: boolean
}

/**
 * The watched set, discovered from where the agents actually are.
 *
 * **Discovered, never declared.** The process witness already enumerates every
 * roster-matched agent on the machine regardless of where it is — it was only
 * ever narrowed to one repo by a boot argument. This turns that machine-wide
 * reading into the set of repos worth recording, which is the whole of ruling
 * 1's first half.
 *
 * Three facts this deliberately does NOT infer:
 *
 * - **An actor in no repository yields no colony.** It is not lost — it stays
 *   in `state.processes`, and ruling 6 gives it a home in wave 3 — but it never
 *   invents one. ADR-0010: declare the gap.
 * - **An actor the witness could not place yields no colony.** On Windows the
 *   process leg reports no cwd for any process, so `worktreePath` is null for
 *   every actor and this discovers only the pinned colony. That is a stated
 *   platform gap, not a silent empty answer.
 * - **An empty repo is not a colony.** Wave 0 ruled there is no pinning act: a
 *   repo with nothing running in it is one this design never learns about, so
 *   the watched set never contains a colony with no actor except the pin.
 */
export interface ColonyDiscovery {
  /** The watched set for this reading of the process table. Pinned colony first, then by id. */
  discover(actors: readonly AgentProcess[]): Promise<Colony[]>
}

export interface ColonyDiscoveryOptions {
  /** The repo the instrument was started in, canonical — pinned, and always present. */
  readonly pinnedRepoPath: string
  readonly resolver: RepoRootResolver
}

export function createColonyDiscovery(options: ColonyDiscoveryOptions): ColonyDiscovery {
  const { pinnedRepoPath, resolver } = options

  return {
    async discover(actors: readonly AgentProcess[]): Promise<Colony[]> {
      // The pin is in the set before any actor is read, because it is the
      // zero-configuration case: an operator who starts inside a repo and runs
      // nothing yet still sees that repo. It is the ONE colony that does not
      // need an actor to exist.
      const byPath = new Map<string, Colony>([[pinnedRepoPath, colonyAt(pinnedRepoPath, true)]])

      for (const actor of actors) {
        // A `worktreePath` the witness could not resolve is not a placement.
        // Nothing is guessed from a pid or a dialect.
        if (actor.worktreePath === null) continue
        const root = await resolver.resolve(actor.worktreePath)
        if (root === null) continue
        if (byPath.has(root)) continue
        byPath.set(root, colonyAt(root, false))
      }

      // Pinned first — that is what ruling 1's pin means and all it means —
      // then by id, so the order is a fact about the set rather than about the
      // order the process table happened to be read in. A selector whose rows
      // jump between ticks is a selector nobody can click.
      return [...byPath.values()].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
    },
  }
}

function colonyAt(repoPath: string, pinned: boolean): Colony {
  return { id: repoSlug(repoPath), path: repoPath, pinned }
}
