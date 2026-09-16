import type { SummonsCondition } from './summons.js'

/**
 * prd-57 ruling 5 and its 2026-09-15 amendment — CRASHED, the raiser.
 *
 * A lane whose agent process vanished without a session end is crashed. That is
 * the fact `done` used to swallow: `collectors/sessionlog/lane-state.ts` reaches
 * `gone` when a lane goes silent and its process probe says the process is
 * absent, and its own doc records why it publishes nothing for that state — the
 * only word it could publish is `done`, and *"publishing `done` for a lane whose
 * process died would convert a crash into a success."* So it withholds, and the
 * fleet says it does not know, which is weaker and true.
 *
 * **This is the layer prd-15 ruling 1 sent that call downstream to.** The organ
 * could not tell done from died because it only had silence. This can, because
 * the process witness (ruling 1) puts the actor's own death in the fold: a
 * `process.gone` following a `process.seen` for the same actor is a run that
 * ended, and whether a human should care is answered by what the lane declared
 * before it did.
 *
 * ## Why this is a summons kind and not a `diagnose` pathology
 *
 * `fleet/diagnose.ts` derives its five from a `Lane`'s own shape — ages, cycles,
 * spend, fence. Every one is a judgement about a lane that is still there.
 * Crashed is not that: it is an EDGE, and the fact it turns on (an actor that
 * was seen and is now gone) is already recorded rather than inferred. Putting it
 * in `diagnose` would mean re-deciding every tick whether a death that happened
 * once is still true.
 *
 * So it takes {@link SummonsCondition}'s route instead, and `crashed` joins
 * `PathologyKind` for the vocabulary that route already speaks — rank, word,
 * reason, remedy, sigil, hue. Nothing about that union is `diagnose`-only.
 *
 * ## Why there is no `diffCrashed`
 *
 * The issue asks for a raiser shaped exactly like `summons.ts`'s, and the most
 * faithful reading of that is not a second copy of `diffSummons`. The edge
 * trigger is already written, already tested, and already handles the two cases
 * that are easy to get wrong — a condition still true this tick raises nothing,
 * and a condition whose raise predates a restart still clears exactly once.
 *
 * A `diffCrashed` would be that logic again, drifting from the first copy the
 * moment either changed. This file answers the only question `diffSummons`
 * cannot: **which lanes are crashed right now.** `poll-loop.ts` appends the
 * answer to the conditions it already collects, and one edge-trigger serves
 * both — which is also what makes a crashed lane's summons clear the same way
 * every other one does.
 *
 * ## Pure over plain data, like its sibling
 *
 * No clock read, no I/O, no `Fleet` import. `poll-loop.ts` is the one place that
 * reads `recorder.foldSoFar()` and builds the fleet; it turns lanes into the
 * three-field {@link CrashCandidate} rows this asks for, which is what lets
 * these tests build a fixture instead of a forty-field `Lane`.
 */

/** One actor of a lane's, as much of it as this raiser reads. */
export interface CrashActor {
  /** `pid:startedAt` — the identity of one RUN. A recycled pid is a different actor. */
  readonly key: string
  /** Non-null exactly when the witness saw this run end. The fact crashed is reached from. */
  readonly goneAt: number | null
  /**
   * Why it went. `recycled` means the pid came back under a different run — which
   * is a fact about pid reuse, not about this run's death, and is why the reason
   * is read rather than assumed from `goneAt` alone.
   */
  readonly goneReason: 'absent' | 'recycled' | null
  /** When the witness first spoke about it. A `gone` with no `seen` before it is not a death this saw. */
  readonly seenAt: number
}

/** One lane, as much of it as this raiser reads. */
export interface CrashCandidate {
  /** `Lane.id` — the summons point's other half. */
  readonly lane: string
  readonly actors: readonly CrashActor[]
  /**
   * What the lane last DECLARED, and when.
   *
   * `null` when nothing ever declared anything — which is the ordinary case for
   * a lane the observer discovered rather than launched, and is not a reason to
   * withhold the call. A lane that never said a word and whose process died is
   * exactly the case ruling 5 exists for.
   */
  readonly declared: { readonly status: string; readonly at: number } | null
}

