import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTheme } from './apply.js'
import { HOST_GLOBAL, type HostCapability } from './host.js'
import {
  adoptRepoScope,
  clearPreference,
  currentRepoScope,
  entriesOf,
  entryOf,
  groupOf,
  groupUnavailabilityOf,
  isOverridden,
  PREF_SCOPES,
  PREFERENCES,
  readFlag,
  readPreference,
  readRecordOverlay,
  restoreDefaults,
  scopesIn,
  subscribeToPreferences,
  UNADOPTED_REPO,
  unavailabilityOf,
  writePreference,
} from './registry.js'

/**
 * THE REGISTRY'S OWN BEHAVIOUR (prd-35 rulings 3 and 4; #550) — scope,
 * survival, and the way back.
 *
 * The claims that matter here are the two S1 states a person can be hurt by: a
 * repo-scoped preference LEAKING into another repo (which would silently apply
 * one repo's layout to another's panels), and a preference that cannot be put
 * back (which is what makes fiddling unsafe).
 */

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // The adopted repo is module state, so it outlives `localStorage.clear()`.
  adoptRepoScope(null)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('defaults, and what "unset" means', () => {
  it('reads every declared preference as its own default with nothing stored', () => {
    for (const entry of PREFERENCES) {
      expect(readPreference(entry.id), `${entry.id} does not read as its default`).toEqual(entry.fallback)
      expect(isOverridden(entry.id)).toBe(false)
    }
  })

  it('refuses a value the entry does not offer, rather than storing it', () => {
    expect(() => writePreference('appearance.theme', 'sepia')).toThrow(/not a value/)
    expect(readPreference('appearance.theme')).toBe('dark')
  })

  it('refuses to store anything for a control that cannot act', () => {
    // S1's *unavailable* state disables the control, so a write that arrived
    // here came from code that did not check. Scene quality went LIVE (loop
    // 6) so the example is now close-to-tray, which stays unavailable until a
    // host announces a tray — and this jsdom announces nothing.
    expect(() => writePreference('application.closeToTray', false)).toThrow(/unavailable/)
    expect(readPreference('application.closeToTray')).toBe(true)
  })

  it('falls back to the default when the stored JSON is malformed', () => {
    localStorage.setItem('rhizomorph.prefs.machine.v1', '{not json')
    expect(readPreference('appearance.theme')).toBe('dark')
  })

  it('treats a retired option as unset rather than as a value', () => {
    localStorage.setItem('rhizomorph.prefs.machine.v1', JSON.stringify({ 'appearance.theme': 'sepia' }))
    expect(readPreference('appearance.theme')).toBe('dark')
  })
})

describe('ruling 3 — scope', () => {
  it('declares three scopes and keeps the third one empty on purpose', () => {
    expect(PREF_SCOPES).toEqual(['machine', 'repo', 'session'])
    // Reserved, so a future transient preference has somewhere to be transient
    // instead of silently becoming permanent.
    expect(PREFERENCES.filter((entry) => entry.scope === 'session')).toEqual([])
  })

  it('keeps machine-scoped values out of session storage entirely', () => {
    writePreference('appearance.theme', 'dark')
    writePreference('motion.level', 'still')

    expect(sessionStorage.length).toBe(0)
    expect(JSON.parse(localStorage.getItem('rhizomorph.prefs.machine.v1') ?? '{}')).toEqual({
      'appearance.theme': 'dark',
      'motion.level': 'still',
    })
  })

  it('does not leak a repo-scoped preference across repos, and gives it back when the repo returns', () => {
    adoptRepoScope('/repos/a')
    writePreference('appearance.panelsCollapsed', { fleet: true })
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })

    adoptRepoScope('/repos/b')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({})
    expect(readPreference('appearance.panelsCollapsed')).toEqual({})
    expect(isOverridden('appearance.panelsCollapsed')).toBe(false)

    // …and B's own answer does not reach back into A.
    writePreference('appearance.panelsCollapsed', { ledger: true })

    adoptRepoScope('/repos/a')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })
  })

  it('does not reset a machine-scoped preference when the watched repo changes', () => {
    adoptRepoScope('/repos/a')
    writePreference('appearance.theme', 'dark')

    adoptRepoScope('/repos/b')
    expect(readPreference('appearance.theme')).toBe('dark')
  })

  it('carries a first adoption forward, so nothing set before a repo was named is stranded', () => {
    // A person who collapsed a panel before anything told the registry which
    // repo it was in was still in a repo. That state belongs to the first one
    // adopted — and to that one only.
    expect(currentRepoScope()).toBe(UNADOPTED_REPO)
    writePreference('appearance.panelsCollapsed', { fleet: true })

    adoptRepoScope('/repos/a')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })

    adoptRepoScope('/repos/b')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({})
  })

  it('remembers the adopted repo across a reload, so a repo-scoped preference survives a restart', async () => {
    adoptRepoScope('/repos/a')
    writePreference('appearance.panelsCollapsed', { fleet: true })

    // A reload is a FRESH MODULE reading the same storage — which is the whole
    // of what is being tested, since the adopted repo is module state and would
    // otherwise be the one thing lost. Anything less than a real re-import
    // would test the memory rather than the persistence.
    vi.resetModules()
    const reloaded = await import('./registry.js')

    expect(reloaded.currentRepoScope()).toBe('/repos/a')
    expect(reloaded.readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })
  })

  it('reports which scopes a group holds, so a restore can be offered per scope', () => {
    expect(scopesIn('appearance')).toEqual(['machine', 'repo'])
    expect(scopesIn('motion')).toEqual(['machine'])
    // Notifications became machine-scoped when #574 declared its six keys —
    // ruling 3 puts notifications on the machine, not the repo.
    expect(scopesIn('notifications')).toEqual(['machine'])
    // Telemetry holds no key at all: it shows an env block and changes nothing,
    // so there is nothing to restore and no button offering to.
    expect(scopesIn('telemetry')).toEqual([])
  })
})

