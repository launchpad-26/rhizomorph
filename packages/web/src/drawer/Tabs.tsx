import { useRef, type KeyboardEvent } from 'react'

/**
 * THE DRAWER TABS (#163) — replaces four independently-capped, independently-
 * scrolling boxes with one section at a time, at the drawer's full height.
 *
 * The operator's ruling was structural: "the drawer allocates fixed heights to
 * unbounded content." Tabs fix that by construction — there is exactly one
 * body below the vitals header, and it gets everything the drawer has to give.
 *
 * Standard ARIA tabs (`role="tablist"`/`"tab"`/`"tabpanel"`, automatic
 * activation on arrow keys — a panel swap costs nothing here, unlike a
 * network-backed tab widget where arrowing through would be wasteful). A
 * roving tabindex: only the active tab is in the page's Tab order, and
 * Left/Right (Home/End too, for a four-item strip a reader may not want to
 * count through one at a time) move both focus and selection together.
 *
 * ESC is deliberately not handled here: it is not this component's keystroke
 * to take. The drawer's own close handler already owns it (`SelectionProvider`'s
 * global listener), and this only ever calls `preventDefault` on the arrow/home/
 * end keys it actually consumes, so Escape keeps bubbling untouched.
 */
export type TabId = 'activity' | 'conversation' | 'why' | 'trace'

export const TAB_ORDER: readonly TabId[] = ['activity', 'conversation', 'why', 'trace']

export interface DrawerTab {
  id: TabId
  label: string
  /** Pre-formatted count text, e.g. `"49"`, `"11 files"` — or `"—"` for the honest gap (never `"0"`). */
  count: string | null
}

export interface TabBarProps {
  tabs: readonly DrawerTab[]
  active: TabId
  onSelect: (id: TabId) => void
}

/** `id` → the DOM id the active tab's panel carries, so `aria-controls`/`aria-labelledby` can point at each other. */
export function tabPanelId(id: TabId): string {
  return `drawer-tabpanel-${id}`
}

function tabButtonId(id: TabId): string {
  return `drawer-tab-${id}`
}

export function TabBar({ tabs, active, onSelect }: TabBarProps) {
  const buttonRefs = useRef(new Map<TabId, HTMLButtonElement>())

  const moveTo = (id: TabId) => {
    onSelect(id)
    buttonRefs.current.get(id)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === active)
    if (index === -1) return

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveTo(tabs[(index + 1) % tabs.length]!.id)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveTo(tabs[(index - 1 + tabs.length) % tabs.length]!.id)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveTo(tabs[0]!.id)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveTo(tabs[tabs.length - 1]!.id)
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Drawer section"
      onKeyDown={onKeyDown}
      className="flex shrink-0 border-b border-ice-850 px-2"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) buttonRefs.current.set(tab.id, el)
              else buttonRefs.current.delete(tab.id)
            }}
            type="button"
            role="tab"
            id={tabButtonId(tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            data-testid={`drawer-tab-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            className={`flex items-baseline gap-1.5 border-b-2 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors duration-150 ease-out ${
              selected
                ? 'border-ice-200 text-ice-100'
                : 'border-transparent text-ice-400 hover:text-ice-200'
            }`}
          >
            <span>{tab.label}</span>
            {tab.count === null ? null : <span className="figures text-ice-400">{tab.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
