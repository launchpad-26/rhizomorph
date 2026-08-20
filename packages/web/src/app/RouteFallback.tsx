import type { ReactElement } from 'react'
import { BUTTON, BUTTON_PRIMARY } from '../ui/controls.js'

/**
 * WHAT A ROUTE'S CRASH LOOKS LIKE (loop 21).
 *
 * Until this, no boundary stood above the route switch: one uncaught throw in
 * any page unmounted the whole tree to a white screen — no words, no way
 * back, indistinguishable from the app never having started. That is the one
 * failure a calm instrument must never present, because a white screen says
 * nothing and a person's next move is to assume their session is gone.
 *
 * The honest reading, in the gap voice: the fault is the PAGE's, and only the
 * page's. The server, the recorder and the stream run out-of-process and are
 * untouched by a renderer exception — saying so is the difference between
 * "reload this view" and "my fleet is lost". Deliberately context-free: this
 * renders precisely when something above it misbehaved, so it reads nothing
 * from any provider.
 */
export function RouteFallback({ route }: { route: string }): ReactElement {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-(--surface-floor) p-8 font-sans text-(--ink-body)">
      <div className="w-full max-w-md rounded-plate border border-(--line-hair) bg-(--surface-panel) p-5 shadow-(--elev-raised)">
        <p className="page-title text-(--ink-primary)">this page failed to draw</p>
        <p className="mt-2 text-read-floor leading-relaxed">
          The <span className="figures">{route}</span> view hit an error while rendering. The fault is this
          page&apos;s alone — the server, the recorder and your session are separate processes and are not
          affected. Reloading redraws from the same live state.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => window.location.reload()}>
            reload the instrument
          </button>
          <a href="/" className={BUTTON}>
            back to the observatory
          </a>
        </div>
      </div>
    </div>
  )
}
