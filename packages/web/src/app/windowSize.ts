import { useSyncExternalStore } from 'react'

/**
 * The window's own live size (S5, prd-32 ruling 10) — two independent
 * `useSyncExternalStore` reads rather than one object-returning snapshot,
 * because `useSyncExternalStore` compares snapshots with `Object.is`: a
 * fresh `{ width, height }` object every call would never equal the last
 * one and would re-render on every store notification whether the numbers
 * moved or not. Width and height are each a primitive, so each is stable
 * exactly when it has not changed.
 */
function subscribe(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

function getWidth(): number {
  return window.innerWidth
}

function getHeight(): number {
  return window.innerHeight
}

export function useWindowSize(): { width: number; height: number } {
  const width = useSyncExternalStore(subscribe, getWidth)
  const height = useSyncExternalStore(subscribe, getHeight)
  return { width, height }
}
