import { useSyncExternalStore } from 'react'

/**
 * ONE SEARCH OVER THE LOADED SESSION (prd-31 ruling 4 and S3, #559).
 *
 * ## The three refusals this module is built out of
 *
 * **Never a panel.** prd-13 ruling 1's standing refusal, restated by ruling 4.
 * There is no `panels/search/index.tsx` here and there must never be one: a
 * search that took a row in the curated order would compete with the scene for
 * the same viewport it exists to help you read. What this directory holds is a
 * *store* and a *field* — chrome over the fold, mounted by the surfaces that
 * already have a home.
 *
 * **No server route, no index.** S3's data source is "the fold, client-side".
 * A read seam would need prd-29's gate, and this feature adds no `/api/` string
 * anywhere — asserted by `session.test.ts`, over this whole directory and every
 * file that consumes it, because "we did not add a fetch" is exactly the kind
 * of claim that stops being true one commit later.
 *
 * **A filtered view always declares what it hid, and how much.** Law 12 at list
 * altitude, and the reason this module owns {@link hiddenLine} rather than
 * leaving each surface to phrase its own: three surfaces filtering with three
 * different sentences is how "12 hidden" and "showing 4" end up on the same
 * screen meaning the same thing. One sentence, one place.
 *
 * ## Why a module store rather than a React context
 *
 * The query has to be readable by the conversation (in the run view, at
 * `/lane/:handle`), the feed and the trace (in the dock, on the balcony) — three
 * surfaces that share no common ancestor below the router. A provider spanning
 * them would have to be mounted at the composition root, which is a file this
 * lane's fence does not cover; a module store with `useSyncExternalStore` is the
 * idiom `app/router.ts` already uses for exactly the same reason, and it needs
 * no provider at all.
 *
 * It is deliberately **not persisted**. A stored search would mean opening the
 * instrument to a filtered fleet with no memory of having asked for one — the
 * "was that everything?" failure the evidence-bearing register exists to never
 * provoke — and `settings/registry.ts` would have to declare a key for it
 * (prd-35 ruling 2). A query is a thing you are doing, not a thing you have set.
 */

let query = ''
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): string {
  return query
}

/** What is being searched for right now, or `''` for "nothing is filtered". */
export function sessionQuery(): string {
  return query
}

/** Set the one query. `''` clears it — there is no separate "off" state to get out of step. */
export function setSessionQuery(next: string): void {
  if (next === query) return
  query = next
  notify()
}

/**
 * The query, as React state. Every surface reads the same one, so a filter set
 * in the dock is already in force on the conversation — which is what "one
 * search over the loaded session" has to mean structurally rather than by
 * description.
 */
export function useSessionQuery(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * Whether `haystack` matches the query.
 *
 * Case-insensitive substring, and deliberately nothing cleverer. A regex would
 * turn a stray `(` in a lane name into a thrown render; fuzzy matching would
 * make the hidden count unexplainable ("why is that one still here?"). The
 * whole feature is a person remembering part of a line, so plain containment is
 * both what they mean and the only rule that can be stated in one sentence
 * beside the count.
 *
 * An empty query matches everything, so an unfiltered surface takes the same
 * path as a filtered one and cannot drift from it.
 */
export function matchesQuery(haystack: string, q: string): boolean {
  if (q === '') return true
  return haystack.toLowerCase().includes(q.toLowerCase())
}

/**
 * Filters `items` by whatever text `textOf` says they carry, and reports what
 * was hidden **in the same call**.
 *
 * The pairing is the point: a surface cannot filter through this helper and
 * forget to declare the count, because the count comes back with the list. That
 * is a structural version of ruling 4's requirement rather than a convention
 * three call sites are trusted to remember.
 */
export interface FilterResult<T> {
  shown: T[]
  /** How many of `items` the query removed. Zero when nothing is filtered. */
  hidden: number
  /** True while a query is in force at all — distinct from `hidden === 0`. */
  filtering: boolean
}

export function filterByQuery<T>(
  items: readonly T[],
  q: string,
  textOf: (item: T) => string,
): FilterResult<T> {
  if (q === '') return { shown: [...items], hidden: 0, filtering: false }
  const shown = items.filter((item) => matchesQuery(textOf(item), q))
  return { shown, hidden: items.length - shown.length, filtering: true }
}

/**
 * THE DECLARATION (ruling 4: "a filtered view declares itself and its hidden
 * count — law 12 at list altitude").
 *
 * `null` when nothing is filtered, so a surface renders no line at all rather
 * than a reassuring "0 hidden" that is noise on every unfiltered screen.
 *
 * The zero-match case says **what was searched and where** (S3's *no matches*
 * state) rather than "no results": "nothing here matches X" and "X is not in
 * this session" are different claims, and only the first is one this feature is
 * entitled to make — it can only see the loaded session.
 */
export function hiddenLine(result: Pick<FilterResult<unknown>, 'hidden' | 'filtering'>, options: {
  /** What this surface holds, plural — "turns", "events", "interactions". */
  noun: string
  /** The query, quoted back so the reader can see what they are looking at. */
  query: string
  /** How many are on screen. */
  shown: number
}): string | null {
  if (!result.filtering) return null
  if (options.shown === 0) {
    return `NO ${options.noun.toUpperCase()} MATCH “${options.query}” — ${result.hidden} ${options.noun} in the loaded session were searched and none of them contains it.`
  }
  return `${options.shown} of ${options.shown + result.hidden} ${options.noun} — ${result.hidden} hidden by “${options.query}”.`
}
