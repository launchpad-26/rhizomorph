import { useEffect, useState } from 'react'
import type { AttachPlan } from './attach.js'

/**
 * THE ATTACH BUTTON (ruling 17).
 *
 * It copies a string. That is the entire behaviour, and it is the constitution:
 * the Rhizomorph shows you the command and you run it, so no key this
 * dashboard can reach ever reaches an agent. There is no exec path behind this
 * component to disable — `onCopy` is a clipboard write and nothing else, which
 * `drawer.readonly.test.ts` asserts at the level of the source text so it
 * cannot quietly grow one.
 *
 * What it copied is always shown, whether the copy worked or not. A clipboard
 * write can fail (no permission, no secure context, a headless browser), and
 * the useful failure mode is the command sitting there, selectable, rather than
 * a red toast that leaves the operator with nothing to paste.
 */

export type CopyText = (text: string) => Promise<void>

/** The default clipboard write, or a rejection where there is no clipboard to write to. */
export async function copyToClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) throw new Error('no clipboard in this browser context')
  await clipboard.writeText(text)
}

export interface AttachButtonProps {
  plan: AttachPlan
  /** Test seam. Defaults to {@link copyToClipboard}. */
  onCopy?: CopyText
}

type CopyState = 'idle' | 'copied' | 'failed'

export function AttachButton({ plan, onCopy = copyToClipboard }: AttachButtonProps) {
  const [copied, setCopied] = useState<CopyState>('idle')

  // A different lane is a different command: "copied" must not linger over a
  // string that is no longer the one on the clipboard.
  useEffect(() => setCopied('idle'), [plan.command])

  if (plan.command === null) {
    return (
      <div data-testid="drawer-attach" className="border-t border-ice-850 px-4 py-2">
        <p role="status" className="font-mono text-[11px] leading-snug text-ice-500">
          {plan.note}
        </p>
      </div>
    )
  }

  const command = plan.command

  return (
    <div data-testid="drawer-attach" className="border-t border-ice-850 px-4 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="attach-copy"
          onClick={() => {
            void onCopy(command).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            )
          }}
          className="rounded border border-ice-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ice-100 hover:border-ice-500 hover:bg-ice-900"
        >
          Attach
        </button>
        <span className="figures text-[10px] uppercase tracking-wider text-ice-500">{plan.kind}</span>
        {copied === 'idle' ? null : (
          <span
            role="status"
            className={`figures text-[10px] ${copied === 'copied' ? 'text-notice' : 'text-ice-400'}`}
          >
            {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
          </span>
        )}
      </div>

      {/*
        Always visible, always the exact string. An operator must be able to
        read what they are about to paste into their own shell — and this is
        also the only fallback that works when the clipboard does not.
      */}
      <code
        data-testid="attach-command"
        className="mt-1.5 block overflow-x-auto whitespace-pre rounded bg-ice-1000 px-2 py-1 font-mono text-[11px] text-ice-200"
      >
        {command}
      </code>
      <p className="mt-1 text-[10px] leading-snug text-ice-600">{plan.note}</p>
    </div>
  )
}
