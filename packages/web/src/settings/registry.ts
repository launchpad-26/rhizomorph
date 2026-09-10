/**
 * THE PREFERENCE REGISTRY (prd-35 rulings 1, 3 and 4, S1's "data source"; #550).
 *
 * **Every persisted preference this app has is declared here, and this module is
 * the only one in `packages/web/src` that names a browser store at all.** That
 * is not tidiness: prd-35's whole problem statement is that preferences hid in
 * `localStorage` under keys no surface exposed, so a person could not answer
 * "what have I changed?" and nobody could enumerate what was even changeable.
 * An enumeration that lives in one file is what makes both questions answerable
 * — and what makes ruling 2's law (`non-negotiables.ts`) able to bite, since a
 * control that would weaken an honesty law has to be declared *here* before it
 * can be rendered anywhere (`coverage-law.test.tsx` holds that structurally: the
 * set of controls the settings page renders equals the set of ids below).
 *
 * **Three scopes (ruling 3), three stores.** `machine` and `repo` are
 * `localStorage`; `session` is `sessionStorage`, and it is deliberately EMPTY —
 * reserved so a future transient preference has somewhere to be transient
 * instead of silently becoming permanent. A repo-scoped value lives in a bucket
 * named by the watched repo, so repo A's panels do not follow you into repo B
 * ({@link adoptRepoScope}).
 *
 * **The migration (`app/panelPrefs.ts`'s two keys).** `rhizomorph.panelCollapsed.v1`
 * and `rhizomorph.scenePrefs.v1` were the ad-hoc idiom this registry replaces.
 * They are not abandoned and they are not read-then-rewritten by a one-shot
 * migration that has to be remembered: each entry that had one declares its
 * {@link Legacy} key, and resolution falls back to it whenever the new store
 * holds nothing for that id. So an operator's existing collapse state survives
 * the change, the fallback is idempotent (no migration flag to get wrong, no
 * ordering to get wrong), and the first write to the new store supersedes it.
 *
 * **What a control may NOT do here.** See `non-negotiables.ts`. The short of it:
 * five things may never become a preference, the law enumerates them, and it
 * fails on an entry below that would weaken any of them.
 *
 * **Unavailable is resolved, not declared (wave 2, #574).** An entry's
 * `unavailable` string is the reason it cannot act; its {@link PrefEntry.requires}
 * names the host capability that CLEARS that reason, and `host.ts` says whether
 * this page's host provides it. So the ten controls that ride prd-34's desktop
 * shell are declared, persisted and explained here today, and turn on when the
 * shell announces itself — without the shell lane editing this file. Everything
 * that asks "can this control act?" must go through {@link unavailabilityOf},
 * never the raw field, or a shell-hosted page would render a disabled control
 * beside a working one for the same key.
 */

import { type HostCapability, hostProvides } from './host.js'

/** Where a preference lives, and therefore what changing the repo does to it (ruling 3). */
export type PrefScope = 'machine' | 'repo' | 'session'

/** The three scopes as data, so "exactly three, and one of them is reserved" is testable. */
export const PREF_SCOPES = ['machine', 'repo', 'session'] as const satisfies readonly PrefScope[]

/** How a scope reads to a person, for the line under every group heading. */
export const SCOPE_WORD: Readonly<Record<PrefScope, string>> = {
  machine: 'this machine',
  repo: 'this repo',
  session: 'this session',
}

export type PrefKind = 'choice' | 'flag' | 'record'

/** Every shape a stored preference may take. A `record` is a map of flags, like panel collapse. */
export type PrefValue = string | boolean | Readonly<Record<string, boolean>>

export interface PrefOption {
  readonly value: string
  readonly label: string
}

/**
 * A key whose ONE control is not on this page (ruling 1: a control that changes
 * something lives in settings and appears exactly once).
 *
 * Two keys are like this, and both for the same reason: they are direct
 * manipulation of the thing in front of you rather than configuration —
 * collapsing the panel you are looking at, hiding the scars in the picture you
 * are looking at. Settings still has to account for them (nothing may persist
 * unsurveyed), so it renders their STATE and the way back, never a second copy
 * of the control.
 */
export interface ControlElsewhere {
  /** Where the one control is, in words a person can act on. */
  readonly surface: string
  /** Its `data-testid`, so "exactly once" is checkable rather than claimed. */
  readonly testId: string | null
  readonly why: string
}

/** A key that used to live under its own `localStorage` key, before this registry existed. */
export interface Legacy {
  readonly key: string
  /** The field inside that key's object, or `null` when the whole object is the value. */
  readonly field: string | null
}

