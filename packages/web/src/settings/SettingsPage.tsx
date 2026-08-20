import { useEffect, useState } from 'react'
import { Nav } from '../app/Nav.js'
import { UNAVAILABLE } from '../connect/meta.js'
import { usePreferenceApplication } from './apply.js'
import { hostName } from './host.js'
import {
  adoptRepoScope,
  entriesOf,
  groupUnavailabilityOf,
  isOverridden,
  readFlag,
  readPreference,
  restoreDefaults,
  scopesIn,
  SCOPE_WORD,
  SETTINGS_GROUPS,
  subscribeToPreferences,
  unavailabilityOf,
  writePreference,
  type PrefEntry,
  type PrefScope,
  type PrefValue,
  type SettingsGroup,
} from './registry.js'
import { TelemetryBlock } from './TelemetryBlock.js'

/**
 * THE SETTINGS SURFACE (prd-35 S1, wave 1; #550) — replacing #549's stub, which
 * held the route open and said so.
 *
 * **What this page is for, and what it is not for.** Ruling 1 splits three jobs
 * across three surfaces and forbids the overlap: settings CHANGES things,
 * `/connect` PROVES things, first-run (prd-34) WALKS you through both. So there
 * is no diagnostic here — nothing on this page claims that anything works — and
 * a control that changes something appears exactly once in the app. Two keys
 * already had their one control elsewhere before this page existed (the scene's
 * hide-finished toggle, each panel's own collapse), so those are surveyed here
 * rather than duplicated: their state, their default, and the way back.
 *
 * **Eight groups, and every one of them renders.** S1 names the eight in order.
 * Three act in a browser (Appearance, Motion, Telemetry); two more —
 * Notifications and Application — are declared, persisted and explained here and
 * turn on when prd-34's shell hosts this page, without the shell lane editing a
 * file under `settings/` (`host.ts` carries that decision and its reasoning).
 * The last three render DISABLED WITH THEIR REASON — never hidden, never absent
 * — because a settings surface that shows only what it can already do teaches a
 * person that the instrument cannot be told the rest, which is a stronger and
 * falser claim than "not yet, and here is what brings it".
 *
 * **A group states its reason once, and its rows are merely disabled.** Eight
 * copies of "there is no desktop shell here" is how a person learns to skip the
 * `not yet` colour, and the one row that has its OWN reason — a shell whose tray
 * never appeared — is then the one they would skip. {@link unavailabilityOf}'s
 * group-first ordering is what buys that, and the coverage law checks the
 * resolved reason is on screen rather than checking which paragraph it came
 * from.
 *
 * **Every control says what it defaults to and whether it has been changed**
 * (ruling 4), and every group offers a restore per scope it holds — per scope,
 * not per group, because Appearance holds machine-scoped preferences beside one
 * repo-scoped one and "restore defaults" that silently crossed that line would
 * be the scope confusion ruling 3 exists to prevent.
 *
 * **Native form elements throughout**, so the keyboard path is the browser's
 * own rather than a re-implementation: radios in a `fieldset` with a `legend`,
 * real labels, the one `:focus-visible` token (`focus-ring`). `Escape` does
 * nothing here — this is a page, not a dialog.
 *
 * **Replay (S1's *replay* state) disables nothing here, and that is a finding
 * rather than an omission.** The rule is that a control which would change LIVE
 * behaviour stands down while a recording is loaded. Every control here changes
 * how the instrument is drawn for the person reading it (theme, density,
 * motion) or how the machine hosting it behaves (the tray, the notifier, the
 * updater) — none of which is a fact about the fleet on screen, so all of them
 * are as true of a recording as of a live session. **Wave 2 did not change
 * that**: the one control that would have reached the live fleet, the watched
 * repo, is still disabled with its reason, because retarget-in-place remains
 * prd-20's own unruled open question. That control is where the `useMode()`
 * check lands, on the day it exists.
 */

export interface SettingsPageProps {
  /**
   * The repo the fold currently describes (`app/streamState.ts`'s
   * `foldedRepoPath`, passed in by `index.tsx`). It is what repo-scoped
   * preferences are bucketed under — see {@link adoptRepoScope} — and what the
   * disabled Repo group names, so a person can at least see which repo the
   * settings they are looking at belong to.
   */
  repoPath?: string | null
}

