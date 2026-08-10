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
 * 3. **It cannot produce a launch line.** `envRecipe`, `launchArgv` and
 *    `continueArgv` throw {@link HarnessNotImplementedError}. A plausible-looking
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
 */

interface DeclaredHarness {
  id: HarnessId
  displayName: string
  /**
   * The executable name, only where this repo actually records one. `null`
   * means nobody has written down what the binary is called, so PATH cannot
   * honestly be searched for it.
   */
  command: string | null
  reason: string
  whatItWouldTake: string
  /** Used when {@link command} is `null` — why the name is not known. */
  unnamedReason?: string
}

const DECLARED: readonly DeclaredHarness[] = [
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    // Named as an adapter target in docs/research/2026-08-05-agnostic-adapters-spike.md
    // and nowhere else — the note names the harness, never its binary.
    command: null,
    unnamedReason:
      'this repo records no executable name for OpenClaw — it appears as an adapter target in the agnostic-adapters ' +
      'spike and nowhere else. Searching PATH for a name this lane invented would report a confident "absent" about ' +
      'a spelling nobody verified, which is worse than admitting the name is unknown',
    reason:
      'no capture, and no telemetry or session-file surface recorded anywhere in this repo — there is nothing to ' +
      'write an adapter against beyond the name',
    whatItWouldTake:
      'a capture: the executable name, whether it emits OTLP or writes session files, and whether it has a resume ' +
      'verb at all. prd-15 ruling 4 shared conformance suite, then an adapter',
  },
  {
    id: 'pi',
    displayName: 'pi',
    // The one thing this repo does record: `AGENT_COMMANDS` in
    // collectors/sessionlog/process-probe.ts lists 'pi' as an agent argv[0].
    command: 'pi',
    reason:
      'named in prd-15 ruling 3 and listed in the process probe\'s AGENT_COMMANDS, so a running pi is *seen* — but ' +
      'it is captured nowhere (prd-26: "pi, named in prd-15 ruling 3 and captured nowhere"), so its telemetry ' +
      'surface, its session-file dialect and its continuity verb are all unknown',
    whatItWouldTake:
      'a capture of a pi session: what it exports, where it writes, and whether it can be resumed — then a grammar, ' +
      'then this adapter',
  },
  {
    id: 'shell',
    displayName: 'a bare shell',
    command: null,
    unnamedReason:
      'a bare shell is not one executable — it is bash, zsh, fish, pwsh or whatever the operator uses — so there is ' +
      'no single name to search PATH for, and finding one would not answer the question anyway',
    reason:
      'a bare shell is not a conductor. It emits no telemetry, keeps no session transcript this instrument can ' +
      'read, and has no continuity verb — there is no "relaunch it with continuity" to offer, because there is no ' +
      'conversation to continue. Relaunching a shell inside a wired envelope instruments the shell, not the work ' +
      'done in it',
    whatItWouldTake:
      'a different mechanism entirely rather than an adapter — wrapping the terminal (the pty-wrap route sketched in ' +
      'the agnostic-adapters spike), which is a separate decision with its own blast radius',
  },
]

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
  }
}

/** Every declared-not-implemented harness, in the order {@link DECLARED} lists them (alphabetical by id). */
export const declaredAdapters: readonly HarnessAdapter[] = DECLARED.map(declaredAdapter)
