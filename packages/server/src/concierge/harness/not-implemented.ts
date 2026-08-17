import { DECLARED_HARNESSES, type DeclaredHarnessEntry } from '../../harness-roster.js'
import { detectHarness } from './detect.js'
import {
  HarnessNotImplementedError,
  type DetectOptions,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessId,
  type HarnessImplementation,
} from './types.js'

/**
 * The harnesses this registry names but does not implement — prd-20 ruling 4's
 * "every other harness listed as declared-not-implemented, capabilities-honesty
 * style", which is ADR-0010 applied to harnesses.
 *
 * Three things are deliberately true of every adapter below:
 *
 * 1. **It is listed.** Omitting it would hide a harness an operator is using.
 *    ADR-0010 rejected the silent default for precisely this reason: the
 *    convenient default is the dishonest one.
 * 2. **It carries its reason**, compiler-required by
 *    {@link HarnessImplementation}, plus what it would take to change — never
 *    "coming soon", which is a promise rather than a fact.
 * 3. **It cannot produce a launch line.** `envRecipe`, `launchArgv`,
 *    `continueArgv` and `resumeArgv` throw {@link HarnessNotImplementedError}. A plausible-looking
 *    argv array for a harness nobody has captured is a guess dressed as
 *    support, and this seam makes writing one impossible rather than
 *    discouraged.
 *
 * **Detection still works**, and that is the point of separating detection from
 * launching. "pi is installed on this machine, and this instrument cannot
 * instrument it" is two true statements; refusing to look would lose the first
 * one. Where even the *executable name* is unverified, detection answers
 * `unknown` rather than inventing a name and reporting a confident `absent`
 * about it.
 *
 * ## Declared here is a claim about LAUNCHING, not about being captured (#325)
 *
 * This table used to conflate the two for pi: its reason said pi was "captured
 * nowhere", which stopped being true the moment `collectors/pi/` landed a real
 * collector (#324/#540/#609) — ruling 6 forbids declaring an *implemented*
 * harness not-implemented exactly as it forbids the reverse, and a harness can
 * be genuinely observed while still being genuinely unlaunchable by this hand.
 * `harness-law.test.ts`'s "a harness cannot be declared-not-implemented for a
 * fact a merged collector contradicts" law is what keeps this honest going
 * forward: it fails the moment a `collectors/<id>/capabilities.ts` lands for a
 * harness whose reason here still claims it is uncaptured.
 */

/**
 * One declared harness as this module needs it: the roster's own entry shape,
 * with `id` narrowed to {@link HarnessId}.
 *
 * The narrowing is the pin. {@link DECLARED_HARNESSES} lives outside the
 * concierge namespace (it has to — `cli/doctor.ts` reads the same roster and
 * the namespace law grants it no edge in here), so it types its ids with a
 * union of its own. Assigning it to this type is where the compiler checks the
 * two agree: an id spelled wrong over there fails the build here, rather than
 * reaching an operator as a harness the registry has never heard of.
 */
interface DeclaredHarness extends DeclaredHarnessEntry {
  id: HarnessId
}

/**
 * The roster's declared table, held to this module's own type.
 *
 * There is no table here. #325 put one in this file and had `cli/doctor.ts`
 * parse its source text to read it, which worked in development and never once
 * in the shipped bundle — see `harness-roster.ts` for the whole account. The
 * data moved; the behaviour below did not.
 */
const DECLARED: readonly DeclaredHarness[] = DECLARED_HARNESSES

function declaredAdapter(harness: DeclaredHarness): HarnessAdapter {
  const implementation: HarnessImplementation = {
    status: 'declared',
    reason: harness.reason,
    whatItWouldTake: harness.whatItWouldTake,
  }

  const refuse = (): never => {
    throw new HarnessNotImplementedError(harness.id, harness.reason)
  }

  return {
    id: harness.id,
    displayName: harness.displayName,
    implementation,

    async detect(options: DetectOptions = {}): Promise<HarnessDetection> {
      if (harness.command === null) {
        const reason = harness.unnamedReason ?? `no executable name is recorded for ${harness.displayName}`
        return {
          harness: harness.id,
          onPath: { state: 'unknown', reason },
          running: { state: 'unknown', reason },
        }
      }
      return detectHarness(harness.id, harness.command, options)
    },

    envRecipe: refuse,
    launchArgv: refuse,
    continueArgv: refuse,
    resumeArgv: refuse,
  }
}

/** Every declared-not-implemented harness, in the order {@link DECLARED} lists them (alphabetical by id). */
export const declaredAdapters: readonly HarnessAdapter[] = DECLARED.map(declaredAdapter)
