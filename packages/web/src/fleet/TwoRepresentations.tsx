import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { isTypingTarget } from '../app/keyboard.js'

/**
 * ONE SURFACE, TWO REPRESENTATIONS (prd-36 ruling 3 / S3, #555).
 *
 * The house pattern, written once: **one surface, two representations, one
 * toggle, shared state.** Organism ⇄ list is its first instance; prd-31's trace
 * (tree ⇄ gantt) and the history surface (by session ⇄ by lane) are the same
 * shape. Ruling 3's reason for writing it once rather than three times is that
 * the keyboard behaviour, the toggle chrome, the persistence key shape and the
 * "state survives the switch" guarantee cannot drift if there is only one of
 * them. A fourth instance is a row in {@link REPRESENTATION_INSTANCES}, not a
 * new component.
 *
 * The four guarantees, and where each one actually lives:
 *
 * - **State outside the representations survives the switch.** Structural, not
 *   promised: switching swaps only what `views[n].render()` returns, so every
 *   provider, every sibling and every piece of state above this component is
 *   untouched by a toggle. The fleet's shared selection survives because it
 *   lives in `SelectionProvider`, one level up, and this component cannot reach
 *   it.
 * - **The toggle is keyboard-operable and announces the active
 *   representation.** Real `<button>`s carrying `aria-pressed`, plus the
 *   instance's own single keystroke on `window`.
 * - **The preference persists at the declared scope** — see
 *   {@link RepresentationStore} and the note on the fleet instance's `gap`,
 *   which is honest about the one part of this contract wave 1 does not yet
 *   deliver.
 * - **No representation may be selected automatically by application state.**
 *   Also structural: this component takes no `value`, no `onChange` and no
 *   initial-representation seed, so there is no prop through which a fleet
 *   condition, an error or a loading state could flip it. The only writers are
 *   the two buttons and the keystroke — both a person's own act. An instrument
 *   that hid its own scene at the moment something broke would be hiding it
 *   exactly when a person most wants to look (ruling 1).
 */

/** Where an instance's choice is remembered, once something remembers it. */
export interface RepresentationPersistence {
  /** The `settings/registry.ts` preference id — the only place a key may be declared. */
  readonly key: string
  readonly scope: 'repo' | 'machine'
}

export interface RepresentationInstance {
  /** The surface's id. Stable: it is the persistence key's root and the toggle's test id. */
  readonly surface: string
  /** The surface's own word for itself, used in the toggle's accessible name. */
  readonly label: string
  /** The two representation ids, in toggle order. The first is what a fresh instrument shows. */
  readonly representations: readonly [string, string]
  /** One key, no modifiers, lowercase. */
  readonly keystroke: string
  /** Null while nothing remembers the choice — see `gap`. */
  readonly persistence: RepresentationPersistence | null
  /** Law 12's voice for a guarantee that has not fully arrived: what is missing, why, what fixes it. */
  readonly gap: string | null
}

/**
 * EVERY TWO-REPRESENTATION SURFACE IN THE INSTRUMENT.
 *
 * Deliberately a registry of what is **implemented**, not of what is planned.
 * prd-36 S3 names three instances — fleet, trace (prd-31) and history (prd-31
 * ruling 8) — and listing the two that do not exist yet would buy a longer
 * array at the cost of the only thing this registry is for: it is what
 * `two-representations-law.test.ts` enumerates, and a law that enumerates
 * absent surfaces cannot check anything about them. Trace and history join this
 * array in the commit that builds them, which is also the commit where the law
 * starts holding them to this component.
 *
 * {@link TwoRepresentations} throws on a surface that is not declared here, so
 * the registry cannot be bypassed by simply not adding a row.
 */
