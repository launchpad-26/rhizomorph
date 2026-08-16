import type { AttentionRef, FleetDigest } from './digest.js'
import type { HostPreferences } from './prefs.js'

/**
 * WHAT THE DAEMON INTERRUPTS YOU FOR (#564; prd-34 ruling 8's four conditions).
 *
 * A lane **needs a human** · a lane **died** · work **landed** · **spend crossed
 * a threshold you set**. Each individually toggleable, each muteable, and the
 * threshold a value a person owns.
 *
 * ## Transitions, not states
 *
 * The fleet is rebuilt on a one-second beat, so every condition here is a
 * *change* between two digests rather than a property of one. A notifier that
 * asked "does the fleet have a needs-you item" would raise one every second for
 * as long as the lane sat waiting — which is not an instrument, it is an alarm
 * clock. Identity comes from the ladder's own item ids, so the same lane
 * escalating for a second reason (waiting *and* off-fence) is a second
 * notification, and the same lane still waiting a minute later is none.
 *
 * ## The first digest raises nothing, ever
 *
 * `previous: null` returns an empty list. A shell that starts against a
 * *resumed* session (the common case — `decideSessionBoot` continues a run
 * younger than the resume window) folds a whole day of history in the first
 * second. Notifying on it would open the app with twenty toasts about lanes
 * that were dealt with yesterday. The first digest is a baseline; the second is
 * the first that can be news.
 *
 * ## Muting is about interruption, never about hiding
 *
 * Everything here is gated by a preference. Nothing here touches the badge:
 * `badgeFor()` takes a rank and cannot see a preference at all, and
 * `badge-law.test.ts` proves the badge is unchanged with every condition
 * silenced. That is ruling 8's promise, kept structurally rather than
 * carefully.
 */

export type NotificationKind = 'needs-human' | 'died' | 'landed' | 'spend'

export interface HostNotification {
  kind: NotificationKind
  title: string
  body: string
  /**
   * The ladder item this came from, when it came from one — so a click can put
   * the person in front of the right lane rather than at the front door.
   */
  ref: AttentionRef | null
}

export function decideNotifications(
  previous: FleetDigest | null,
  next: FleetDigest,
  preferences: HostPreferences,
): HostNotification[] {
  if (previous === null) return []

  const notifications: HostNotification[] = []

  if (preferences['notifications.needsHuman']) {
    for (const ref of arrivals(previous.needsYou, next.needsYou)) {
      notifications.push({
        kind: 'needs-human',
        title: 'a lane needs a human',
        body: `${ref.label} — ${ref.kind}`,
        ref,
      })
    }
  }

  if (preferences['notifications.died']) {
    for (const ref of arrivals(previous.broken, next.broken)) {
      notifications.push({ kind: 'died', title: 'a lane died', body: `${ref.label} — ${ref.kind}`, ref })
    }
  }

  if (preferences['notifications.landed'] && next.landings > previous.landings) {
    const landed = next.landings - previous.landings
    notifications.push({
      kind: 'landed',
      title: 'work landed',
      body: landed === 1 ? 'a lane landed and folded' : `${landed} lanes landed and folded`,
      ref: null,
    })
  }

  const threshold = preferences['notifications.spendThresholdUsd']
  if (
    preferences['notifications.spend'] &&
    threshold !== null &&
    // Unmeasured cost is not zero cost. `costIsAuthoritative: null` means no
    // cost event was counted at all (core's own vocabulary), and crossing a
    // threshold on an unknown would be an invented dollar — prd-9 ruling 7's
    // line, applied to an interruption.
    next.costIsAuthoritative !== null &&
    previous.costUsd < threshold &&
    next.costUsd >= threshold
  ) {
    notifications.push({
      kind: 'spend',
      title: 'spend crossed your threshold',
      body: `${format(next.costUsd)} this session — your threshold is ${format(threshold)}`,
      ref: null,
    })
  }

  return notifications
}

/** Items in `next` that were not in `previous`, by the ladder's own id. */
function arrivals(previous: readonly AttentionRef[], next: readonly AttentionRef[]): AttentionRef[] {
  const seen = new Set(previous.map((ref) => ref.id))
  return next.filter((ref) => !seen.has(ref.id))
}

function format(usd: number): string {
  return `$${usd.toFixed(2)}`
}