export function SettingsPage({ repoPath = null }: SettingsPageProps = {}) {
  usePreferenceApplication()
  useRegistryRevision()

  useEffect(() => {
    adoptRepoScope(repoPath)
  }, [repoPath])

  return (
    <div data-testid="settings-page" className="flex h-screen flex-col bg-(--surface-floor) font-sans text-(--ink-body)">
      <Nav />
      <header className="flex shrink-0 items-baseline gap-4 border-b border-(--line-hair) bg-(--surface-panel) px-4 py-3">
        <h1 className="page-title text-(--ink-primary)">Settings</h1>
        <span className="text-inst normal-case tracking-normal text-(--ink-dim)">
          everything this instrument can be told — and, below each group, what it will not be
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* Two columns on a desktop panel (loop 15): the groups are cards, and a
            single 48rem column on a 1400px window was leaving half the page
            blank while the reader scrolled. `items-start` keeps each card its
            own height — this is a survey, not a table. */}
        <div className="max-w-6xl columns-1 gap-(--space-gutter) md:columns-2">
          {SETTINGS_GROUPS.map((group) => (
            <GroupSection key={group.id} group={group} repoPath={repoPath} />
          ))}
        </div>
      </main>
    </div>
  )
}

/**
 * Re-render when anything anywhere writes a preference. The registry is module
 * state behind two browser stores rather than React state — that is what lets
 * `app/panelPrefs.ts` and this page read the same keys without a provider
 * between them — so the page subscribes rather than deriving.
 */
function useRegistryRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeToPreferences(() => setRevision((previous) => previous + 1)), [])
  return revision
}