export interface PrefEntry {
  /** `<group>.<name>`, and the identity every control, test and law uses. */
  readonly id: string
  readonly group: GroupId
  readonly label: string
  /** One line: what this changes. Present tense, no promises. */
  readonly what: string
  readonly scope: PrefScope
  readonly kind: PrefKind
  /** The choices, for `kind: 'choice'`. Empty otherwise. */
  readonly options: readonly PrefOption[]
  /**
   * What `true` and `false` MEAN, for a flag or a record — `['collapsed',
   * 'expanded']`, not `['on', 'off']`. Settings has to state what a stored
   * boolean does without the panel that owns it being on screen, and "feed:
   * true" is not that sentence. `null` for a choice, which says it in its own
   * option labels.
   */
  readonly words: readonly [string, string] | null
  /** The value with nothing overridden — shown beside every control (ruling 4). */
  readonly fallback: PrefValue
  readonly control: 'settings' | ControlElsewhere
  /**
   * Why this control cannot act today, or `null` when it can. Never a reason to
   * HIDE it (S1's *unavailable* state): a missing control reads as a setting
   * that does not exist, which is a different and weaker claim than "this one
   * is waiting on something, and here is what".
   *
   * Read it through {@link unavailabilityOf}, which is the field AFTER
   * {@link requires} has had its say.
   */
  readonly unavailable: string | null
  /**
   * The host capability that makes {@link unavailable} stop applying — `null`
   * when nothing a host could provide would clear it (the reason is a PRD that
   * has not landed, not a capability this page is missing).
   *
   * This is what lets prd-34's shell turn on ten controls by existing rather
   * than by editing this file; see `host.ts` for the decision and its cost.
   */
  readonly requires: HostCapability | null
  /**
   * The honest-gap voice (law 12) for a control that persists correctly but
   * whose effect is not fully wired yet: WHAT is missing → WHY it matters →
   * what fixes it. `null` when there is no gap to declare.
   */
  readonly gap: string | null
  readonly legacy: Legacy | null
}

export type GroupId =
  | 'appearance'
  | 'motion'
  | 'notifications'
  | 'application'
  | 'repo'
  | 'telemetry'
  | 'you'
  | 'sharing'

export interface SettingsGroup {
  readonly id: GroupId
  readonly title: string
  readonly what: string
  /**
   * Why the whole group cannot act yet, in the honest-gap voice — or `null` for
   * the groups that are live. A group riding another PRD renders DISABLED WITH
   * ITS REASON, never hidden and never absent, so the shape of the surface is
   * the truth about what the instrument can be told.
   *
   * Read it through {@link groupUnavailabilityOf}, never raw.
   */
  readonly unavailable: string | null
  /** The host capability that clears {@link unavailable} — see {@link PrefEntry.requires}. */
  readonly requires: HostCapability | null
}

/**
 * S1's eight groups, in S1's order. Three are live in a browser (appearance,
 * motion, telemetry); two more turn on the moment prd-34's shell hosts this
 * page, with no edit here (`requires`); the last three name the PRD that brings
 * them and stay disabled with their reason until it lands.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    what: 'what the instrument looks like, and how much of the picture it draws.',
    unavailable: null,
    requires: null,
  },
  {
    id: 'motion',
    title: 'Motion',
    what: 'how much of it moves. A health control, not decoration (ruling 5).',
    unavailable: null,
    requires: null,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    what:
      "per condition — needs a human, died, landed, spend threshold — plus the threshold and quiet hours. Muting is about interruption, never about hiding: prd-34 ruling 8 holds that a muted condition still moves the badge, and nothing here reaches the instrument's own picture of it.",
    unavailable:
      "no host here can raise one. A browser tab could ask for its own notification permission, and this instrument will not — a permission prompt from a page you left open is not the same act as a fleet reaching you, and the two would be indistinguishable afterwards. prd-34's desktop shell (#564) announces `notify` when it hosts this page, and every switch below is already stored and already wired to that: it turns on by the shell existing, not by anyone editing this file.",
    requires: 'notify',
  },
  {
    id: 'application',
    title: 'Application',
    what: 'close to tray · tray badge · launch on login · update channel.',
    unavailable:
      "this is a browser, not the desktop shell — there is no tray to close to and no login to launch from. prd-34's shell (#564) announces `shell` when it hosts this page, and these four are stored and explained here already, so it turns them on by existing.",
    requires: 'shell',
  },
  {
    id: 'repo',
    title: 'Repo',
    what:
      "which repository this instrument is watching, and what it remembers for that repo. The repo itself is shown, not chosen: there is no picker here and no hand to drive one — the concierge launches into the repo THIS server is watching, and retarget-in-place is prd-20's own open question, still unruled (`connect/wizard.tsx` says the same to anyone who picks another repo) — so it is set on the command line until prd-20 rules it.",
    // LIVE since prd-55 wave 1 (ruling 5). This group used to be disabled whole,
    // for the picker's absence, and `unavailabilityOf` reads the group FIRST —
    // so the moment it held a control that works (`lab.models`, written by the
    // launch panel's other… entry) that one sentence would have thrown from
    // `writePreference` and disabled a row for a reason that is not the row's.
    // The picker's absence is still stated, in `what` above, as a fact about
    // the group rather than as a reason the group cannot act: it can.
    unavailable: null,
    requires: null,
  },
  {
    id: 'telemetry',
    title: 'Telemetry',
    what: 'the env block for this instance, copyable, with the same same-process warning /connect gives it.',
    unavailable: null,
    requires: null,
  },
  {
    id: 'you',
    title: 'You',
    what: 'your display name and colour, defaulting to the git identity already in the log.',
    unavailable:
      'nothing reads a display name or a colour yet — prd-37 introduces the identity declaration that gives one somewhere to go. A field stored before then would describe a person to nobody.',
    requires: null,
  },
  {
    id: 'sharing',
    title: 'Sharing',
    what: 'facts always; your words only if you share them.',
    unavailable:
      'no team server is configured, so there is no other end for an opt-in to reach and no words that could leave this machine. prd-37 brings both, and the default stays facts-only when it does.',
    requires: null,
  },
]

/**
 * EVERY PERSISTED PREFERENCE IN THE CODEBASE. Adding a key anywhere else is
 * caught twice — by `coverage-law.test.tsx` (the settings page renders exactly
 * these ids, and no source file outside this module names a browser store) and,
 * if it would weaken an honesty law, by `non-negotiables.ts`.
 */
