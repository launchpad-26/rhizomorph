/**
 * THE SHELL'S OWN PREFERENCES (#564; prd-34 ruling 8, prd-35 S1).
 *
 * Four notifications, a threshold, launch-on-login and the updater's cadence —
 * every one of them "individually toggleable", which is ruling 8's requirement
 * and D41's ("all toggleable"). They live here, in the host, because that is
 * where the acts they govern happen: the process that draws the tray is the
 * process that must know whether to raise a notification, and it has to know
 * before any window exists.
 *
 * ## Where the controls live, and why not here
 *
 * prd-35 ruling 1 divides the ground — settings changes things — and prd-35's
 * Application and Notifications groups are where these appear to a person.
 * `packages/web/src/settings/` is another lane's ground and this package may not
 * enter it (#563's fence, restated for #564), so what lands here is the half a
 * settings surface cannot own: the values, their defaults, their persistence,
 * and a bridge the settings surface reads them through
 * (`bridge-contract.ts`). When the controls arrive, they render these ids;
 * nothing is duplicated and nothing has to be migrated.
 *
 * ## What is deliberately not a preference
 *
 * **Demo mode is not here and may never be** — the simulated/real distinction
 * is on prd-35 ruling 2's never-configurable list, and `prefs-law.test.ts`
 * fails on any id or label naming it. The tray *reaches* demo mode; it cannot
 * dim its chrome, because there is nothing here to dim it with.
 *
 * **The badge is not here either**, and that is the load-bearing absence:
 * ruling 8 says a muted condition still moves the badge, and the way this
 * package keeps that promise is structural rather than careful —
 * `badgeFor()` takes a rank and nothing else, so there is no argument by which
 * a preference could reach it.
 */

export type HostPrefId =
  | 'notifications.needsHuman'
  | 'notifications.died'
  | 'notifications.landed'
  | 'notifications.spend'
  | 'notifications.spendThresholdUsd'
  | 'application.launchOnLogin'
  | 'application.closeToTray'
  | 'updates.downloadAutomatically'

export interface HostPreferences {
  'notifications.needsHuman': boolean
  'notifications.died': boolean
  'notifications.landed': boolean
  'notifications.spend': boolean
  /** Dollars. Null until a person sets one — the threshold is theirs, and there is no sensible default number to invent. */
  'notifications.spendThresholdUsd': number | null
  'application.launchOnLogin': boolean
  'application.closeToTray': boolean
  'updates.downloadAutomatically': boolean
}

export interface PrefDeclaration {
  id: HostPrefId
  /** What a settings surface renders. Deliberately free of the vocabulary prd-35 ruling 2 protects. */
  label: string
  kind: 'flag' | 'amount'
  /** Why it exists, in the voice the settings page uses. */
  what: string
}

/**
 * The declared set, in the order a settings surface should render it. Two
 * groups, matching prd-35's own: notifications, then application.
 */
export const HOST_PREFS: readonly PrefDeclaration[] = [
  {
    id: 'notifications.needsHuman',
    label: 'a lane needs a human',
    kind: 'flag',
    what: 'raises a desktop notification the first time a lane reaches the rung that wants you. Turning it off stops the interruption; the tray still changes.',
  },
  {
    id: 'notifications.died',
    label: 'a lane died',
    kind: 'flag',
    what: 'raises one when a lane goes to dead air. Turning it off stops the interruption; the tray still changes.',
  },
  {
    id: 'notifications.landed',
    label: 'work landed',
    kind: 'flag',
    what: 'raises one when a worktree folds home — the instrument\'s own count of landings.',
  },
  {
    id: 'notifications.spend',
    label: 'spend crossed my threshold',
    kind: 'flag',
    what: 'raises one when session cost passes the amount below. Silent until you set an amount, and silent while cost is unmeasured rather than measured-at-nothing.',
  },
  {
    id: 'notifications.spendThresholdUsd',
    label: 'the amount',
    kind: 'amount',
    what: 'the dollar figure the line above watches for. Yours to set; there is no default worth inventing.',
  },
  {
    id: 'application.launchOnLogin',
    label: 'start when I log in',
    kind: 'flag',
    what: 'offered, not imposed: this is off until you turn it on, on every platform.',
  },
  {
    id: 'application.closeToTray',
    label: 'closing the window leaves the fleet watching',
    kind: 'flag',
    what: 'the fleet is a background fact with a window. Turn this off and closing the window quits the app the way a plain window would.',
  },
  {
    id: 'updates.downloadAutomatically',
    label: 'download updates in the background',
    kind: 'flag',
    what: 'downloads quietly and applies on the next restart — never mid-session. Turning it off means checking yourself.',
  },
]

