import { useEffect, useState } from 'react'
import { Nav } from '../app/Nav.js'
import { UNAVAILABLE } from '../connect/meta.js'
import { usePreferenceApplication } from './apply.js'
import {
  adoptRepoScope,
  entriesOf,
  isOverridden,
  readPreference,
  restoreDefaults,
  scopesIn,
  SCOPE_WORD,
  SETTINGS_GROUPS,
  subscribeToPreferences,
  writePreference,
  type PrefEntry,
  type PrefScope,
  type PrefValue,
  type SettingsGroup,
} from './registry.js'

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
 * **Eight groups, and six of them are disabled.** S1 names the eight in order,
 * and this wave delivers Appearance and Motion. The other six render DISABLED
 * WITH THEIR REASON — never hidden, never absent — because a settings surface
 * that shows only what it can already do teaches a person that the instrument
 * cannot be told the rest, which is a stronger and falser claim than "not yet,
 * and here is what brings it".
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
 * behaviour stands down while a recording is loaded. Every control this wave
 * ships — theme, density, motion — changes how the instrument is drawn for the
 * person reading it, which is as true of a recording as of a live fleet. The
 * first control that would reach the live fleet (the watched repo, wave 2) is
 * where that state earns its `useMode()` check.
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
    <div data-testid="settings-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <Nav />
      <header className="flex shrink-0 items-baseline gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <h1 className="text-sm text-ice-100">Settings</h1>
        <span className="text-[length:var(--text-inst)] normal-case tracking-normal text-ice-400">
          everything this instrument can be told — and, below each group, what it will not be
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex max-w-3xl flex-col gap-6">
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
  const disabled = group.unavailable !== null

  return (
    <section
      data-testid={`settings-group-${group.id}`}
      data-unavailable={disabled ? 'true' : undefined}
      aria-labelledby={`settings-group-${group.id}-heading`}
      className={`rounded border border-ice-850 bg-ice-950 px-4 py-3 ${disabled ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`settings-group-${group.id}-heading`} className="text-sm text-ice-100">
          {group.title}
        </h2>
        <p className="text-[length:var(--text-inst)] text-ice-400">{group.what}</p>
      </div>

      {disabled ? (
        <p
          data-testid={`settings-group-${group.id}-reason`}
          className="mt-2 text-[length:var(--text-inst)] text-notice"
        >
          not yet — {group.unavailable}
        </p>
      ) : null}

      {group.id === 'repo' ? (
        <p data-testid="settings-watched-repo" className="mt-2 figures text-[length:var(--text-inst)] text-ice-300">
          watching: {repoPath ?? UNAVAILABLE}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-4">
          {entries.map((entry) => (
            <PrefRow key={entry.id} entry={entry} />
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
function PrefRow({ entry }: { entry: PrefEntry }) {
  const overridden = isOverridden(entry.id)
  const value = readPreference(entry.id)

  return (
    <li
      data-pref={entry.id}
      data-scope={entry.scope}
      data-overridden={overridden ? 'true' : 'false'}
      className="flex flex-col gap-1 border-t border-ice-900 pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[length:var(--text-inst)] text-ice-100">{entry.label}</span>
        <span className="text-[length:var(--text-inst-dense)] uppercase tracking-wider text-ice-400">{SCOPE_WORD[entry.scope]}</span>
        {overridden ? (
          <span
            data-testid={`pref-${entry.id}-modified`}
            className="figures rounded border border-notice/60 px-1 text-[length:var(--text-inst-dense)] uppercase tracking-wider text-notice"
          >
            modified
          </span>
        ) : null}
      </div>
      <p className="text-[length:var(--text-inst)] text-ice-400">{entry.what}</p>

      {entry.control === 'settings' ? (
        <ChoiceControl entry={entry} />
      ) : (
        <p data-testid={`pref-${entry.id}-state`} className="figures text-[length:var(--text-inst)] text-ice-300">
          {describeValue(entry, value)} — set from {entry.control.surface}. {entry.control.why}
        </p>
      )}

      <p data-testid={`pref-${entry.id}-default`} className="figures text-[length:var(--text-inst)] text-ice-400">
        default: {describeValue(entry, entry.fallback)}
      </p>

      {entry.unavailable !== null ? (
        <p data-testid={`pref-${entry.id}-unavailable`} className="text-[length:var(--text-inst)] text-notice">
          not yet — {entry.unavailable}
        </p>
      ) : null}

      {entry.gap !== null ? (
        <p data-testid={`pref-${entry.id}-gap`} className="text-[length:var(--text-inst)] text-notice">
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
 * S1's *error* state lives here: a write that does not reach storage leaves the
 * chosen value in memory and says so, rather than snapping the control back to
 * a value the person did not choose and explaining nothing.
 */
function ChoiceControl({ entry }: { entry: PrefEntry }) {
  const [unpersisted, setUnpersisted] = useState<string | null>(null)
  const stored = readPreference(entry.id)
  const value = unpersisted ?? (typeof stored === 'string' ? stored : String(entry.fallback))
  const disabled = entry.unavailable !== null

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
            className={`flex items-center gap-1.5 text-[length:var(--text-inst)] ${
              disabled ? 'cursor-not-allowed text-ice-400 opacity-70' : 'cursor-pointer text-ice-200'
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
      {unpersisted !== null ? (
        <p data-testid={`pref-${entry.id}-error`} className="text-[length:var(--text-inst)] text-notice">
          this machine refused to store the preference — {entry.label} is {unpersisted} for as long as this
          page stays open, and back to its stored value after a reload.
        </p>
      ) : null}
    </>
  )
}

/** Ruling 4's way back, one per scope the group holds. Disabled — with the reason — when nothing is overridden. */
function RestoreDefaults({ group, scope }: { group: SettingsGroup; scope: PrefScope }) {
  const restorable = entriesOf(group.id).filter((entry) => entry.scope === scope && entry.unavailable === null)
  const changed = restorable.filter((entry) => isOverridden(entry.id))

  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        data-testid={`restore-${group.id}-${scope}`}
        disabled={changed.length === 0}
        onClick={() => restoreDefaults(group.id, scope)}
        className="focus-ring shrink-0 rounded border border-ice-800 px-2 py-1 text-[length:var(--text-inst-dense)] uppercase tracking-wider text-ice-400 enabled:hover:border-ice-600 enabled:hover:text-ice-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        restore defaults · {SCOPE_WORD[scope]}
      </button>
      <span className="text-[length:var(--text-inst)] text-ice-400">
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
