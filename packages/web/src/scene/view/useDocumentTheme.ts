import { useEffect, useState } from 'react'
import type { ThemeName } from '../palette.js'

/**
 * The theme, read the one way the scene is allowed to learn it.
 *
 * `settings/apply.ts` is the only writer of `data-theme` on the root element,
 * and its own header declares this seam: "the surfaces that draw read the
 * attribute — with no edit here and none in settings." The scene must not
 * import from `settings/` (palette.ts's stated direction), so the attribute IS
 * the contract — the same shape `panels/attention/useTabSignal.ts` set for a
 * runtime document read.
 *
 * A `MutationObserver` rather than a poll or a store subscription: the switch
 * is rare, the attribute is the source of truth, and observing it means a
 * theme change repaints the scene in the same frame the chrome changes —
 * never a paper page over a void picture while a subscription catches up.
 *
 * jsdom-safe: no attribute reads as dark (the void is the instrument's home
 * register), and `MutationObserver` exists in jsdom, so tests can flip the
 * attribute and see the hook follow.
 */
export function useDocumentTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(() => readTheme())

  useEffect(() => {
    if (typeof MutationObserver !== 'function') return
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    // Re-read on mount: the attribute may have changed between the useState
    // initialiser and the observer attaching.
    setTheme(readTheme())
    return () => observer.disconnect()
  }, [])

  return theme
}

function readTheme(): ThemeName {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}