/**
 * The words that END a session, as opposed to pausing one.
 *
 * `done` is the harness saying the work finished; `stopped` is ruling 5's word
 * for a `SessionEnd` hook firing — the agent's own process announcing its exit
 * before it made it. Either means the death that followed was expected, and an
 * expected death is not a crash.
 *
 * `crashed` is deliberately NOT here even though it is a status word: this
 * raiser must not read its own previous verdict as evidence that the verdict no
 * longer applies.
 */
export const SESSION_END_STATUSES: readonly string[] = ['done', 'stopped']

/** One terse clause naming the recorded facts behind the call — never a bare label. */
function evidenceFor(actor: CrashActor, declared: CrashCandidate['declared']): string {
  const said = declared === null ? 'nothing ever declared a status' : `last declared "${declared.status}"`
  return `the agent process ended without a session end — ${said}`
}

/**
 * Which lanes are crashed, this tick.
 *
 * A lane is crashed when one of its actors has BOTH been seen and gone, with no
 * session end declared between the two. Three clauses, and each is a case that
 * would otherwise be wrong:
 *
 * 1. **`goneAt` non-null.** Silence alone never reaches here — there is no age
 *    threshold in this file and no clock read, so no amount of quiet produces a
 *    crash. That is the falsifier the issue names, and it is structural rather
 *    than tested-around: this function cannot express "it has been quiet for N
 *    minutes" because it is not given an N or a now.
 * 2. **`seenAt <= goneAt`.** A `gone` for an actor this witness never saw alive
 *    is not a death it can attest to. The fold already refuses to materialise an
 *    actor from a `gone` alone, so this is belt-and-braces — but it is the
 *    clause that says the pair is what matters, not the second half of it.
 * 3. **No session end between.** A lane that declared `done` and then had its
 *    process disappear did exactly what it was supposed to. The comparison is
 *    against `goneAt`, not against now: a `done` declared AFTER the death is not
 *    evidence the death was clean — it is a later fact about a different thing,
 *    and treating it as absolution would let a stale roster entry erase a real
 *    crash.
 *
 * `recycled` is excluded, and this is the clause a reader is most likely to get
 * backwards. It does not mean the run survived — the run is over either way.
 * It means the witness stopped being able to tell: the pid came back under a
 * different `startedAt`, so what it observed is pid reuse rather than an
 * observed death. ADR-0010's posture is to declare the gap, not rank a guess,
 * and a crash summons is an interruption — the one thing that must not be
 * raised on a maybe.
 */
export function crashedConditions(candidates: readonly CrashCandidate[]): SummonsCondition[] {
  const conditions: SummonsCondition[] = []

  for (const candidate of candidates) {
    for (const actor of candidate.actors) {
      if (actor.goneAt === null) continue
      if (actor.goneReason === 'recycled') continue
      if (actor.seenAt > actor.goneAt) continue
      if (
        candidate.declared !== null &&
        SESSION_END_STATUSES.includes(candidate.declared.status) &&
        candidate.declared.at <= actor.goneAt
      ) {
        continue
      }

      conditions.push({
        lane: candidate.lane,
        kind: 'crashed',
        // The instant the run ended, not the instant this tick noticed — the
        // same reason `SummonsRaisedPayload.raisedAt` is its own field.
        since: actor.goneAt,
        detail: evidenceFor(actor, candidate.declared),
      })
      // One crash per lane, not one per actor. A conductor and its subagents die
      // together far more often than separately, and a lane raising six
      // identical summons is six interruptions for one event. The first is the
      // earliest, because `poll-loop.ts` hands the actors in fold order.
      break
    }
  }

  return conditions
}