export const REPRESENTATION_INSTANCES: readonly RepresentationInstance[] = [
  {
    surface: 'fleet',
    label: 'Fleet',
    // Organism first: it is what the instrument opens on, and ruling 1 is
    // explicit that the list is the floor rather than the default — the art is
    // the enhancement, and an enhancement nobody is shown is not one.
    representations: ['organism', 'list'],
    // `v` for *view*. prd-36 leaves the key open ("grouped with the app's other
    // single-key verbs at dispatch"), so this is a choice, not a ruling: it is
    // the first letter of the thing it does and it collides with nothing —
    // `n`/`shift+n` are the page-global idle-worker jump (`app/keyboard.ts`),
    // `f`/`a` are the fleet table's own row verbs, and `0`/`1`/`+`/`-` are the
    // scene's camera. When the verb set is ruled on, this line is the change.
    keystroke: 'v',
    persistence: null,
    gap:
      'the choice is not remembered — reloading lands back on the organism. ' +
      'Every persisted key in this package must be declared in ' +
      '`settings/registry.ts` (prd-35 ruling 2: nothing persists unsurveyed, held ' +
      'by `settings/coverage-law.test.tsx`), and that file is held by another ' +
      'lane in this wave. Declaring `appearance.fleetRepresentation` at repo ' +
      'scope there and passing the matching `store` below is the whole of what ' +
      'is left; nothing in this component changes when it lands.',
  },
  {
    surface: 'history',
    label: 'History',
    // By session first: the recordings library was here before the lane axis
    // existed, so "what happened that night" is the reading a person already
    // has, and prd-31 ruling 8 is a widening of it rather than a replacement.
    representations: ['session', 'lane'],
    // `h` for *history*. Free by the same audit `v` passed: `n`/`shift+n` are
    // the page-global idle-worker jump, `f`/`a` the fleet table's row verbs,
    // `v` the fleet surface's own, and `/` the session search's. This instance
    // is only ever mounted on `/recordings`, so it cannot collide with the
    // balcony's keys even in principle.
    keystroke: 'h',
    persistence: null,
    gap:
      'the axis is not remembered — reloading /recordings lands back on the ' +
      'session axis. It is the same gap the fleet instance carries and it closes ' +
      'the same way: every persisted key in this package must be declared in ' +
      '`settings/registry.ts` (prd-35 ruling 2, held by ' +
      '`settings/coverage-law.test.tsx`), and this lane is fenced to one entry ' +
      'in that file — the dock tab (prd-32 S3, which rules that one persisted). ' +
      'Declaring `appearance.historyAxis` there and passing the matching `store` ' +
      'below is the whole of what is left; nothing in this component changes.',
  },
]

const BY_SURFACE = new Map(REPRESENTATION_INSTANCES.map((instance) => [instance.surface, instance]))

/** The instance for `surface`. Throws rather than defaulting: an undeclared surface is a bug, not a fallback. */
export function representationInstance(surface: string): RepresentationInstance {
  const instance = BY_SURFACE.get(surface)
  if (instance === undefined) {
    throw new Error(`no two-representation surface is declared under ${surface}`)
  }
  return instance
}

/**
 * The seam between this component and whatever remembers the choice.
 *
 * A seam rather than a direct `settings/registry.ts` call, for one reason worth
 * stating: this component may not name a storage key. The registry is the only
 * module in `packages/web/src` allowed to, and its coverage law sweeps the whole
 * package to prove it. So the caller — which is where the declared key lives —
 * hands the storage in, and this file stays a control rather than a second
 * store.
 *
 * `read` returning a representation id this instance does not declare is treated
 * as unset, the same posture `settings/registry.ts`'s own `accept` takes: a
 * retired option must read as "nothing stored", never as a crash on load.
 */
export interface RepresentationStore {
  read: () => string | null
  write: (representationId: string) => void
  /** Optional: hear a change made somewhere else (the settings page's restore-defaults). */
  subscribe?: (listener: () => void) => () => void
}

export interface RepresentationView {
  /** One of the ids the instance declares, in the same order. */
  id: string
  /** The toggle's own word for this representation. */
  label: string
  render: () => ReactNode
}

export interface TwoRepresentationsProps {
  /** Must be declared in {@link REPRESENTATION_INSTANCES}. */
  surface: string
  views: readonly [RepresentationView, RepresentationView]
  /** Drawn at the left of the toggle bar — the surface's own heading and anything beside it. */
  heading?: ReactNode
  /** Supply once the instance's key is declared in the registry; the choice is per-mount without it. */
  store?: RepresentationStore
}

