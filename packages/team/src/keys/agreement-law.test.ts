import { describe, expect, it } from 'vitest'
import { type DoctorReport, runDoctor } from '../../deploy/doctor.js'
import { resolveTeamConfig } from '../config/config.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { mintIngestKey } from './mint.js'
import { ENV_INGEST_KEY_SHA256, ENV_PROJECT, seedProjectIngestKey } from './seed.js'

/**
 * THE SEED AND THE DOCTOR GIVE ONE ANSWER TO THE THREE STATES THEY BOTH REFUSE (#623).
 *
 * `seed.ts`'s docblock already claims this: *"`deploy/doctor.ts` prints the same sequence for the
 * same three states, so the boot refusal and the doctor line no longer disagree (prd-51 rulings 12,
 * 13)"*. Until this file, nothing held it to that — the note at the foot of `keys.test.ts` said so
 * in as many words, and left it deliberately unbuilt while `doctor.ts` was another lane's.
 *
 * It matters because the two surfaces are read by the same operator in the same incident, minutes
 * apart: the boot refuses and logs a remedy, then they run the doctor and read a remedy for the
 * same state. Two answers to one question is how an operator ends up running both and trusting
 * neither. prd-51 has shipped three defects (#543, #591, #598) whose shape is *an instruction
 * naming something that does not work on the deployment it is written for*; two instructions that
 * disagree is the next member of that family.
 *
 * ## WHY THIS IS NOT A GREP OVER TWO FILES
 *
 * Both sides are DRIVEN. The seed's three come out of {@link seedProjectIngestKey}; the doctor's
 * three come out of {@link runDoctor} — the real entry point, because `checkIngestKey` is not
 * exported and this law is not a reason to open a seam. A law that grepped the two sources for a
 * shared substring would pass when both were wrong together, which is the state this law exists to
 * detect.
 *
 * Both sides run against the SAME {@link FakeTeamStorage}, so the `otherProject` state is one world
 * seen twice rather than two fixtures that happen to rhyme.
 *
 * ## WHAT AGREEMENT MEANS HERE, AND WHAT LOST
 *
 * The compared thing is {@link commandSequence} — the ordered list of command tokens a remedy
 * names — not the string.
 *
 * - **Whole-string equality lost.** The two diagnoses legitimately differ: the doctor opens
 *   `ingest key: …` and names the project bare, the seed `JSON.stringify`s it. Requiring the
 *   sentences to match would couple voice to correctness and get this law deleted the first time
 *   somebody improved a sentence. A law that gets deleted guards nothing.
 * - **A shared-substring grep lost**, for the reason above: it reads text instead of driving
 *   behaviour, and is green when both sides are wrong.
 *
 * ## THE `cd` IS COMPARED, AND THE FIRST ANSWER ABOUT IT WAS BACKWARDS (#623)
 *
 * #623 was filed expecting `cd packages/team/deploy &&` to be voice — a difference of working
 * directory between two readers. It is not a between-surface difference at all: at the base commit
 * the seed carried the `cd` in all three arms and the doctor in two of three, the odd one out being
 * the doctor's hand-written empty-project arm. That much this law found immediately, and it is why
 * the `cd` belongs in the compared sequence.
 *
 * **Which way the six should agree is a separate question, and it was answered wrongly first.**
 * The first pass reasoned that `./init.sh` is a relative path, so the `cd` must be right and the
 * odd arm must gain one. That never asked where the reader is standing. Measured, the answer
 * inverts it — see the invariant test below, which carries the full measurement. In short: both
 * surfaces are only ever read through `docker compose`, `compose.yml` exists in exactly one
 * directory, Compose never searches downwards, and so the one cwd from which these sentences can be
 * SEEN is the one from which `cd packages/team/deploy` exits 1 and `&&` eats the rotation.
 *
 * So all six dropped the `cd` rather than one gaining it. The first pass would have converted the
 * single runnable remedy into an unrunnable one, inside the commit whose whole subject is
 * instructions that do not work where they are read. It is recorded here rather than tidied away
 * because the seductive part — a confident relative-path argument that never checked the cwd — is
 * reusable, and the next reader deserves the trap and not just the exit.
 *
 * `namesBareInitSh` in `keys.test.ts` is `/init\.sh(?!\s+--rotate-ingest-key)/` and says nothing
 * about a `cd`, so it could not have caught this in either direction — and, equally, nothing
 * existing reddened when all six dropped it. This law is the only thing holding either fact.
 *
 * ## OUT OF SCOPE, DELIBERATELY
 *
 * The doctor has six arms and the seed three. The three the doctor has and the seed cannot reach —
 * `ingest_keys` unreadable, digest has no row, digest revoked — are NOT compared. The seed runs
 * before that row exists and is the thing that would create it; it has no opinion about them and
 * must not be given one. The no-row arm is additionally contested by #604, and this law is built
 * nowhere near it so that resolving #604 does not have to move it.
 */

