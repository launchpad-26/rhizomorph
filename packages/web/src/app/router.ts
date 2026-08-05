import { useSyncExternalStore } from 'react'

/**
 * THE ROUTER (prd9 B1b, widened by prd16 ruling 4 and prd14) — a hand-rolled
 * history-API router for exactly four routes: `/` (the balcony, unchanged),
 * `/lane/:handle` (the deep-linkable lane page), `/recordings` (the
 * recordings library, #135's pattern reused rather than forked), and `/lab`
 * (the experiment console, prd14 — the same reuse-not-fork precedent: a
 * second router is exactly what that direction forbids). The
 * lean-dependency culture (prd5's implementation-vehicles note) rules out
 * react-router or any routing package for a job this small — four routes,
 * no nesting, no data loading, just "which page" and "keep the URL and the
 * back button honest".
 *
 * `pushState` never fires the browser's own `popstate`, so every programmatic
 * navigation (`navigate`) has to raise it itself; the browser raises
 * `popstate` on its own for back/forward, which every subscriber below also
 * listens for — so both paths converge on the same notification.
 */

export type Route =
  | { name: 'balcony' }
  | { name: 'lane'; handle: string }
  | { name: 'recordings' }
  | { name: 'lab' }

const LANE_PATH = /^\/lane\/([^/]+)\/?$/
const RECORDINGS_PATH = /^\/recordings\/?$/
const LAB_PATH = /^\/lab\/?$/

/** Parses a `location.pathname` into the one route it names. Unknown shapes fall back to the balcony. */
export function parseRoute(pathname: string): Route {
  if (RECORDINGS_PATH.test(pathname)) return { name: 'recordings' }
  if (LAB_PATH.test(pathname)) return { name: 'lab' }
  const match = LANE_PATH.exec(pathname)
  if (match === null) return { name: 'balcony' }
  return { name: 'lane', handle: decodeURIComponent(match[1] as string) }
}

/** The lane page's own URL for a handle — the one place `/lane/` is spelled. */
export function laneUrl(handle: string): string {
  return `/lane/${encodeURIComponent(handle)}`
}

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Pushes a new history entry and tells every `useRoute` — back/forward already work via `popstate`. */
export function navigate(pathname: string): void {
  if (window.location.pathname === pathname) return
  window.history.pushState(null, '', pathname)
  notify()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

function getSnapshot(): string {
  return window.location.pathname
}

/** The one route the app is on right now, updating on navigation and on back/forward alike. */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot)
  return parseRoute(pathname)
}
