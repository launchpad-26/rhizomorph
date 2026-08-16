import { useEffect } from 'react'
import { readChoice, subscribeToPreferences } from './registry.js'

/**
 * WHAT A PREFERENCE ACTUALLY DOES TO THE PAGE (prd-35 rulings 4 and 5; #550).
 *
 * Three attributes on the root element — `data-theme`, `data-density`,
 * `data-motion` — and nothing else. The registry stores; this module applies;
 * the surfaces that draw read the attribute. That seam is why the theme switch
 * could land in this wave at all while the light palette is #551's and the
 * scene's quality levels are prd-33's: each of those lands as a rule that reads
 * an attribute already being set, with no edit here and none in settings.
 *
 * **The seam is also the gap, and the gap is declared.** Today `theme.css`
 * carries no `[data-theme='light']` block and no surface reads `data-density`
 * or `data-motion`, so two of these three attributes are, right now, a
 * correctly-stored preference with nothing on the other end. Every one of those
 * says so in its own `gap` note in `registry.ts` (law 12's voice: WHAT is
 * missing → WHY it matters → what fixes it) rather than letting the surface
 * imply an effect it does not have.
 *
 * **Ruling 5's floor is arithmetic here, not a comment.** {@link resolveMotion}
 * takes the stronger of what the person asked for and what the system asked
 * for, so the in-app control can only ever go FURTHER than
 * `prefers-reduced-motion` — never back. There is no input, and no future
 * option, that returns `full` while the system is asking for `reduced`;
 * `non-negotiables-law.test.ts` proves that over the whole option set rather
 * than over the three values that exist today.
 */

export type ResolvedTheme = 'dark' | 'light'
export type ResolvedMotion = 'full' | 'reduced' | 'still'

/** How much stillness each level is. Higher wins, which is the whole of ruling 5. */
const MOTION_RANK: Readonly<Record<ResolvedMotion, number>> = { full: 0, reduced: 1, still: 2 }

/** What the environment asked for, read once and passed in so every resolver is pure. */
export interface SystemPreferences {
  prefersLight: boolean
  prefersReducedMotion: boolean
}

/** `system` follows `prefers-color-scheme`; anything else is the person's own answer. */
export function resolveTheme(preference: string, system: SystemPreferences): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return system.prefersLight ? 'light' : 'dark'
}

/**
 * The motion actually in force: the STRONGER of the stored preference and the
 * system's own request (ruling 5). `still` beats `reduced` beats `full`, and the
 * system can only ever raise the floor — never lower it.
 */
export function resolveMotion(preference: string, system: SystemPreferences): ResolvedMotion {
  const asked: ResolvedMotion = preference === 'still' ? 'still' : preference === 'reduced' ? 'reduced' : 'full'
  const floor: ResolvedMotion = system.prefersReducedMotion ? 'reduced' : 'full'
  return MOTION_RANK[asked] >= MOTION_RANK[floor] ? asked : floor
}

/**
 * What the environment is asking for right now. `matchMedia` is guarded because
 * a page can be rendered where there is none (a test tree, a non-browser host),
 * and the honest answer there is "the system asked for nothing", not a throw
 * that takes the whole surface down.
 */
export function readSystemPreferences(view: Pick<Window, 'matchMedia'> = window): SystemPreferences {
  if (typeof view.matchMedia !== 'function') return { prefersLight: false, prefersReducedMotion: false }
  return {
    prefersLight: view.matchMedia('(prefers-color-scheme: light)').matches,
    prefersReducedMotion: view.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

/**
 * Put the three attributes on `root`. Idempotent, and the only writer of any of
 * them — a second writer is how two surfaces come to disagree about which theme
 * is on.
 */
export function applyPreferences(root: HTMLElement, system: SystemPreferences): void {
  root.dataset.theme = resolveTheme(readChoice('appearance.theme'), system)
  root.dataset.density = readChoice('appearance.density')
  root.dataset.motion = resolveMotion(readChoice('motion.level'), system)
}

/**
 * Keep the document in step with the registry, for as long as the app is
 * mounted: once at boot (so a stored theme survives a reload rather than
 * needing the settings page to be visited), on every preference change, and on
 * every system change — because a person who turns on reduced motion in their
 * OS while the instrument is open is asking for it now, not at the next reload.
 */
export function usePreferenceApplication(): void {
  useEffect(() => {
    const apply = () => applyPreferences(document.documentElement, readSystemPreferences())
    apply()

    const unsubscribe = subscribeToPreferences(apply)
    const queries =
      typeof window.matchMedia === 'function'
        ? ['(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)'].map((query) =>
            window.matchMedia(query),
          )
        : []
    for (const query of queries) query.addEventListener?.('change', apply)

    return () => {
      unsubscribe()
      for (const query of queries) query.removeEventListener?.('change', apply)
    }
  }, [])
}