const NOW = 1785739192632
const THIS_PROJECT = 'acme-widgets'
const OTHER_PROJECT = 'other-project'

/**
 * The three states BOTH surfaces refuse, named once.
 *
 * The pairing is hand-made and could not be otherwise — nothing links the seed's empty-project
 * branch to the doctor's except that they describe the same deployment. What is NOT hand-made is
 * whether a pair survives {@link sharedRefusals}, which is the property the vacuity guard measures.
 */
const SHARED_STATES = ['noProject', 'badHash', 'otherProject'] as const
type SharedState = (typeof SHARED_STATES)[number]

/**
 * Every command either surface may name, spelled exactly as a remedy spells it — plus one it may
 * not, for the reason below.
 *
 * `NOT docker compose restart` is one token, negation included, for two reasons: a warning must
 * never be read as a step, and dropping the `NOT` on one side has to redden rather than leave two
 * identical-looking sequences.
 *
 * `cd packages/team/deploy` is the odd one: it is the only token here that **no remedy may
 * contain**, and it is listed so that re-adding it to one surface breaks sequence equality instead
 * of slipping past as a token this extractor cannot see. An unrecognised token cannot move a
 * sequence in either direction, so leaving it out would make the one drift this issue actually
 * shipped invisible to the comparison. Deleting it from this list reddens `THE LAW BITES`, whose
 * `cdReadded` case stops producing a different sequence — so this paragraph is enforced rather than
 * asserted. Why the `cd` is wrong in every remedy is measured on the invariant test that forbids
 * it, below; this list takes no position on that beyond being able to see it.
 */
const COMMAND_VOCABULARY = [
  'cd packages/team/deploy',
  'set RZ_TEAM_PROJECT',
  './init.sh --rotate-ingest-key',
  'docker compose up -d',
  'NOT docker compose restart',
] as const

/**
 * Substrings that prove an executable command is being named, whatever the command turns out to be.
 *
 * These are what stops {@link COMMAND_VOCABULARY} from being silently incomplete: a `docker compose
 * down` added to a remedy raises the marker count above the number of recognised tokens carrying
 * that marker, and {@link unrecognisedCommands} convicts.
 *
 * **This assertion is the only one that catches an unrecognised command, in BOTH directions.**
 * Measured, `docker compose down` inserted into ONE surface leaves sequence equality GREEN, and so
 * does inserting it into both in one edit — an unrecognised token cannot move a sequence, so it
 * cannot make two sequences differ either. One-sided drift is not the easier case here; it is
 * equally invisible, and this is what sees it. Both are standing rows in this issue's mutation set.
 *
 * It is still blind to a command naming none of these markers. That is the honest residual and it
 * is written here rather than left for a later reader to discover.
 */
const COMMAND_MARKERS = ['cd ', 'init.sh', 'docker compose'] as const

/** Every occurrence of `needle` in `haystack`, as start offsets. */
function offsetsOf(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    found.push(at)
  }
  return found
}

/** The commands a remedy names, in the order it names them. */
export function commandSequence(remedy: string): string[] {
  return COMMAND_VOCABULARY.flatMap((command) => offsetsOf(remedy, command).map((at) => ({ at, command })))
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.command)
}

