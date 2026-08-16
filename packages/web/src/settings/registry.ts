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
 */

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
   */
  readonly unavailable: string | null
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
   * the two this wave delivers. A group riding another PRD renders DISABLED WITH
   * ITS REASON, never hidden and never absent, so the shape of the surface is
   * the truth about what the instrument can be told.
   */
  readonly unavailable: string | null
}

/**
 * S1's eight groups, in S1's order. Two are live in this wave (prd-35's own
 * sequencing: "appearance, motion and density only, since those are the settings
 * that exist to be set once prd-32 lands"); the other six name the PRD that
 * brings them.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    what: 'what the instrument looks like, and how much of the picture it draws.',
    unavailable: null,
  },
  {
    id: 'motion',
    title: 'Motion',
    what: 'how much of it moves. A health control, not decoration (ruling 5).',
    unavailable: null,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    what: 'per condition — needs a human, died, landed, spend threshold — plus quiet hours.',
    unavailable:
      'nothing in the instrument can wake you yet, so a switch here would arm an alert that never fires. prd-34 ships the desktop shell that can; this group turns on with it.',
  },
  {
    id: 'application',
    title: 'Application',
    what: 'close to tray · tray badge · launch on login · update channel.',
    unavailable:
      'this is a browser, not the desktop shell — there is no tray to close to and no login to launch from, and the shell keeps this state in its own store rather than here. prd-34 ships the shell; run inside it and this group is live.',
  },
  {
    id: 'repo',
    title: 'Repo',
    what: 'which repository this instrument is watching.',
    unavailable:
      'the watched repo is a command-line argument today. Changing it from here means driving the concierge picker (prd-20), which prd-35 wave 2 reuses rather than reimplements — so the repo is shown here and set there, for now.',
  },
  {
    id: 'telemetry',
    title: 'Telemetry',
    what: 'the env block for this instance, copyable, with the same warning /connect gives it.',
    unavailable:
      "the block and its same-process warning already exist on /connect, and copying them here before wave 2 wires the two together would leave two places to keep in step. Until then /connect is where it is read.",
  },
  {
    id: 'you',
    title: 'You',
    what: 'your display name and colour, defaulting to the git identity already in the log.',
    unavailable:
      'nothing reads a display name or a colour yet — prd-37 introduces the identity declaration that gives one somewhere to go. A field stored before then would describe a person to nobody.',
  },
  {
    id: 'sharing',
    title: 'Sharing',
    what: 'facts always; your words only if you share them.',
    unavailable:
      'no team server is configured, so there is no other end for an opt-in to reach and no words that could leave this machine. prd-37 brings both, and the default stays facts-only when it does.',
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
    fallback: 'system',
    words: null,
    control: 'settings',
    unavailable: null,
    gap: "there is one palette. Choosing light records the choice and sets `data-theme`, and the colours stay dark, because `theme/theme.css` declares no `[data-theme='light']` block yet — so the instrument is telling you what it stored, not what it drew. #551 authors that block, and this control needs no change when it lands.",
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
    gap: 'nothing reads `data-density` yet. Choosing compact records the choice and changes no spacing, so the surface would look untouched while the preference is genuinely stored. prd-32 lands the density tokens that read it.',
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
    unavailable:
      "the levels are prd-33's to define — `calm`, `rich` and `maximum` name nothing in the renderer yet, and storing a level no renderer reads would be a control that claims to have changed the picture. The control is here, disabled, so the place it will act from is not invented later.",
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
    gap: null,
    legacy: { key: 'rhizomorph.scenePrefs.v1', field: 'hideFinished' },
  },
  {
    id: 'appearance.panelsCollapsed',
    group: 'appearance',
    label: 'Collapsed panels',
    what: 'which panels you have folded away, remembered for this repo.',
    scope: 'repo',
    kind: 'record',
    options: [],
    fallback: { collisions: false, feed: true },
    words: ['collapsed', 'expanded'],
    control: {
      surface: "each panel's own header",
      testId: null,
      why: 'folding the panel in front of you is direct manipulation, not configuration; its header carries the one control. What settings owns is the survey — which panels are not where they started, and the way back.',
    },
    unavailable: null,
    gap: null,
    legacy: { key: 'rhizomorph.panelCollapsed.v1', field: null },
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
    gap: "the scene and the attention strip still read `prefers-reduced-motion` themselves. Choosing *still* records the choice and sets `data-motion`, and the canvas keeps its ambient breath until it reads that attribute — so this control is honest about being half-arrived rather than quietly ineffective. prd-33's scene lane adopts it. Ruling 5's floor is already law here: `resolveMotion` cannot return more motion than the system asked for.",
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
  if (entry.unavailable !== null) {
    throw new Error(`${id} is unavailable — ${entry.unavailable}`)
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
    if (entry.unavailable !== null) continue
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