export const PREFERENCES: readonly PrefEntry[] = [
  {
    id: 'appearance.theme',
    group: 'appearance',
    label: 'Theme',
    what: 'which palette the instrument wears.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'system', label: 'Follow system' },
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    // Operator ruling 2026-09-08 (#337): the instrument opens DARK unless the
    // operator chose otherwise. ui-2.0 D26 makes dark the source of truth and
    // light a re-derivation on paper, so a fresh machine opens in the source.
    // "Follow system" is still on offer; it is simply no longer what nobody
    // chose. `apply.ts`'s `resolveTheme` is untouched — `system` keeps meaning
    // follow-the-OS for anyone who picks it.
    fallback: 'dark',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: null,
    // The gap note this entry carried is CLOSED, and its absence is the record:
    // #550 shipped the switch with no light block ("the colours stay dark"),
    // #551 landed the light table and rewrote the note to name the scene as the
    // one surface the choice did not reach, and the light-mode wave pointed the
    // marks at that table (`useDocumentTheme` → `paletteFor(theme)`), so the
    // choice now reaches every surface the instrument draws. A note that
    // outlives its gap teaches readers this voice is stale — see `apply.ts`.
    gap: null,
    legacy: null,
  },
  {
    id: 'appearance.density',
    group: 'appearance',
    label: 'Density',
    what: 'how much air the instrument leaves around its rows.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'compact', label: 'Compact' },
    ],
    fallback: 'comfortable',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: null,
    legacy: null,
  },
  {
    id: 'appearance.sceneQuality',
    group: 'appearance',
    label: 'Scene quality',
    what: 'how much of the scene is drawn, for a machine that cannot hold the frame budget.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'calm', label: 'Calm' },
      { value: 'rich', label: 'Rich' },
      { value: 'maximum', label: 'Maximum' },
    ],
    fallback: 'rich',
    words: null,
    control: 'settings',
    // LIVE since loop 6 (2026-08-21): the renderer reads all three levels —
    // calm is ruling 12's still floor, rich is the scene as shipped, maximum
    // adds the subsurface underglow. The disabled-until-real discipline held:
    // the control existed here first, and acted only when the reads existed.
    unavailable: null,
    requires: null,
    gap: null,
    legacy: null,
  },
  {
    id: 'appearance.hideFinished',
    group: 'appearance',
    label: 'Finished lanes in the scene',
    what: 'whether a retired lane keeps its scar near the rim, or is left out of the picture.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['hidden', 'visible'],
    control: {
      surface: "the scene's own header",
      testId: 'scene-hide-finished',
      why: 'a scar is hidden from the picture it sits in, so the toggle belongs on that picture (`scene/SceneView.tsx`). Ruling 1 allows a control that changes something exactly one home, so this page shows what it is set to and what it defaults to, and offers no second copy of it.',
    },
    unavailable: null,
    requires: null,
    gap: null,
    legacy: { key: 'rhizomorph.scenePrefs.v1', field: 'hideFinished' },
  },
  {
    id: 'onboarding.welcomed',
    group: 'appearance',
    label: 'First-run welcome',
    what: 'whether the welcome card has been dismissed. Restoring defaults brings it back.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['dismissed', 'showing'],
    control: {
      surface: "the observatory's own welcome card",
      testId: 'welcome-dismiss',
      why: 'a first-run affordance that had to be configured from a settings page would have failed at its one job. The card dismisses itself; this page shows what happened and, via restore defaults, undoes it.',
    },
    unavailable: null,
    requires: null,
    gap: null,
    legacy: null,
  },
  {
    id: 'appearance.panelsCollapsed',
    group: 'appearance',
    label: 'Collapsed panels',
    what: 'which panels you have folded away, remembered for this repo.',
    scope: 'repo',
    kind: 'record',
    options: [],
    // Empty since #552, and the emptiness is the ruling rather than a loss of
    // one. This map used to carry `{ collisions: false, feed: true }` — prd1's
    // "collisions must default to expanded" and prd9's "the feed defaults to a
    // peek". prd-32 ruling 5 folded collisions and the feed into the dock, so
    // neither is a panel with a collapse state any more; the four dock tabs are
    // one surface with one collapse, and which of them is showing is
    // `appearance.dockTab`. Leaving two panels named here that no longer exist
    // would have printed a default for them on this very page, which is the
    // dishonesty prd-35 is against. prd1's ruling survives where it now lives:
    // collisions is a tab, and a tab is never hidden (S3 forbids it).
    fallback: {},
    words: ['collapsed', 'expanded'],
    control: {
      surface: "each panel's own header",
      testId: null,
      why: 'folding the panel in front of you is direct manipulation, not configuration; its header carries the one control. What settings owns is the survey — which panels are not where they started, and the way back.',
    },
    unavailable: null,
    requires: null,
    gap: null,
    legacy: { key: 'rhizomorph.panelCollapsed.v1', field: null },
  },
  {
    id: 'appearance.dockTab',
    group: 'appearance',
    label: 'Dock tab',
    what: 'which of the dock’s four surfaces is showing beneath the fleet.',
    // Repo, not machine, and prd-32 S3 says so in as many words ("the selected
    // tab persists per repo"). The reason is the same one ruling 3 gives panel
    // collapse: which analytical surface you keep open is a fact about the work
    // in front of you, and a repo you review spend on is not the repo you watch
    // collisions on.
    scope: 'repo',
    kind: 'choice',
    options: [
      { value: 'spend', label: 'Spend' },
      { value: 'collisions', label: 'Collisions' },
      { value: 'feed', label: 'Activity' },
      { value: 'trace', label: 'Trace' },
    ],
    fallback: 'spend',
    words: null,
    control: {
      surface: 'the dock’s own tab strip, beneath the fleet',
      testId: 'dock-tabs',
      why: 'picking the tab in front of you is direct manipulation, not configuration — ruling 1 allows a control that changes something exactly one home, so this page shows which tab is remembered and offers no second way to change it.',
    },
    unavailable: null,
    // Nothing a host could provide would change this: the dock is four tabs in
    // a browser and it works today (#574's `requires` names the capability that
    // CLEARS an `unavailable`, and this entry has none to clear).
    requires: null,
    gap: null,
    legacy: null,
  },
  {
    id: 'motion.level',
    group: 'motion',
    label: 'Motion',
    what: 'how much of the instrument moves. May go beyond the system request, never below it.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'system', label: 'Follow system' },
      { value: 'reduced', label: 'Reduced' },
      { value: 'still', label: 'Still' },
    ],
    fallback: 'system',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: null,
    legacy: null,
  },

  // ── notifications (prd-34 ruling 8, hosted; #574) ───────────────────────────
  //
  // RULING 2, CHECKED BEFORE THE GROUP WAS WRITTEN. A notification switch is
  // the shape "make the alarms quieter" arrives in, so it was held against the
  // alarm-band entry deliberately rather than let through because prd-35 S1
  // lists it. It survives for a reason that has to stay true: none of these
  // reaches the instrument's own account of the fleet. The band, the ladder and
  // the lane's row are unchanged by every one of them, and prd-34 ruling 8
  // makes the same commitment one layer out — a muted condition still moves the
  // badge, because muting is about interruption and never about hiding. The day
  // a switch here would take a lane OUT of the picture rather than out of your
  // evening, it is not a setting, and `non-negotiables.ts` is what says so.
  {
    id: 'notifications.needsHuman',
    group: 'notifications',
    label: 'A lane needs a human',
    what: 'whether a lane that has stopped for you interrupts you. It is in the picture either way.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: true,
    words: ['interrupts you', 'waits in the picture'],
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    gap: null,
    legacy: null,
  },
  {
    id: 'notifications.died',
    group: 'notifications',
    label: 'A lane died',
    what: 'whether a lane that ended without landing interrupts you.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: true,
    words: ['interrupts you', 'waits in the picture'],
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    gap: null,
    legacy: null,
  },
  {
    id: 'notifications.landed',
    group: 'notifications',
    label: 'Work landed',
    what: 'whether a lane reaching main interrupts you. Off by default — landing is the good news, and good news can wait.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['interrupts you', 'waits in the picture'],
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    gap: null,
    legacy: null,
  },
  {
    id: 'notifications.spendCrossed',
    group: 'notifications',
    label: 'Spend crosses the threshold',
    what: 'whether the fleet passing the figure below interrupts you.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['interrupts you', 'waits in the picture'],
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    gap: null,
    legacy: null,
  },
  {
    id: 'notifications.spendThreshold',
    group: 'notifications',
    label: 'Spend threshold',
    what: 'the figure the switch above watches for, across the whole fleet, for one run.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: '5', label: '$5' },
      { value: '20', label: '$20' },
      { value: '50', label: '$50' },
      { value: '100', label: '$100' },
    ],
    fallback: '20',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    /**
     * Four figures rather than a number field, and that is a real limit rather
     * than a shortcut: the registry stores three kinds (`choice`, `flag`,
     * `record`), a free number would be a fourth, and a fourth kind is a change
     * to what every control, law and store here handles. Whoever finds four
     * figures too coarse is asking for that kind, with its validation and its
     * out-of-range case, in its own diff.
     */
    gap: 'the dollars this watches are the vendored-or-flagged figures the ledger already carries — it cannot watch a cost nobody reported, and a fleet with no cost data crosses no threshold rather than crossing it silently.',
    legacy: null,
  },
  {
    id: 'notifications.quietHours',
    group: 'notifications',
    label: 'Quiet hours',
    what: 'when an interruption waits until morning instead. The fleet is unchanged; only whether it reaches you tonight is.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'never', label: 'Any hour' },
      { value: 'night', label: 'Hold 22:00 to 07:00' },
    ],
    fallback: 'never',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: 'notify',
    gap: "prd-35 leaves the shape of this open — a schedule or a single window — and this is the single window, which is the smaller of the two claims. A schedule can be added over it; a schedule that had to be un-invented could not.",
    legacy: null,
  },

  // ── application (prd-34 rulings 2 and 8, hosted; #574) ──────────────────────
  {
    id: 'application.closeToTray',
    group: 'application',
    label: 'Closing the window',
    what: 'whether closing the window leaves the fleet being watched, or ends the instrument.',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: true,
    words: ['leaves the watcher running', 'quits the instrument'],
    control: 'settings',
    unavailable:
      "this host announces no tray, so there is nowhere for a closed window to go — and quitting on close is the only honest behaviour left. prd-34's own risk register names the Linux tray as the shaky one, which is why this says so on its own rather than taking the group down with it.",
    requires: 'tray',
    gap: null,
    legacy: null,
  },
  {
    id: 'application.trayBadge',
    group: 'application',
    label: 'Tray badge',
    what: "whether the tray icon carries the fleet's state at OS level. The instrument's own picture of it is not affected either way, and a notification you told to wait still moves the badge.",
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: true,
    words: ['carries the fleet state', 'plain'],
    control: 'settings',
    unavailable:
      'this host announces no tray, so there is no icon to badge. The window carries the same state, unchanged and unswitchable, which is the reason this switch is allowed to exist at all.',
    requires: 'tray',
    gap: null,
    legacy: null,
  },
  {
    id: 'application.launchAtLogin',
    group: 'application',
    label: 'Launch at login',
    what: 'whether the instrument starts with the machine. Offered, never imposed (prd-34 ruling 2).',
    scope: 'machine',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['starts with the machine', 'started by you'],
    control: 'settings',
    unavailable:
      'this host cannot register a login item — it either is not the desktop shell or the OS refused it. Starting the instrument is yours to do until it can.',
    requires: 'launchAtLogin',
    gap: null,
    legacy: null,
  },
  {
    id: 'application.updateChannel',
    group: 'application',
    label: 'Update channel',
    what: 'which builds this instrument updates itself to. Updates download quietly and apply on restart, never mid-session.',
    scope: 'machine',
    kind: 'choice',
    options: [
      { value: 'stable', label: 'Stable' },
      { value: 'beta', label: 'Beta' },
    ],
    fallback: 'stable',
    words: null,
    control: 'settings',
    unavailable:
      'this host has no updater — a build served from a repo updates when you pull it. The channel is a choice only where something is choosing on your behalf.',
    requires: 'updates',
    gap: null,
    legacy: null,
  },

  // ── repo (prd-55 ruling 5, wave 1 — the model list is the operator's) ───────
  //
  // NOT A GATE, AND SAID SO BEFORE THE ENTRY IS READ. A model this map does not
  // hold is still legal on the command line: `rhizomorph lab fork` takes any
  // model `MODEL_GRAMMAR` (`packages/server/src/lab/fork.ts`) admits and reads
  // nothing stored in a browser, and the launch route inherits that grammar
  // rather than this list. What the map decides is which names the launch
  // panel's select puts in front of a person — a convenience for the one
  // choosing from a list, so a name this repo never dispatches is not on offer
  // at every launch. It is not one of the six in `non-negotiables.ts` and must
  // never grow into one: a preference that could REFUSE a model would be a gate
  // wearing a preference's face, and a refusal belongs in a reviewed diff to the
  // grammar, beside every other one. A key that is true is offered, a key that
  // is false is not, and a key the map does not hold is unknown to the panel and
  // untouched on the CLI.
  {
    id: 'lab.models',
    group: 'repo',
    label: 'Lab models',
    what: "which models the lab's launch panel offers for an arm, remembered for this repo.",
    scope: 'repo',
    kind: 'record',
    options: [],
    // The three aliases every dispatch in this repo has actually used — `fork.ts`
    // names them first among the real model strings its grammar admits — seeded
    // ON, so a fresh repo's select is a list and not a blank. Per repo, not per
    // machine, for the reason ruling 3 gives panel collapse: which models a
    // project tries is a fact about that project's experiments.
    fallback: { opus: true, sonnet: true, haiku: true },
    words: ['offered', 'not offered'],
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: "this page has no control for a map of flags — a record has only ever been surveyed here, never edited here — so this row shows the list's default and whether it has been changed, and offers nothing to change it. The list is edited where it is read: the launch panel's per-arm select offers exactly the keys switched on here (`lab/launch/models.ts`), and its other… entry writes a typed name in as an offered key. Switching a name off again, or offering one without launching, is a settings-side record control that has not landed — its own diff, when it does; until then restore defaults is the one way back from here.",
    legacy: null,
  },
  // prd-55 ruling 1 (wave 5): the R&D hand is the operator's OWN agent CLI,
  // and this is where they say what it is called. The server resolves the name
  // on its own PATH — never from an environment variable — so the scope is the
  // MACHINE and not the repo: one machine has one PATH, and two repos watched
  // from the same box cannot honestly disagree about what `claude` is.
  //
  // The kind is the honest one available, and the gap says what that costs.
  // `PrefKind` is `choice | flag | record`; a free string is none of them, and
  // `accept()` refuses a `choice` value that is not one of `options`. So this
  // is declared as the choice it actually is today — one name, the one the
  // instrument ships with — rather than as a `choice` whose options pretend to
  // enumerate every binary a person might have installed, or a `record` of
  // flags that would mean something else entirely. Inventing a fourth kind to
  // carry it is a change to every consumer of `PrefKind` and belongs in its own
  // reviewed diff, not smuggled in beside a lab preference.
  {
    id: 'lab.agentCommand',
    group: 'repo',
    label: 'R&D agent command',
    what: "the name the server looks for on its own PATH when the lab's R&D hand is invoked.",
    scope: 'machine',
    kind: 'choice',
    options: [{ value: 'claude', label: 'claude' }],
    fallback: 'claude',
    words: null,
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: 'this page can only offer the one name the instrument ships with, because a preference here is a choice, a flag or a map of flags and a typed-in binary name is none of the three. An operator whose CLI is installed under another name — a wrapper, a versioned binary, a shim — cannot declare it here, and the R&D control will tell them there is no claude on this machine\'s PATH, which is true and unhelpful. What fixes it is a free-text preference kind and a control for it on this page; that is a change to every reader of PrefKind and belongs in its own diff.',
    legacy: null,
  },
  // prd-55 ruling 2 (wave 5): local first, and the tracker is a SECOND declared
  // act. A flag rather than a two-option choice on purpose — the question is
  // "may the hand also read closed issues through my own gh?", which is a
  // yes/no about granting a second read, and `words` says what each answer
  // means without the R&D panel being on screen (the rule `describeValue`
  // keeps). Repo-scoped because ruling 2 scopes it that way: which repo's
  // tracker may be read is a fact about that repo.
  {
    id: 'lab.rdCorpus',
    group: 'repo',
    label: 'Read the tracker with my gh',
    what: "whether the lab's R&D hand may also read this repo's closed issues through your own gh, on top of the record it already holds.",
    scope: 'repo',
    kind: 'flag',
    options: [],
    fallback: false,
    words: ['local+tracker — the record, plus closed issues through your gh', 'local — the record this repo already holds'],
    control: 'settings',
    unavailable: null,
    requires: null,
    gap: "nothing sends this to the server yet: the R&D control that carries the corpus choice to the lab is a later wave's surface, so switching it on is remembered and, until that control exists, changes nothing about what the hand reads. The engine already records which corpus produced a run, on every rd.* event, so when the control lands there is nothing here to change.",
    legacy: null,
  },
]