describe('ruling 4 — a changed setting looks changed, and can be put back', () => {
  it('marks a preference overridden only once it differs from its default', () => {
    expect(isOverridden('appearance.theme')).toBe(false)
    // Writing the default (dark, since #337) is not an override.
    writePreference('appearance.theme', 'dark')
    expect(isOverridden('appearance.theme')).toBe(false)

    writePreference('appearance.theme', 'light')
    expect(isOverridden('appearance.theme')).toBe(true)
  })

  it('restores one group and one scope, leaving the other scope in the same group alone', () => {
    adoptRepoScope('/repos/a')
    writePreference('appearance.theme', 'light')
    writePreference('appearance.panelsCollapsed', { fleet: true })
    writePreference('motion.level', 'still')

    restoreDefaults('appearance', 'machine')

    expect(readPreference('appearance.theme')).toBe('dark')
    // The repo-scoped member of the same group is untouched — a restore that
    // silently crossed scopes is the confusion ruling 3 exists to prevent.
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({ fleet: true })
    // …as is the other group.
    expect(readPreference('motion.level')).toBe('still')

    restoreDefaults('appearance', 'repo')
    expect(readRecordOverlay('appearance.panelsCollapsed')).toEqual({})
  })

  it('does not let a superseded legacy key resurrect an override that was just restored', () => {
    // The pre-registry key is a declared FALLBACK, so clearing the new store
    // without clearing it would put yesterday's override straight back — a
    // "restore defaults" that restores something other than the default.
    localStorage.setItem('rhizomorph.scenePrefs.v1', JSON.stringify({ hideFinished: true }))
    expect(readFlag('appearance.hideFinished')).toBe(true)

    clearPreference('appearance.hideFinished')
    expect(readFlag('appearance.hideFinished')).toBe(false)
  })

  it('offers a restore for every group that holds anything, and none for the groups that hold nothing yet', () => {
    for (const group of ['appearance', 'motion'] as const) {
      expect(entriesOf(group).length).toBeGreaterThan(0)
      expect(scopesIn(group).length).toBeGreaterThan(0)
    }
  })
})