/**
 * Markers the remedy carries that {@link commandSequence} did not account for, as
 * `marker xN seen, xM recognised` lines. Empty when the vocabulary covers everything.
 */
export function unrecognisedCommands(remedy: string): string[] {
  const sequence = commandSequence(remedy)
  return COMMAND_MARKERS.flatMap((marker) => {
    const seen = offsetsOf(remedy, marker).length
    const recognised = sequence.filter((command) => command.includes(marker)).length
    return seen === recognised ? [] : [`${marker} x${seen} seen, x${recognised} recognised`]
  })
}

/** A storage holding one live key for {@link OTHER_PROJECT}, plus that key's digest. */
async function worldWithAKeyHeldElsewhere(): Promise<{ storage: FakeTeamStorage; heldHash: string }> {
  const storage = new FakeTeamStorage()
  const held = mintIngestKey({ projectId: OTHER_PROJECT, nowMs: NOW })
  const seeded = await seedProjectIngestKey(storage, {
    projectId: OTHER_PROJECT,
    keyHash: held.row.keyHash,
    nowMs: NOW,
  })
  expect(seeded.ok, 'the fixture itself must seed cleanly, or every refusal below is the wrong one').toBe(true)
  return { storage, heldHash: held.row.keyHash }
}

/** The doctor's `ingest-key` line for one environment, through the real report. */
async function ingestKeyCheck(
  env: Record<string, string | undefined>,
  storage: FakeTeamStorage,
): Promise<{ status: string; message: string }> {
  const report: DoctorReport = await runDoctor({
    env,
    config: resolveTeamConfig(env, () => '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----'),
    nowMs: NOW,
    openStorage: async () => ({ ok: true, storage }),
  })
  const line = report.checks.find((c) => c.id === 'ingest-key')
  if (line === undefined) {
    throw new Error(`no ingest-key check; saw ${report.checks.map((c) => c.id).join(', ')}`)
  }
  return { status: line.status, message: line.message }
}

interface Pair {
  readonly state: SharedState
  readonly seed: string
  readonly doctor: string
}

/**
 * The pairs, DISCOVERED rather than declared.
 *
 * A state is returned only when BOTH surfaces actually refused it — the seed with `ok: false`, the
 * doctor with `status: 'fail'` — and both named at least one recognised command. A state that stops
 * being a refusal on either side, or whose remedy stops naming any command this law knows, drops
 * out of the returned list rather than being compared vacuously. That is what the pinned set in the
 * first test below measures: the DERIVATION, not the loop that walks it (`#596`, `83ce0e65` — pin
 * the set, do not count it).
 */
async function sharedRefusals(): Promise<Pair[]> {
  const { storage, heldHash } = await worldWithAKeyHeldElsewhere()

  const seeded: Record<SharedState, { ok: boolean; error: string }> = {
    noProject: refusalText(await seedProjectIngestKey(storage, { projectId: '  ', keyHash: heldHash, nowMs: NOW })),
    badHash: refusalText(
      await seedProjectIngestKey(storage, { projectId: THIS_PROJECT, keyHash: 'nope', nowMs: NOW }),
    ),
    otherProject: refusalText(
      await seedProjectIngestKey(storage, { projectId: THIS_PROJECT, keyHash: heldHash, nowMs: NOW }),
    ),
  }

  const healthyEnv = { [ENV_PROJECT]: THIS_PROJECT, [ENV_INGEST_KEY_SHA256]: heldHash }
  const checked: Record<SharedState, { status: string; message: string }> = {
    noProject: await ingestKeyCheck({ ...healthyEnv, [ENV_PROJECT]: '' }, storage),
    badHash: await ingestKeyCheck({ ...healthyEnv, [ENV_INGEST_KEY_SHA256]: 'nope' }, storage),
    // No override: the digest IS held, for OTHER_PROJECT, so the doctor reads the wrong-project arm.
    otherProject: await ingestKeyCheck(healthyEnv, storage),
  }

  const pairs: Pair[] = []
  for (const state of SHARED_STATES) {
    const seed = seeded[state]
    const doctor = checked[state]
    const bothRefuse = !seed.ok && doctor.status === 'fail'
    const bothNameACommand = commandSequence(seed.error).length > 0 && commandSequence(doctor.message).length > 0
    if (bothRefuse && bothNameACommand) pairs.push({ state, seed: seed.error, doctor: doctor.message })
  }
  return pairs
}