// ── the stores ──────────────────────────────────────────────────────────────

/**
 * The four storage keys, and the only place in `packages/web/src` any of them
 * is spelled. `coverage-law.test.tsx` proves that claim over the whole tree
 * rather than trusting this paragraph.
 */
const MACHINE_KEY = 'rhizomorph.prefs.machine.v1'
const REPO_KEY = 'rhizomorph.prefs.repo.v1'
const SESSION_KEY = 'rhizomorph.prefs.session.v1'
const REPO_SCOPE_KEY = 'rhizomorph.prefs.repoScope.v1'

/**
 * The bucket repo-scoped values land in before anything has told the registry
 * which repo is being watched. Named rather than empty-stringed so it is
 * visible in a storage inspector for what it is, and so {@link adoptRepoScope}
 * can recognise a first adoption and carry it forward.
 */
export const UNADOPTED_REPO = '~unadopted'

/**
 * `session` is `sessionStorage`; everything else is `localStorage`. Both are
 * reached through here and nowhere else, and both can throw outright (Safari's
 * private mode, a storage-disabled embed), which is why the caller gets `null`
 * rather than an exception: an unstorable preference falls back to its default
 * and says so on the page (S1's *error* state), never crashes the surface.
 */
function storeFor(scope: PrefScope): Storage | null {
  try {
    return scope === 'session' ? sessionStorage : localStorage
  } catch {
    return null
  }
}

