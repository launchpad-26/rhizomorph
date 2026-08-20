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
      <div data-testid="drawer-attach" className="border-t border-(--line-hair) px-4 py-2">
        <p role="status" className="font-mono text-inst leading-snug text-(--ink-dim)">
          {plan.note}
        </p>
      </div>
    )
  }

  const command = plan.command

  return (
    <div data-testid="drawer-attach" className="border-t border-(--line-hair) px-4 py-2">
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
          className="rounded border border-(--line-strong) px-2 py-1 text-inst-dense font-semibold uppercase tracking-[0.18em] text-(--ink-primary) hover:border-(--ink-dim) hover:bg-(--surface-raised)"
        >
          Attach
        </button>
        <span className="figures text-inst-dense uppercase tracking-wider text-(--ink-dim)">{plan.kind}</span>
        {copied === 'idle' ? null : (
          <span
            role="status"
            className={`figures text-inst-dense ${copied === 'copied' ? 'text-notice' : 'text-(--ink-dim)'}`}
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
        className="mt-1.5 block overflow-x-auto whitespace-pre rounded bg-(--surface-floor) px-2 py-1 font-mono text-inst text-(--ink-body)"
      >
        {command}
      </code>
      <p className="mt-1 text-inst-dense leading-snug text-(--ink-dim)">{plan.note}</p>
    </div>
  )
}