describe('what the host clears, and what nothing can clear (#574)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HOST_GLOBAL]
  })

  function withHost(capabilities: readonly HostCapability[]): void {
    ;(globalThis as Record<string, unknown>)[HOST_GLOBAL] = { name: 'the desktop shell', capabilities }
  }

  it('refuses to store a hosted preference in a browser, and stores it under a shell', () => {
    expect(() => writePreference('notifications.landed', true)).toThrow(/unavailable/)
    expect(readPreference('notifications.landed')).toBe(false)

    withHost(['shell', 'notify'])
    expect(writePreference('notifications.landed', true)).toBe(true)
    expect(readPreference('notifications.landed')).toBe(true)
    expect(isOverridden('notifications.landed')).toBe(true)
  })

  it('asks the host for the capability the control names, not for the host in general', () => {
    // A shell whose tray never appeared is a real host (prd-34's own risk
    // register names the Linux tray), and it does not get the tray controls by
    // being a shell.
    withHost(['shell', 'launchAtLogin', 'updates'])

    expect(unavailabilityOf(entryOf('application.launchAtLogin'))).toBeNull()
    expect(unavailabilityOf(entryOf('application.trayBadge'))).toContain('no tray')
    expect(() => writePreference('application.trayBadge', false)).toThrow(/unavailable/)
  })

  it('takes the group down with it when the group itself is what is missing', () => {
    // `notify` alone does not make the Application group live, and the reason a
    // person reads is the group's rather than each row's.
    withHost(['notify'])

    expect(groupUnavailabilityOf(groupOf('notifications'))).toBeNull()
    expect(unavailabilityOf(entryOf('application.updateChannel'))).toBe(
      groupUnavailabilityOf(groupOf('application')),
    )
  })

  it('leaves a reason no host could clear exactly where it was', () => {
    // Scene quality, You and Sharing ride PRDs rather than capabilities:
    // `requires: null` means there is nothing to announce, so a shell declaring
    // everything changes none of them.
    withHost(['shell', 'tray', 'notify', 'launchAtLogin', 'updates'])

    // Scene quality is live now — the PRD-gated examples left are the groups.
    expect(unavailabilityOf(entryOf('appearance.sceneQuality'))).toBeNull()
    for (const id of ['you', 'sharing'] as const) {
      expect(groupUnavailabilityOf(groupOf(id)), id).not.toBeNull()
    }
    // The Repo group left this list in prd-55 wave 1: it holds `lab.models`,
    // a record a live control writes, so "the whole group cannot act" stopped
    // being true — and with `unavailabilityOf` reading the group first, a
    // reason left here would have thrown from every write to that record.
    expect(groupUnavailabilityOf(groupOf('repo'))).toBeNull()
  })

  it('restores only what can act, so a disabled control is not quietly rewritten', () => {
    withHost(['shell', 'notify'])
    writePreference('notifications.landed', true)
    withHost(['notify'])

    // The Application group went away with the shell; restoring the machine
    // scope of a live group must not reach into it.
    restoreDefaults('notifications', 'machine')
    expect(readPreference('notifications.landed')).toBe(false)

    restoreDefaults('application', 'machine')
    expect(() => writePreference('application.closeToTray', false)).toThrow(/unavailable/)
  })
})

describe('the change signal, and the error state', () => {
  it('tells every listener when anything is written, restored or re-scoped', () => {
    const heard: string[] = []
    const stop = subscribeToPreferences(() => heard.push('change'))

    writePreference('appearance.theme', 'dark')
    restoreDefaults('appearance', 'machine')
    adoptRepoScope('/repos/a')

    expect(heard.length).toBeGreaterThanOrEqual(3)

    stop()
    writePreference('appearance.theme', 'light')
    expect(heard.length).toBeGreaterThanOrEqual(3)
  })

  it('says a write did not persist rather than pretending it did (S1 error state)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(writePreference('appearance.theme', 'dark')).toBe(false)
  })
})

describe('the theme opens dark (#337 — operator ruling 2026-09-08; ui-2.0 D26)', () => {
  const theme = PREFERENCES.find((entry) => entry.id === 'appearance.theme')

  it("the registry's default is dark, not follow-the-system", () => {
    expect(theme?.fallback).toBe('dark')
  })

  it('a fresh machine whose OS prefers light still opens dark — the source theme, not the derived one', () => {
    expect(resolveTheme(String(theme?.fallback), { prefersLight: true, prefersReducedMotion: false })).toBe('dark')
  })

  it('following the system is still on offer — a choice, no longer the default', () => {
    expect(theme?.options?.map((option) => option.value)).toContain('system')
  })
})