function GroupSection({ group, repoPath }: { group: SettingsGroup; repoPath: string | null }) {
  const entries = entriesOf(group.id)
  const reason = groupUnavailabilityOf(group)
  const disabled = reason !== null

  return (
    <section
      data-testid={`settings-group-${group.id}`}
      data-unavailable={disabled ? 'true' : undefined}
      aria-labelledby={`settings-group-${group.id}-heading`}
      className={`mb-(--space-gutter) break-inside-avoid rounded-plate border border-(--line-hair) bg-(--surface-panel) px-4 py-3 shadow-(--elev-raised) ${disabled ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`settings-group-${group.id}-heading`} className="text-read-body text-(--ink-primary)">
          {group.title}
        </h2>
        <p className="text-inst text-(--ink-dim)">{group.what}</p>
      </div>

      {reason !== null ? (
        <p
          data-testid={`settings-group-${group.id}-reason`}
          className="mt-2 text-inst text-notice"
        >
          not yet — {reason}
        </p>
      ) : null}

      {group.id === 'repo' ? (
        <p data-testid="settings-watched-repo" className="mt-2 figures text-inst text-(--ink-body)">
          watching: {repoPath ?? UNAVAILABLE}
        </p>
      ) : null}

      {/* Which side of the answer a person is on, for the one group whose whole
          availability is a fact about the host rather than about the product. */}
      {group.id === 'application' ? (
        <p data-testid="settings-host" className="mt-2 text-inst text-(--ink-dim)">
          running in: {hostName()}
        </p>
      ) : null}

      {group.id === 'telemetry' ? <TelemetryBlock /> : null}

      {entries.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-4">
          {entries.map((entry) => (
            <PrefRow key={entry.id} entry={entry} groupReason={reason} />
          ))}
        </ul>
      ) : null}

      {scopesIn(group.id).map((scope) => (
        <RestoreDefaults key={scope} group={group} scope={scope} />
      ))}
    </section>
  )
}

/**
 * One preference, whole: what it is, what it is set to, what it defaults to,
 * whether that differs, and — when there is one — the honest-gap note saying
 * what part of it has not arrived yet.
 */
function PrefRow({ entry, groupReason }: { entry: PrefEntry; groupReason: string | null }) {
  const overridden = isOverridden(entry.id)
  const value = readPreference(entry.id)
  const unavailable = unavailabilityOf(entry)
  // The group has already said its piece above; this row speaks only when the
  // reason is its own.
  const ownReason = unavailable !== null && unavailable !== groupReason ? unavailable : null

  return (
    <li
      data-pref={entry.id}
      data-scope={entry.scope}
      data-overridden={overridden ? 'true' : 'false'}
      className="flex flex-col gap-1 border-t border-(--line-hair) pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-inst text-(--ink-primary)">{entry.label}</span>
        <span className="text-inst-dense uppercase tracking-wider text-(--ink-dim)">{SCOPE_WORD[entry.scope]}</span>
        {overridden ? (
          <span
            data-testid={`pref-${entry.id}-modified`}
            className="figures rounded border border-notice/60 px-1 text-inst-dense uppercase tracking-wider text-notice"
          >
            modified
          </span>
        ) : null}
      </div>
      <p className="text-inst text-(--ink-dim)">{entry.what}</p>

      {entry.control === 'settings' ? (
        entry.kind === 'flag' ? (
          <FlagControl entry={entry} unavailable={unavailable} />
        ) : (
          <ChoiceControl entry={entry} unavailable={unavailable} />
        )
      ) : (
        <p data-testid={`pref-${entry.id}-state`} className="figures text-inst text-(--ink-body)">
          {describeValue(entry, value)} — set from {entry.control.surface}. {entry.control.why}
        </p>
      )}

      <p data-testid={`pref-${entry.id}-default`} className="figures text-inst text-(--ink-dim)">
        default: {describeValue(entry, entry.fallback)}
      </p>

      {ownReason !== null ? (
        <p data-testid={`pref-${entry.id}-unavailable`} className="text-inst text-notice">
          not yet — {ownReason}
        </p>
      ) : null}

      {entry.gap !== null ? (
        <p data-testid={`pref-${entry.id}-gap`} className="text-inst text-notice">
          what it does not do yet — {entry.gap}
        </p>
      ) : null}
    </li>
  )
}

/**
 * A radio group, because a preference with three named values is a radio group
 * — a `<select>` hides two thirds of the answer behind a click, and this page's
 * whole job is showing a person what their options are.
 *
 * S1's *error* state is {@link UnpersistedNote}'s, shared with the flag control
 * — a write that does not reach storage leaves the chosen value in memory and
 * says so, rather than snapping the control back to a value the person did not
 * choose and explaining nothing.
 */
function ChoiceControl({ entry, unavailable }: { entry: PrefEntry; unavailable: string | null }) {
  const [unpersisted, setUnpersisted] = useState<string | null>(null)
  const stored = readPreference(entry.id)
  const value = unpersisted ?? (typeof stored === 'string' ? stored : String(entry.fallback))
  const disabled = unavailable !== null

  const choose = (next: string) => {
    setUnpersisted(writePreference(entry.id, next) ? null : next)
  }

  return (
    <>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 border-0 p-0" disabled={disabled}>
        <legend className="sr-only">{entry.label}</legend>
        {entry.options.map((option) => (
          <label
            key={option.value}
            className={`flex items-center gap-1.5 rounded-ctl border px-2 py-1 text-inst transition-[color,border-color] duration-(--duration-touch) ${
              disabled
                ? 'cursor-not-allowed border-(--line-hair) text-(--ink-dim) opacity-70'
                : 'cursor-pointer border-(--line-hair) text-(--ink-body) has-[:checked]:border-(--ink-dim) has-[:checked]:text-(--ink-primary) hover:border-(--ink-dim)'
            }`}
          >
            <input
              type="radio"
              className="focus-ring"
              name={entry.id}
              value={option.value}
              data-testid={`pref-${entry.id}-${option.value}`}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => choose(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <UnpersistedNote entry={entry} shown={unpersisted !== null ? unpersisted : null} />
    </>
  )
}

/**
 * A two-state preference, as a checkbox — the browser's own control for "this
 * or not this", with the entry's own two words beside it rather than a bare tick
 * (`describeValue`'s rule, held here too: settings has to read correctly with
 * the thing it configures nowhere on screen).
 *
 * It carries the same *error* state as {@link ChoiceControl}, through the same
 * component, because a flag that failed to persist is the identical claim and
 * two wordings of it is one wording waiting to go stale.
 */
function FlagControl({ entry, unavailable }: { entry: PrefEntry; unavailable: string | null }) {
  const [unpersisted, setUnpersisted] = useState<boolean | null>(null)
  const stored = readFlag(entry.id)
  const value = unpersisted ?? stored
  const disabled = unavailable !== null
  const [whenTrue, whenFalse] = entry.words ?? ['on', 'off']

  return (
    <>
      <label
        className={`inline-flex w-fit items-center gap-1.5 rounded-ctl border px-2 py-1 text-inst transition-[color,border-color] duration-(--duration-touch) ${
          disabled
            ? 'cursor-not-allowed border-(--line-hair) text-(--ink-dim) opacity-70'
            : 'cursor-pointer border-(--line-hair) text-(--ink-body) has-[:checked]:border-(--ink-dim) has-[:checked]:text-(--ink-primary) hover:border-(--ink-dim)'
        }`}
      >
        <input
          type="checkbox"
          className="focus-ring"
          name={entry.id}
          data-testid={`pref-${entry.id}-toggle`}
          checked={value}
          disabled={disabled}
          onChange={() => {
            const next = !value
            setUnpersisted(writePreference(entry.id, next) ? null : next)
          }}
        />
        {value ? whenTrue : whenFalse}
      </label>
      <UnpersistedNote entry={entry} shown={unpersisted !== null ? (unpersisted ? whenTrue : whenFalse) : null} />
    </>
  )
}

/**
 * S1's *error* state, in one place: a write that did not reach storage leaves
 * the chosen value in memory and says so, rather than snapping the control back
 * to a value the person did not choose and explaining nothing.
 */
function UnpersistedNote({ entry, shown }: { entry: PrefEntry; shown: string | null }) {
  if (shown === null) return null
  return (
    <p data-testid={`pref-${entry.id}-error`} className="text-inst text-notice">
      this machine refused to store the preference — {entry.label} is {shown} for as long as this page stays
      open, and back to its stored value after a reload.
    </p>
  )
}

/** Ruling 4's way back, one per scope the group holds. Disabled — with the reason — when nothing is overridden. */
function RestoreDefaults({ group, scope }: { group: SettingsGroup; scope: PrefScope }) {
  const restorable = entriesOf(group.id).filter(
    (entry) => entry.scope === scope && unavailabilityOf(entry) === null,
  )
  const changed = restorable.filter((entry) => isOverridden(entry.id))

  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        data-testid={`restore-${group.id}-${scope}`}
        disabled={changed.length === 0}
        onClick={() => restoreDefaults(group.id, scope)}
        className="focus-ring shrink-0 rounded border border-(--line-strong) px-2 py-1 text-inst-dense uppercase tracking-wider text-(--ink-dim) enabled:hover:border-(--ink-dim) enabled:hover:text-(--ink-primary) disabled:cursor-not-allowed disabled:opacity-60"
      >
        restore defaults · {SCOPE_WORD[scope]}
      </button>
      <span className="text-inst text-(--ink-dim)">
        {changed.length === 0
          ? `nothing changed for ${SCOPE_WORD[scope]}`
          : `${changed.length} changed: ${changed.map((entry) => entry.label).join(', ')}`}
      </span>
    </div>
  )
}

/**
 * A stored value in words. A flag or a record says what it MEANS (`collapsed`,
 * not `true`) using the entry's own two words — settings has to be readable
 * with the panel that owns the key nowhere on screen.
 */
function describeValue(entry: PrefEntry, value: PrefValue): string {
  if (typeof value === 'string') {
    return entry.options.find((option) => option.value === value)?.label ?? value
  }
  const [whenTrue, whenFalse] = entry.words ?? ['on', 'off']
  if (typeof value === 'boolean') return value ? whenTrue : whenFalse

  const fallback = entry.fallback
  const keys = new Set([
    ...Object.keys(value),
    ...(typeof fallback === 'object' ? Object.keys(fallback) : []),
  ])
  if (keys.size === 0) return 'nothing set'
  return [...keys]
    .sort()
    .map((key) => `${key} ${value[key] === true ? whenTrue : whenFalse}`)
    .join(', ')
}
