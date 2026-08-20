import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { readFlag, writePreference } from '../settings/registry.js'
import { useStream } from './StreamContext.js'

/**
 * THE FIRST-RUN WELCOME (professionalisation loop 1; prd-04 ruling 1's layman
 * bar, finally aimed at minute zero).
 *
 * A stranger's first boot lands on a full observatory — on the desktop shell,
 * a *synthetic* one, because first-run dispatches the sample fleet — and
 * nothing on screen says what the picture is, that it is a sample, or what
 * the one next action would be. Every piece of the answer already existed
 * (the SYNTHETIC banner, the fixture keys, /connect); this card is the
 * connective moment, and only that: three sentences and two actions, floating
 * over the scene it explains, gone forever on one click.
 *
 * Held to the same honesty laws as everything above it:
 * - It never claims the sample is telemetry — the copy leads with what the
 *   picture IS, and names the sample as a sample.
 * - Dismissal is a *preference* (`onboarding.welcomed`, machine scope), so it
 *   is surveyed on the settings page like every other stored value, and the
 *   appearance group's "restore defaults · this machine" genuinely brings the
 *   welcome back — a stranger-proofing control for free.
 * - It steals no focus (a card, not a modal — the instrument stays usable
 *   under it), and Esc dismisses from anywhere.
 */

const WELCOMED = 'onboarding.welcomed'

export function Welcome(): ReactElement | null {
  const { source } = useStream()
  const [dismissed, setDismissed] = useState(() => readFlag(WELCOMED))

  const dismiss = useCallback(() => {
    writePreference(WELCOMED, true)
    setDismissed(true)
  }, [])

  useEffect(() => {
    if (dismissed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dismissed, dismiss])

  if (dismissed) return null
  const sample = source !== 'live'

  return (
    <aside
      role="region"
      aria-label="welcome"
      data-testid="welcome-card"
      className="fixed right-6 bottom-28 z-(--z-focus) w-[22rem] max-w-[calc(100vw-3rem)] rounded-lg border border-(--line-strong) bg-(--surface-panel)/95 p-4 shadow-(--elev-overlay) backdrop-blur-sm"
    >
      {/* A styled paragraph, not an h2: the card is a transient overlay, and the
          shell's curated-order law counts document headings. The region's
          accessible name is the aria-label above. */}
      <p className="heading text-(--ink-dim)">welcome to the observatory</p>
      <p className="mt-2 text-read-floor leading-relaxed text-(--ink-body)">
        Every thread is an agent&apos;s worktree; the mass at the centre is the repository their
        work returns to.{' '}
        {sample ? (
          <>
            What&apos;s on screen now is a <strong className="text-(--ink-primary)">sample fleet</strong> —
            synthetic lanes on the real event schema, so the instrument can be felt before it
            watches anything real.
          </>
        ) : (
          <>This is your live repository — lanes appear as agents pick up work.</>
        )}
      </p>
      {sample && (
        <p className="figures mt-2 text-inst-dense text-(--ink-dim)">
          1 live · 2 sample fleet · 3 staged pathologies
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <a
          href="/connect"
          onClick={dismiss}
          data-testid="welcome-connect"
          className="focus-ring rounded border border-(--ink-dim) px-2.5 py-1.5 text-inst font-semibold uppercase tracking-[0.1em] text-(--ink-primary) hover:border-(--ink-body)"
        >
          connect your repo
        </a>
        <button
          type="button"
          onClick={dismiss}
          data-testid="welcome-dismiss"
          className="focus-ring rounded border border-(--line-hair) px-2.5 py-1.5 text-inst uppercase tracking-[0.1em] text-(--ink-body) hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          explore first
        </button>
        <span aria-hidden="true" className="figures ml-auto text-inst-floor text-(--ink-dim)">
          esc
        </span>
      </div>
    </aside>
  )
}
