import type { MouseEvent } from 'react'
import { useMode } from './ModeContext.js'
import { navigate, useRoute, type Route } from './router.js'

/**
 * THE PRIMARY NAV (#229, fourth hand added by #252/prd19 ruling 1; made
 * persistent by #549/prd-32 ruling 10) — one link per constitutional hand
 * (observer / recorder / laboratory / connect, prd12+prd16 ruling 2+prd14+prd19),
 * so the trust model is visible rather than a documentation claim.
 *
 * Extracted out of `Shell.tsx` so it is the same component on every surface —
 * before #549 it rendered only on the balcony (`Shell`'s own `TopDock`);
 * `/lane/:handle`, `/recordings`, `/lab`, `/connect` and `/settings` each
 * mount this directly in their own header now, rather than growing a second
 * copy. Real `<a href>`s, modifier-aware like the drawer's own open-page link
 * (`drawer/index.tsx`'s `OpenPageLink`), routed through the hand-rolled
 * router's `pushState` on a plain click rather than a full reload.
 */
/**
 * SETTINGS IS THE FIFTH ENTRY, AND IT IS NOT A HAND (#550, prd-35 S1). The four
 * above are constitutional hands — what the instrument is allowed to do. This
 * one is where a person changes what it does for them, which prd-35 ruling 1
 * requires be reachable from the persistent nav and requires appear exactly
 * once anywhere. It rides at the end of the same strip rather than in a corner
 * of its own, because "the same place, always" is what #549 bought and a
 * settings link that moved per surface would spend it.
 */
type NavHandKey = 'balcony' | 'recordings' | 'lab' | 'connect' | 'settings'

const HANDS: ReadonlyArray<{ href: string; label: string; key: NavHandKey }> = [
  { href: '/', label: 'Observatory', key: 'balcony' },
  { href: '/recordings', label: 'Recordings', key: 'recordings' },
  { href: '/lab', label: 'Lab', key: 'lab' },
  { href: '/connect', label: 'Connect', key: 'connect' },
  { href: '/settings', label: 'Settings', key: 'settings' },
]

/** The one nav entry's href the current route names — `lane` has none of its own, so it defaults to the balcony's. */
function activeHref(route: Route): string {
  switch (route.name) {
    case 'recordings':
      return '/recordings'
    case 'lab':
      return '/lab'
    case 'connect':
      return '/connect'
    case 'settings':
      return '/settings'
    default:
      return '/'
  }
}

/**
 * S4's *unavailable* state — never hidden, always disabled WITH ITS REASON.
 * The one instance the issue names: the lab forks live checkpoints
 * (`lab/no-live-fleet-law.test.ts`), so it has nothing honest to fork from
 * while replaying a recording of the past.
 */
function unavailableReason(key: NavHandKey, mode: ReturnType<typeof useMode>): string | null {
  if (key === 'lab' && mode === 'replay') {
    return 'unavailable during replay — the lab forks live checkpoints, and this session is history'
  }
  return null
}

export function Nav() {
  const route = useRoute()
  const mode = useMode()
  const current = activeHref(route)

  return (
    <nav aria-label="Primary" className="flex shrink-0 gap-1 border-b border-ice-850 px-4">
      {HANDS.map((hand) => {
        const reason = unavailableReason(hand.key, mode)
        return reason === null ? (
          <NavLink key={hand.href} href={hand.href} label={hand.label} active={hand.href === current} />
        ) : (
          <DisabledNavLink key={hand.href} label={hand.label} reason={reason} />
        )
      })}
    </nav>
  )
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }

  return (
    <a
      href={href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-testid={`nav-${label.toLowerCase()}`}
      className={`focus-ring border-b-2 px-2.5 py-2 text-[length:var(--text-inst-dense)] font-semibold uppercase tracking-[0.16em] transition-colors duration-150 ease-out ${
        active ? 'border-ice-200 text-ice-100' : 'border-transparent text-ice-400 hover:text-ice-200'
      }`}
    >
      {label}
    </a>
  )
}

/**
 * S4's *unavailable* state, rendered — never removed from the strip, so its
 * place in the same-place-everywhere contract holds even while it cannot be
 * clicked. `title` surfaces the reason on hover; the visually-hidden span
 * gives it to a screen reader (and to a test) without depending on hover at
 * all — the same "hover and focus disclose identically" posture D10 states
 * for the disclosure card.
 */
function DisabledNavLink({ label, reason }: { label: string; reason: string }) {
  return (
    <span
      aria-disabled="true"
      title={reason}
      data-testid={`nav-${label.toLowerCase()}`}
      className="flex cursor-not-allowed items-center border-b-2 border-transparent px-2.5 py-2 text-[length:var(--text-inst-dense)] font-semibold uppercase tracking-[0.16em] text-ice-400"
    >
      {label}
      <span className="sr-only">{` — ${reason}`}</span>
    </span>
  )
}
