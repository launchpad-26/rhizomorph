import type { RhizomorphEvent } from './index.js'

/**
 * THE MIGRATION CHOKEPOINT — prd17 ruling 3, item 3.
 *
 * An identity function sitting between parse and reduce that EVERY event flows
 * through, in both the live path and the replay path. It does nothing today.
 * It exists so that the day a past era's event needs rewriting for the current
 * reducer — a field renamed, a payload widened, a type split in two — there is
 * already one place that change lives, reached by every fold that has ever
 * existed, rather than a migration bolted onto whichever call site somebody
 * remembered.
 *
 * **Why it is reserved now rather than added later.** Retrofitting a chokepoint
 * is the expensive half: by then there are folds in the live stream, in replay,
 * in the record reader, in the era corpus, and in a hundred tests, and the
 * migration has to find all of them. Reserving it while it is still an identity
 * function costs one call and pins the guarantee with a law test instead.
 *
 * **Where it is wired.** Inside {@link reduce} (`../reduce.ts`), which is the
 * one function both paths bottom out in — live arrival folds through it per
 * SSE event, replay folds through it per keyframe and per scrub step. That
 * makes "every event is upcast" true by construction rather than by every
 * future call site remembering; `reduce.test.ts` holds both fold shapes to it,
 * and `packages/web/src/replay/replayFold.test.ts` holds the real replay path.
 *
 * **What it must never become.** Not a validator (parse already refused, or
 * counted the line as an honest unknown — see `parseEventLenient`), not a
 * filter (dropping an event here is the silent skip this ruling exists to
 * abolish), and not a place to enrich an event with anything the log did not
 * record. It rewrites an old shape into the current one, and nothing else.
 */
export function upcast(event: RhizomorphEvent): RhizomorphEvent {
  observer?.(event)
  return event
}

/**
 * The one thing a caller can observe about the chokepoint: that an event went
 * through it. Test-only, and deliberately the *only* observable — an identity
 * function is otherwise indistinguishable from no function at all, so a law
 * test asserting "both paths call upcast" would have nothing to assert against
 * and would silently pass forever once somebody removed the call.
 *
 * A single slot rather than a listener list: two concurrent observers would be
 * two tests racing on module state, and this is a seam for one law test at a
 * time. Installing a second while one is live throws instead of quietly
 * shadowing it.
 */
type UpcastObserver = (event: RhizomorphEvent) => void

let observer: UpcastObserver | null = null

/**
 * Installs `fn` as the chokepoint's observer and returns its disposer. Always
 * dispose (a `try/finally`, or vitest's `onTestFinished`) — a leaked observer
 * outlives its test and makes the next one's counts wrong.
 */
export function observeUpcast(fn: UpcastObserver): () => void {
  if (observer !== null) {
    throw new Error('upcast already has an observer installed — dispose the first one')
  }
  observer = fn
  return () => {
    if (observer === fn) observer = null
  }
}
