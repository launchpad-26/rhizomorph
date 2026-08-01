import { useEffect, useRef } from 'react'
import type { Fleet } from '../../fleet/index.js'
import { AGE_INK_MAX_MS } from './ageBands.js'

/**
 * Ruling 8: at NEEDS-YOU and above the tab itself says so — the title flips
 * to `● N need you` and the favicon takes the worst rung's hue, both driven
 * off the exact same ladder list the strip renders (so the two surfaces
 * cannot disagree about how many lanes need a human). Below that — NOTICE and
 * CALM alike — the tab is restored to exactly what it was before this hook
 * ever touched it.
 *
 * `N` counts every item at NEEDS-YOU or BROKEN: both are a summons, and
 * "need you" is the plain-English word for a summons, not a rung name.
 */

const ICON_SELECTOR = 'link[rel="icon"]'

/**
 * These mirror `--color-needs-you` / `--color-broken` in `theme/theme.css`.
 * A favicon is a rasterised data URI generated outside the CSS cascade, so it
 * cannot reference a custom property directly; `themeHue` below reads the
 * real computed value when one is available and only falls back to these.
 */
const FALLBACK_HUE: Record<'needs-you' | 'broken', string> = {
  'needs-you': '#ffc857',
  broken: '#ff3d68',
}

export function useTabSignal(fleet: Fleet): void {
  const originalTitle = useRef<string | null>(null)
  const originalIconHref = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (typeof document === 'undefined') return

    originalTitle.current ??= document.title
    if (originalIconHref.current === undefined) {
      originalIconHref.current = document.querySelector<HTMLLinkElement>(ICON_SELECTOR)?.getAttribute('href') ?? null
    }

    const rank = fleet.ladder.rank
    const summoning = rank === 'needs-you' || rank === 'broken'

    if (!summoning) {
      document.title = originalTitle.current
      restoreFavicon(originalIconHref.current)
      return
    }

    const summonsItems = fleet.ladder.items.filter(
      (item) => item.rank === 'needs-you' || item.rank === 'broken',
    )
    document.title = `● ${summonsItems.length} need you${oldestSuffix(summonsItems)}`
    setFavicon(themeHue(rank))
  }, [fleet])
}

/**
 * Ruling 5 (prd5): once the oldest summons crosses the top age band, the tab
 * title carries it too — "just asked" and "asked 40 minutes ago" should not
 * read identically from a background tab. Unlike the chip (confined to
 * NEEDS-YOU), this reads across every summons: a stale BROKEN lane is exactly
 * as worth surfacing here as a stale NEEDS-YOU one.
 */
function oldestSuffix(summonsItems: readonly { forMs: number | null }[]): string {
  const oldestMs = summonsItems.reduce<number | null>((oldest, item) => {
    if (item.forMs === null) return oldest
    return oldest === null || item.forMs > oldest ? item.forMs : oldest
  }, null)
  if (oldestMs === null || oldestMs < AGE_INK_MAX_MS) return ''
  return ` (oldest ${Math.floor(oldestMs / 60_000)}m)`
}

function themeHue(rank: 'needs-you' | 'broken'): string {
  if (typeof getComputedStyle === 'function' && typeof document !== 'undefined') {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--color-${rank}`).trim()
    if (value !== '') return value
  }
  return FALLBACK_HUE[rank]
}

function setFavicon(hue: string): void {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#04060c"/><circle cx="8" cy="8" r="5" fill="${hue}"/></svg>`
  ensureIconLink().setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svg)}`)
}

function restoreFavicon(href: string | null): void {
  const link = document.querySelector<HTMLLinkElement>(ICON_SELECTOR)
  if (href === null) {
    link?.remove()
    return
  }
  ensureIconLink().setAttribute('href', href)
}

function ensureIconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>(ICON_SELECTOR)
  if (existing !== null) return existing
  const link = document.createElement('link')
  link.setAttribute('rel', 'icon')
  document.head.appendChild(link)
  return link
}
