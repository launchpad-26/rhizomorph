import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../../app/keyboard.js'
import { setSessionQuery, useSessionQuery } from './session.js'

/**
 * THE ONE INPUT (prd-31 S3, #559) — "one input, reachable by keyboard from
 * anywhere; filters conversation, feed and trace together; `Escape` clears".
 *
 * **Chrome, not a panel.** It is mounted *inside* surfaces that already have a
 * home — the dock's tab strip on the balcony, the run view's own header — and
 * adds no row to the curated order. prd-13 ruling 1's refusal, kept
 * structurally: there is nothing in this directory a `PanelGrid` could register.
 *
 * **One store, however many fields.** Every mount reads and writes the same
 * module store, so the two homes above are two hands on one search rather than
 * two searches. That matters because the surfaces it filters do not share a
 * route: the conversation lives at `/lane/:handle` and the feed and trace live
 * in the dock, and a query typed on either is in force on the other the moment
 * you navigate.
 *
 * **`/` focuses it, `Escape` clears it.** The slash is the convention every
 * reader already has from `less`, vim, GitHub and every chat client, and it is
 * free here — the instrument's other single-key verbs are letters (`n`, `f`,
 * `a`, `v`) and digits. Both keys are guarded by {@link isTypingTarget}, so
 * neither fires while a person is typing into any other field.
 *
 * Escape's precedence is worth stating because this is the third thing to want
 * it (after the peek's close and panel focus): it is handled **on the input**
 * rather than on `window`, so it only fires while the field itself has focus and
 * cannot reach past a search that is not being typed in. A blurred field with a
 * live query is cleared by the button beside it, which is visible exactly when
 * there is something to clear.
 */
export interface SearchFieldProps {
  /** Where this field is mounted, for the accessible name and the test id. */
  surface: string
}

export function SearchField({ surface }: SearchFieldProps) {
  const query = useSessionQuery()
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      if (isTypingTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-1">
      <input
        ref={inputRef}
        type="search"
        value={query}
        data-testid={`session-search-${surface}`}
        aria-label="Search the loaded session"
        placeholder="/ search this session"
        onChange={(event) => setSessionQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // Consumed only when there is something to clear, so an empty field
          // lets Escape through to whatever else is listening for it.
          if (query === '') return
          event.preventDefault()
          event.stopPropagation()
          setSessionQuery('')
        }}
        className="focus-ring w-44 rounded-none border border-(--line-hair) bg-(--surface-floor) px-2 py-0.5 text-inst text-(--ink-body) placeholder:text-(--ink-dim)"
      />
      {query === '' ? null : (
        <button
          type="button"
          data-testid={`session-search-clear-${surface}`}
          onClick={() => setSessionQuery('')}
          aria-label="Clear the session search"
          className="focus-ring rounded-none border border-(--line-strong) px-1.5 py-0.5 heading tracking-wide text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          clear
        </button>
      )}
    </div>
  )
}