function refusalText(result: Awaited<ReturnType<typeof seedProjectIngestKey>>): { ok: boolean; error: string } {
  return result.ok ? { ok: true, error: '' } : { ok: false, error: result.error }
}

describe('the seed and the doctor cannot drift apart on the three states they both refuse', () => {
  it('THE VACUITY GUARD — exactly these three states are discovered, both surfaces refusing', async () => {
    const pairs = await sharedRefusals()
    // A pinned SET, not a count: a shrunk table, a state that stops refusing on either side, and a
    // duplicate standing in for a dropped one all redden here. `pairs.length === SHARED_STATES.length`
    // would have been true by construction and caught none of the three.
    expect(pairs.map((p) => p.state).sort()).toEqual(['badHash', 'noProject', 'otherProject'])
  })

  it('THE LAW — the same commands, in the same order, on both surfaces, for every shared state', async () => {
    const pairs = await sharedRefusals()
    const compared: SharedState[] = []

    for (const pair of pairs) {
      expect(
        commandSequence(pair.doctor),
        `the doctor and the seed disagree on ${pair.state}.\n  seed:   ${pair.seed}\n  doctor: ${pair.doctor}`,
      ).toEqual(commandSequence(pair.seed))
      compared.push(pair.state)
    }

    // The loop above is vacuous over an empty discovery, so it says which states it compared.
    expect(compared.sort()).toEqual(['badHash', 'noProject', 'otherProject'])
  })

  it('the vocabulary accounts for every command either surface names', async () => {
    const pairs = await sharedRefusals()
    const unaccounted = pairs.flatMap((pair) => [
      ...unrecognisedCommands(pair.seed).map((why) => `${pair.state} seed: ${why}`),
      ...unrecognisedCommands(pair.doctor).map((why) => `${pair.state} doctor: ${why}`),
    ])
    // Not decoration. Sequence equality can only compare tokens it recognises, so a command outside
    // COMMAND_VOCABULARY would be a real divergence this law called agreement. Extend the
    // vocabulary when this fails; do not relax it.
    expect(unaccounted).toEqual([])
  })

  /**
   * Sequence equality is SYMMETRIC, so it is blind to both sides drifting the same way. These two
   * are asserted on each surface independently, and each is a property of the deployment rather
   * than of the other surface.
   */
  /**
   * THIS INVARIANT REPLACES ITS OWN INVERSE, AND THE INVERSION IS THE POINT.
   *
   * #623's first pass asserted that `cd packages/team/deploy` must IMMEDIATELY PRECEDE the
   * rotation, reasoning that `./init.sh` is a relative path and would not otherwise resolve. That
   * reasoning never asked where the reader is standing, and the answer inverts it:
   *
   * - `compose.yml` exists at `packages/team/deploy/compose.yml` and nowhere else;
   * - Compose searches the cwd and its ANCESTORS, never its descendants;
   * - this repo contains no `docker compose -f` and no COMPOSE_FILE.
   *
   * The doctor's line is only ever seen through `docker compose exec app … doctor.ts`
   * (`docs/team-server-runbook.md:400`) and the seed's only through `docker compose logs app`, so
   * BOTH are read from `packages/team/deploy` — and from there `cd packages/team/deploy` exits 1
   * with "no such file or directory", after which `&&` short-circuits and the rotation never runs.
   * EXECUTED, Docker Compose v5.4.0: `docker compose config --services` answers "no configuration
   * file provided: not found" at the repo root and `postgres app caddy` one directory in.
   *
   * So the `cd` is the bare-`init.sh` defect of #598 one level in — a pointer that reports
   * something other than the fix — and all six remedies dropped it rather than gaining it.
   * `cd packages/team/deploy` STAYS in {@link COMMAND_VOCABULARY} on purpose: it must remain
   * recognisable, so that re-adding it to one surface still breaks sequence equality above rather
   * than passing as an unrecognised token.
   */
  it('BOTH SIDES INDEPENDENTLY — no remedy names a cd, because its reader is already standing there', async () => {
    const pairs = await sharedRefusals()
    let checked = 0

    for (const pair of pairs) {
      for (const [surface, remedy] of [
        ['seed', pair.seed],
        ['doctor', pair.doctor],
      ] as const) {
        const sequence = commandSequence(remedy)
        expect(sequence, `${pair.state} ${surface} names no rotation at all`).toContain(
          './init.sh --rotate-ingest-key',
        )
        expect(
          sequence,
          `${pair.state} ${surface}: from the only cwd this sentence can be READ from, ` +
            'cd packages/team/deploy exits 1 and && short-circuits the rotation away',
        ).not.toContain('cd packages/team/deploy')
        checked += 1
      }
    }

    // Without this, "no remedy names a cd" would be satisfied by discovering no remedies at all.
    expect(checked, 'six remedies: three states, two surfaces').toBe(6)
  })

  it('BOTH SIDES INDEPENDENTLY — the one state that sets the project sets it BEFORE rotating', async () => {
    const pairs = await sharedRefusals()
    const carrying: string[] = []

    for (const pair of pairs) {
      for (const [surface, remedy] of [
        ['seed', pair.seed],
        ['doctor', pair.doctor],
      ] as const) {
        const sequence = commandSequence(remedy)
        const set = sequence.indexOf('set RZ_TEAM_PROJECT')
        if (set === -1) continue
        carrying.push(`${pair.state} ${surface}`)
        // `./init.sh --rotate-ingest-key` reads the project OUT of `.env` and refuses when it names
        // none, so the other order is a second no-op pointer inside the fix for the first.
        expect(set, `${pair.state} ${surface}: rotation refuses an .env that names no project`).toBeLessThan(
          sequence.indexOf('./init.sh --rotate-ingest-key'),
        )
      }
    }

    // Named, so that "no remedy sets the project" cannot pass this test by having nothing to check.
    expect(carrying.sort()).toEqual(['noProject doctor', 'noProject seed'])
  })

  /**
   * THE LAW BITES.
   *
   * The comparator itself is the thing a reviewer cannot take on trust, and mutating a source file
   * to prove it is not something a test can do. So it is exercised directly against remedies that
   * differ in each of the four ways a real drift could differ — and against one that differs only
   * in voice, which must NOT convict.
   */
  it('THE LAW BITES — every shape of drift convicts, and a reword does not', async () => {
    const [real] = await sharedRefusals()
    if (real === undefined) throw new Error('no pairs discovered; the tests above say why')
    const seed = real.seed

    // Re-ADDED, not dropped: no remedy carries a `cd` any more, and this is the shape a future
    // edit would actually take — someone restoring the prefix on one surface and not the other.
    const cdReadded = seed.replace('./init.sh --rotate-ingest-key', 'cd packages/team/deploy && ./init.sh --rotate-ingest-key')
    const reordered = seed
      .replace('set RZ_TEAM_PROJECT', 'SET-LATER')
      .replace('docker compose up -d', 'set RZ_TEAM_PROJECT')
    const swapped = seed.replace('./init.sh --rotate-ingest-key', './init.sh --mint')
    const unNegated = seed.replace('NOT docker compose restart', 'docker compose restart')

    for (const [why, mutated] of [
      ['a cd re-added on one side', cdReadded],
      ['a reordered sequence', reordered],
      ['a different command', swapped],
      ['a warning that became an instruction', unNegated],
    ] as const) {
      expect(commandSequence(mutated), why).not.toEqual(commandSequence(seed))
    }

    // Voice, not sequence: the diagnosis is rewritten and every command is untouched.
    const reworded = seed.replace(
      'no RZ_TEAM_PROJECT in the environment, so there is no project to scope an ingest key to.',
      'this deployment does not say which project it is.',
    )
    expect(reworded, 'the reword must actually have changed the sentence').not.toBe(seed)
    expect(commandSequence(reworded)).toEqual(commandSequence(seed))
  })
})