export function TwoRepresentations({ surface, views, heading, store }: TwoRepresentationsProps) {
  // Both of these run before the first hook, so the rule of hooks holds even on
  // the throwing path: an undeclared surface, or one whose rendered ids do not
  // match what it declared, is a wiring bug and fails on the first render.
  const instance = representationInstance(surface)
  if (views.some((view, index) => view.id !== instance.representations[index])) {
    throw new Error(
      `${surface} renders [${views.map((view) => view.id).join(', ')}] but declares [${instance.representations.join(', ')}]`,
    )
  }

  // The instance's own array, not one mapped off `views`: a call site builds
  // its `views` literal fresh on every render, so ids derived from it would
  // change identity every time and re-subscribe both effects below on every
  // fleet tick. The check above is what makes the two interchangeable.
  const ids = instance.representations

  // The declared default is the FIRST representation, always. A stored id this
  // instance does not declare reads as nothing stored rather than as a crash —
  // the same posture `settings/registry.ts`'s own `accept` takes, so a renamed
  // or retired representation cannot make a surface unopenable.
  const [active, setActive] = useState<string>(() => {
    const stored = store?.read() ?? null
    return stored !== null && ids.includes(stored) ? stored : views[0].id
  })

  // Only a store's own change signal may move this from outside — and a store
  // is a person's remembered choice, not application state. Nothing else in the
  // tree has a way in (see the file doc's fourth guarantee).
  const subscribe = store?.subscribe
  const read = store?.read
  useEffect(() => {
    if (subscribe === undefined || read === undefined) return
    return subscribe(() => {
      const stored = read()
      if (stored !== null && ids.includes(stored)) setActive(stored)
    })
  }, [subscribe, read, ids])

  const choose = useCallback(
    (id: string) => {
      setActive(id)
      store?.write(id)
    },
    [store],
  )

  const { keystroke } = instance
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toLowerCase() !== keystroke) return
      event.preventDefault()
      setActive((current) => {
        const next = ids[(ids.indexOf(current) + 1) % ids.length] ?? current
        store?.write(next)
        return next
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keystroke, ids, store])

  const current = views.find((view) => view.id === active) ?? views[0]

  return (
    <section
      data-surface={surface}
      data-representation={current.id}
      className="flex h-full min-h-0 flex-col rounded-lg border border-(--line-hair) bg-(--surface-panel)"
    >
      {/* py-1 rather than py-2: the header sits INSIDE the hero's share, so its
          padding is paid out of the scene — ~8px bought back for the picture
          without touching any button's own target size (target-size law). */}
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-1">
        {heading}
        <div
          // The law's marker: a representation toggle drawn anywhere else in
          // `packages/web/src` fails `two-representations-law.test.ts`.
          data-representation-toggle={surface}
          role="group"
          aria-label={`${instance.label} representation`}
          className="flex shrink-0 items-center gap-1"
        >
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              aria-pressed={view.id === current.id}
              data-testid={`${surface}-representation-${view.id}`}
              onClick={() => choose(view.id)}
              className={
                view.id === current.id
                  ? `${TOGGLE_BUTTON} border-(--ink-dim) bg-(--surface-raised) text-(--ink-primary)`
                  : TOGGLE_BUTTON
              }
            >
              {view.label}
            </button>
          ))}
          <span className="ml-1 font-mono text-[10px] text-(--ink-dim)" aria-hidden="true">
            {instance.keystroke}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{current.render()}</div>
    </section>
  )
}

/**
 * The grid's own control idiom (`app/PanelFrame.tsx`'s `CHROME_BUTTON`, #117):
 * ice rather than a status hue, a lit top lip, and the same press. Focus is the
 * one token (`focus-ring`, prd-32 ruling 9 / #548) rather than a fourth
 * hand-rolled ring.
 */
const TOGGLE_BUTTON =
  'focus-ring rounded border border-(--line-hair) border-t-(--line-strong) bg-(--surface-panel)/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-(--ink-dim) transition-[transform,color,border-color] duration-150 ease-out hover:border-(--ink-dim) hover:text-(--ink-body) active:scale-[0.97]'