/**
 * The defaults, each one a decision:
 *
 * - the four notifications **on** — a daemon that told you nothing by default
 *   would have no reason to exist (ruling 8);
 * - the threshold **null** — "a threshold you set", and an invented number
 *   would fire on somebody's ordinary Tuesday;
 * - launch-on-login **off** — ruling 2's "offered, never imposed" is a default,
 *   not a dialog. **Re-ruled the same way by prd-58 wave 0 (2026-09-17)**, on
 *   the house's own precedent rather than taste: prd-44 #38 on retention
 *   ("there is no default age, and that is the ruling") and ADR-0010 rejecting
 *   a silent default for adapter capabilities by name. An instrument that
 *   starts itself because it was installed is making a decision the operator
 *   did not make — and prd-58 makes that heavier, because an instrument that
 *   autostarts now watches every repo on the machine rather than one;
 * - close-to-tray **on** — ruling 2's whole point, and the one default a person
 *   is most likely to want to change;
 * - automatic downloads **on** — ruling 3's convergent stake, and harmless
 *   while no update feed is configured (`updates.ts` says so rather than
 *   pretending to check).
 */
export const DEFAULT_PREFERENCES: HostPreferences = {
  'notifications.needsHuman': true,
  'notifications.died': true,
  'notifications.landed': true,
  'notifications.spend': true,
  'notifications.spendThresholdUsd': null,
  'application.launchOnLogin': false,
  'application.closeToTray': true,
  'updates.downloadAutomatically': true,
}

/**
 * Merges what was on disk onto the defaults, keeping any value of the right
 * shape and discarding the rest. A hand-edited file with one bad line loses
 * that line, not the file: the alternative is an app that will not start
 * because a person typed `"true"`.
 */
export function readPreferences(stored: unknown): HostPreferences {
  const merged = { ...DEFAULT_PREFERENCES }
  if (typeof stored !== 'object' || stored === null) return merged

  for (const declaration of HOST_PREFS) {
    const value = (stored as Record<string, unknown>)[declaration.id]
    if (declaration.kind === 'flag') {
      if (typeof value === 'boolean') assign(merged, declaration.id, value)
      continue
    }
    // The threshold: a positive, finite number, or null. Zero is refused
    // deliberately — "notify me when spend crosses $0" fires on the first
    // request of every session, which reads as a broken app rather than as a
    // threshold met.
    if (value === null) assign(merged, declaration.id, null)
    else if (typeof value === 'number' && Number.isFinite(value) && value > 0) assign(merged, declaration.id, value)
  }

  return merged
}

/** One preference, changed. Returns a new object — the caller persists it. */
export function withPreference(
  current: HostPreferences,
  id: string,
  value: unknown,
): { preferences: HostPreferences; changed: boolean; refused: string | null } {
  const declaration = HOST_PREFS.find((entry) => entry.id === id)
  if (declaration === undefined) {
    return { preferences: current, changed: false, refused: `${id} is not a preference this app has` }
  }

  const next = { ...current }
  if (declaration.kind === 'flag') {
    if (typeof value !== 'boolean') {
      return { preferences: current, changed: false, refused: `${id} takes true or false` }
    }
    assign(next, declaration.id, value)
  } else {
    if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      return { preferences: current, changed: false, refused: `${id} takes a positive amount, or null to unset it` }
    }
    assign(next, declaration.id, value as number | null)
  }

  return { preferences: next, changed: next[declaration.id] !== current[declaration.id], refused: null }
}

function assign(target: HostPreferences, id: HostPrefId, value: boolean | number | null): void {
  // One narrow cast, at the one place a dynamic id meets a typed record, rather
  // than a `Record<string, unknown>` shape that would lose every field's type.
  ;(target as Record<HostPrefId, boolean | number | null>)[id] = value
}