describe("the lab model list is the operator's (prd-55 ruling 5, wave 1)", () => {
  it('seeds the three aliases on, and keeps the list with the repo rather than the machine', () => {
    const models = entryOf('lab.models')
    // The three names every dispatch in this repo has used, on by default so a
    // fresh repo's select is a list and not a blank. A list, never a gate: a
    // model absent here is still legal on the CLI, and the entry's own comment
    // says so before anything reads it.
    expect(models.fallback).toEqual({ opus: true, sonnet: true, haiku: true })
    // Which models a project tries is a fact about that project's experiments —
    // ruling 3's reason for panel collapse, and the same answer here.
    expect(models.scope).toBe('repo')
    // The Repo group held one scope until prd-55 wave 5 put `lab.agentCommand`
    // beside this row — see the R&D describe below for why that one is the
    // machine's. Declaration order, which is what `scopesIn` reports.
    expect(scopesIn('repo')).toEqual(['repo', 'machine'])
  })

  it('can be written and put back — the Repo group is live, so adding a model does not throw', () => {
    // The mutation this pins: give the Repo group back its old `unavailable`
    // sentence and the first line below throws "lab.models is unavailable —
    // …", because `unavailabilityOf` reads the group before the entry. That
    // is exactly the launch panel's other… path, and it has to work.
    expect(unavailabilityOf(entryOf('lab.models'))).toBeNull()
    expect(writePreference('lab.models', { 'claude-opus-5': true })).toBe(true)
    // A record merges over its default: the three aliases stay offered.
    expect(readPreference('lab.models')).toEqual({ opus: true, sonnet: true, haiku: true, 'claude-opus-5': true })
    expect(isOverridden('lab.models')).toBe(true)

    restoreDefaults('repo', 'repo')
    expect(readPreference('lab.models')).toEqual({ opus: true, sonnet: true, haiku: true })
    expect(isOverridden('lab.models')).toBe(false)
  })
})

describe("the R&D hand is the operator's own CLI, declared here (prd-55 rulings 1 and 2, wave 5)", () => {
  it("keeps the agent command with the MACHINE, because a PATH is the machine's and not the repo's", () => {
    const command = entryOf('lab.agentCommand')
    expect(command.scope).toBe('machine')
    // The server resolves this name on its own PATH. Two repos watched from one
    // box cannot honestly disagree about what `claude` is, which is the whole
    // reason this one is not repo-scoped beside `lab.models`.
    expect(command.fallback).toBe('claude')
    expect(command.kind).toBe('choice')
  })

  it('says out loud that it cannot take a typed-in binary name, rather than offering a control that does nothing', () => {
    const command = entryOf('lab.agentCommand')
    // The honest kind available: `PrefKind` is choice | flag | record, and
    // `accept()` refuses a choice value outside `options` — so a free string is
    // structurally not storable here today. The row therefore offers the one
    // name the instrument ships with AND declares the gap; a row that quietly
    // offered nothing would read as a setting that does not exist.
    expect(command.options.map((option) => option.value)).toEqual(['claude'])
    expect(command.gap).not.toBeNull()
    expect(command.gap).toContain('free-text preference kind')
    expect(() => writePreference('lab.agentCommand', 'claude-code-wrapper')).toThrow(/is not a value/)
  })

  it('defaults the corpus to local, and the tracker is a second act the operator declares (ruling 2)', () => {
    const corpus = entryOf('lab.rdCorpus')
    expect(corpus.kind).toBe('flag')
    expect(corpus.fallback).toBe(false)
    expect(corpus.scope).toBe('repo')
    // `words` has to read correctly with the R&D panel nowhere on screen, so it
    // names the two corpora rather than saying "on" and "off".
    expect(corpus.words?.[0]).toContain('local+tracker')
    expect(corpus.words?.[1]).toContain('local')
  })

  it('both are storable and both come back — the Repo group is live, so neither throws', () => {
    expect(unavailabilityOf(entryOf('lab.agentCommand'))).toBeNull()
    expect(unavailabilityOf(entryOf('lab.rdCorpus'))).toBeNull()

    expect(writePreference('lab.rdCorpus', true)).toBe(true)
    expect(readFlag('lab.rdCorpus')).toBe(true)
    expect(isOverridden('lab.rdCorpus')).toBe(true)

    // Two scopes in one group, restored one at a time (ruling 4): restoring the
    // repo's own does not reach the machine-scoped row beside it.
    expect(writePreference('lab.agentCommand', 'claude')).toBe(true)
    restoreDefaults('repo', 'repo')
    expect(readFlag('lab.rdCorpus')).toBe(false)
    expect(readPreference('lab.agentCommand')).toBe('claude')
  })

  it('keeps the machine-scoped agent command out of the repo bucket entirely — watching another repo does not change what the binary is called', () => {
    adoptRepoScope('/repos/one')
    expect(writePreference('lab.rdCorpus', true)).toBe(true)

    adoptRepoScope('/repos/two')
    // The repo-scoped switch is the other repo's and does not follow…
    expect(readFlag('lab.rdCorpus')).toBe(false)
    // …while the machine-scoped command is the same machine's, whichever repo
    // this instrument happens to be watching.
    expect(readPreference('lab.agentCommand')).toBe('claude')
  })
})