function keyFor(scope: PrefScope): string {
  return scope === 'session' ? SESSION_KEY : scope === 'repo' ? REPO_KEY : MACHINE_KEY
}

function readJson(scope: PrefScope, key: string): Record<string, unknown> {
  const store = storeFor(scope)
  if (store === null) return {}
  try {
    const raw = store.getItem(key)
    if (raw === null || raw.length === 0) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function writeJson(scope: PrefScope, key: string, value: Record<string, unknown>): boolean {
  const store = storeFor(scope)
  if (store === null) return false
  try {
    store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

// ── the repo bucket (ruling 3: a repo-scoped value does not leak across repos) ──

let adoptedRepo: string | null = null

/**
 * The bucket repo-scoped values are read from and written to right now.
 *
 * Remembered across a reload (`REPO_SCOPE_KEY`), because ruling 3's other half
 * is that a setting survives a restart: a bucket that reset to
 * {@link UNADOPTED_REPO} on every boot would make every repo-scoped preference
 * look lost on every reload, which is the same failure wearing the opposite
 * face.
 */
export function currentRepoScope(): string {
  if (adoptedRepo !== null) return adoptedRepo
  const stored = readJson('repo', REPO_SCOPE_KEY).path
  return typeof stored === 'string' && stored.length > 0 ? stored : UNADOPTED_REPO
}

/**
 * Tell the registry which repo is being watched. Called by the settings page
 * from the fold every surface already reads (`app/streamState.ts`'s
 * `foldedRepoPath`) — no second source, no fetch of its own.
 *
 * Two behaviours, and the difference between them is ruling 3:
 *
 * - **First adoption** — nothing has ever named a repo, so whatever landed in
 *   {@link UNADOPTED_REPO} was set *in this repo* by a person who had no way to
 *   say so. It is carried into the new bucket rather than stranded.
 * - **Every adoption after that** — buckets stay separate. A value set in repo A
 *   is absent in repo B and returns when A is watched again, which is S1's
 *   acceptance criterion stated as a mechanism.
 */
export function adoptRepoScope(repoPath: string | null): void {
  const next = repoPath !== null && repoPath.length > 0 ? repoPath : UNADOPTED_REPO
  const previous = currentRepoScope()
  if (next === previous) return

  const all = readJson('repo', REPO_KEY)
  if (previous === UNADOPTED_REPO && next !== UNADOPTED_REPO) {
    const stranded = all[UNADOPTED_REPO]
    if (stranded !== undefined && Object.keys(stranded as Record<string, unknown>).length > 0) {
      const { [UNADOPTED_REPO]: carried, ...rest } = all
      writeJson('repo', REPO_KEY, { ...rest, [next]: carried })
    }
  }

  adoptedRepo = next
  writeJson('repo', REPO_SCOPE_KEY, { path: next })
  notify()
}

/** The bag of values for one scope — the repo's own bucket, for `repo`. */
function bagOf(scope: PrefScope): Record<string, unknown> {
  if (scope !== 'repo') return readJson(scope, keyFor(scope))
  const bucket = readJson('repo', REPO_KEY)[currentRepoScope()]
  return bucket !== null && typeof bucket === 'object' && !Array.isArray(bucket)
    ? (bucket as Record<string, unknown>)
    : {}
}

function writeBag(scope: PrefScope, bag: Record<string, unknown>): boolean {
  if (scope !== 'repo') return writeJson(scope, keyFor(scope), bag)
  return writeJson('repo', REPO_KEY, { ...readJson('repo', REPO_KEY), [currentRepoScope()]: bag })
}

// ── reading and writing one preference ──────────────────────────────────────

const BY_ID = new Map(PREFERENCES.map((entry) => [entry.id, entry]))

/** The entry for `id`. Throws rather than returning a default: an unknown key is a bug, not a fallback. */
export function entryOf(id: string): PrefEntry {
  const entry = BY_ID.get(id)
  if (entry === undefined) throw new Error(`no preference is declared under ${id}`)
  return entry
}

export function entriesOf(group: GroupId): readonly PrefEntry[] {
  return PREFERENCES.filter((entry) => entry.group === group)
}

/** The scopes a group actually holds, in declaration order — one restore-defaults per scope (ruling 4). */
export function scopesIn(group: GroupId): readonly PrefScope[] {
  const seen: PrefScope[] = []
  for (const entry of entriesOf(group)) if (!seen.includes(entry.scope)) seen.push(entry.scope)
  return seen
}

// ── what can act, here, now (S1's *unavailable* state; #574) ────────────────

const GROUP_BY_ID = new Map(SETTINGS_GROUPS.map((group) => [group.id, group]))

/** The group `id` names. Throws, for the same reason {@link entryOf} does. */
export function groupOf(id: GroupId): SettingsGroup {
  const group = GROUP_BY_ID.get(id)
  if (group === undefined) throw new Error(`no settings group is declared under ${id}`)
  return group
}

/**
 * A declared reason, after the host has had its say: `null` when there was no
 * reason to begin with, or when the capability that clears it is provided.
 *
 * A `requires` of `null` means nothing a host could provide clears this — the
 * blocker is a PRD that has not landed, not a capability this page is missing.
 */
function resolve(reason: string | null, requires: HostCapability | null): string | null {
  if (reason === null) return null
  return requires !== null && hostProvides(requires) ? null : reason
}

/** Why this whole group cannot act here, or `null`. */
export function groupUnavailabilityOf(group: SettingsGroup): string | null {
  return resolve(group.unavailable, group.requires)
}

/**
 * Why this one control cannot act here, or `null`.
 *
 * **The group answers first**, and that ordering is what keeps the page from
 * saying the same thing eight times: in a browser every Application control is
 * blocked by the same missing shell, so the group states it once and each row
 * is merely disabled. A control's OWN reason is reached only when the group is
 * live and that one control is not — a shell whose tray never appeared, a
 * control riding a PRD its group does not — which is exactly when a per-row
 * sentence is the only place the reason could go.
 */
export function unavailabilityOf(entry: PrefEntry): string | null {
  return groupUnavailabilityOf(groupOf(entry.group)) ?? resolve(entry.unavailable, entry.requires)
}

function isFlagRecord(value: unknown): value is Record<string, boolean> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => typeof field === 'boolean')
  )
}

/** A stored value the entry actually permits, or `null` — a wrong-typed or retired option reads as unset. */
function accept(entry: PrefEntry, value: unknown): PrefValue | null {
  if (entry.kind === 'flag') return typeof value === 'boolean' ? value : null
  if (entry.kind === 'record') return isFlagRecord(value) ? value : null
  if (typeof value !== 'string') return null
  return entry.options.some((option) => option.value === value) ? value : null
}

/** What the legacy key still says, for an entry that had one. `null` when it says nothing usable. */
function readLegacy(entry: PrefEntry): PrefValue | null {
  if (entry.legacy === null) return null
  const stored = readJson(entry.scope, entry.legacy.key)
  return accept(entry, entry.legacy.field === null ? stored : stored[entry.legacy.field])
}

/**
 * The value in force for `id`: what is stored, else what the legacy key still
 * holds, else the default.
 *
 * A `record` MERGES over its default rather than replacing it, and that is
 * load-bearing rather than convenient: panel collapse stores only the panels a
 * person actually touched, so a stored `{ fleet: true }` must still leave `feed`
 * at its own declared default (collapsed) and `collisions` at its own (expanded,
 * a deliberate ruling). Replace-semantics would silently expand the feed the
 * first time any other panel was collapsed — a default quietly overwritten by an
 * unrelated act, which is exactly the class of thing this registry exists to
 * stop happening in the dark.
 */
export function readPreference(id: string): PrefValue {
  const entry = entryOf(id)
  const stored = accept(entry, bagOf(entry.scope)[id]) ?? readLegacy(entry)
  if (stored === null) return entry.fallback
  if (entry.kind !== 'record') return stored
  return { ...(entry.fallback as Record<string, boolean>), ...(stored as Record<string, boolean>) }
}

/**
 * What is actually STORED for a record — the overlay, with nothing merged in.
 * The one caller that needs it is the writer (`app/panelPrefs.ts`): storing the
 * merged value would freeze today's defaults into an operator's browser, so a
 * later change to a declared default would never reach anyone who had ever
 * touched a single panel.
 */
export function readRecordOverlay(id: string): Readonly<Record<string, boolean>> {
  const entry = entryOf(id)
  const stored = accept(entry, bagOf(entry.scope)[id]) ?? readLegacy(entry)
  return isFlagRecord(stored) ? stored : {}
}

/** A record entry's declared default, for a caller that needs the per-field default rather than the value. */
export function fallbackRecord(id: string): Readonly<Record<string, boolean>> {
  const { fallback } = entryOf(id)
  return isFlagRecord(fallback) ? fallback : {}
}

/** The one string a `choice` is set to — the narrow read a control wants, without a cast at every call site. */
export function readChoice(id: string): string {
  const value = readPreference(id)
  return typeof value === 'string' ? value : String(entryOf(id).fallback)
}

export function readFlag(id: string): boolean {
  const value = readPreference(id)
  return typeof value === 'boolean' ? value : false
}

/**
 * Set `id`, or throw.
 *
 * It throws on an unavailable entry rather than storing quietly: S1's
 * *unavailable* state disables the control, so a write that got here anyway
 * came from code that did not check, and storing a scene-quality level nothing
 * can render is precisely the "setting that claims to have changed something"
 * this PRD exists to prevent.
 *
 * Returns whether the value reached storage. `false` is S1's *error* state —
 * the caller keeps the in-memory value and the page says the preference did not
 * persist, rather than pretending it did.
 */
export function writePreference(id: string, value: PrefValue): boolean {
  const entry = entryOf(id)
  const unavailable = unavailabilityOf(entry)
  if (unavailable !== null) {
    throw new Error(`${id} is unavailable — ${unavailable}`)
  }
  const accepted = accept(entry, value)
  if (accepted === null) throw new Error(`${JSON.stringify(value)} is not a value ${id} accepts`)

  const wrote = writeBag(entry.scope, { ...bagOf(entry.scope), [id]: accepted })
  notify()
  return wrote
}

/** Put `id` back to its default — the stored value goes away entirely, legacy key and all. */
export function clearPreference(id: string): boolean {
  const entry = entryOf(id)
  const { [id]: _dropped, ...rest } = bagOf(entry.scope)
  let wrote = writeBag(entry.scope, rest)

  // The legacy fallback would otherwise resurrect the old value the moment the
  // new store went quiet — "restore defaults" that restores yesterday's
  // override is the exact opposite of ruling 4.
  if (entry.legacy !== null) {
    const legacy = readJson(entry.scope, entry.legacy.key)
    if (entry.legacy.field === null) {
      if (Object.keys(legacy).length > 0) wrote = writeJson(entry.scope, entry.legacy.key, {}) && wrote
    } else if (entry.legacy.field in legacy) {
      const { [entry.legacy.field]: _legacyDropped, ...legacyRest } = legacy
      wrote = writeJson(entry.scope, entry.legacy.key, legacyRest) && wrote
    }
  }

  notify()
  return wrote
}

function sameValue(a: PrefValue, b: PrefValue): boolean {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/** Whether `id` is currently something other than its default — ruling 4's per-control marker. */
export function isOverridden(id: string): boolean {
  const entry = entryOf(id)
  return !sameValue(readPreference(id), entry.fallback)
}

/** Restore one group's own scope (ruling 4). Per scope, because a group may hold more than one. */
export function restoreDefaults(group: GroupId, scope: PrefScope): void {
  for (const entry of entriesOf(group)) {
    if (entry.scope !== scope) continue
    if (unavailabilityOf(entry) !== null) continue
    clearPreference(entry.id)
  }
}

// ── the change signal ───────────────────────────────────────────────────────

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Hear every preference change, wherever it was made.
 *
 * Needed because the registry is module state behind two stores, not React
 * state: `app/panelPrefs.ts`'s hooks and the settings page's own controls read
 * the same keys from different trees, and "restore defaults" has to reach a
 * panel that never re-rendered for any other reason.
 */
export function subscribeToPreferences(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
