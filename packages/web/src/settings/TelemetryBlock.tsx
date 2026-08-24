import { useState, type MouseEvent } from 'react'
import { navigate } from '../app/router.js'
import { envApplyNote, envCommand, portFrom, SAME_PROCESS_WARNING } from '../connect/links.js'
import { copyToClipboard, type CopyText } from '../drawer/AttachButton.js'

/**
 * THE TELEMETRY GROUP (prd-35 S1 group 6, wave 2; #574) — the env block for
 * this instance, copyable, with the same same-process warning `/connect` uses.
 *
 * **Every word of it is imported, none of it is restated.** The command comes
 * from `connect/links.ts`'s {@link envCommand}, the instruction for applying it
 * from {@link envApplyNote}, and the SCAR from {@link SAME_PROCESS_WARNING} —
 * the constant, not a copy of its sentence. That is the whole reason this group
 * could not land in wave 1 and can now: two surfaces stating a warning in their
 * own words is how one of them comes to state the old version of it, and the
 * warning in question is a verbatim record of a real incident
 * (`.workmux.yaml`, 2026-08-04) that a paraphrase brings straight back.
 * `coverage-law.test.tsx`'s "the copy this page shows is imported, never
 * restated" holds that structurally rather than by this paragraph: the sentence
 * may be written out in one source file, and this one has to import it.
 *
 * **This proves nothing, and says so.** prd-35 ruling 1 splits the jobs:
 * settings CHANGES things, `/connect` PROVES them. So there is no state here,
 * no reading of whether telemetry is arriving, and no verdict — only the block
 * you have to export and the sentence about where to export it. The one link is
 * to the surface that does make the claim.
 *
 * **No lane, on purpose.** {@link envCommand} leaves `<lane>` a literal
 * placeholder when the caller does not know one, and this page does not: it is
 * configuration for the instance, not for a session someone happens to be
 * looking at. A guessed handle here would hand a person a command that
 * instruments a lane that does not exist, which `links.ts`'s own doc calls out
 * as worse than the placeholder they fill in themselves.
 */

export interface TelemetryBlockProps {
  /** The page's own location — injected so a test can pin the port without a jsdom navigation. */
  location?: { port: string; protocol: string }
  onCopy?: CopyText
}

export function TelemetryBlock({
  location = window.location,
  onCopy = copyToClipboard,
}: TelemetryBlockProps = {}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const command = envCommand(null, null, portFrom(location))

  const openConnect = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate('/connect')
  }

  return (
    <div data-testid="settings-telemetry" className="mt-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        {/* Shown whether or not the copy worked — `connect/index.tsx`'s own posture: a
            person who cannot use the clipboard still has the command in front of them. */}
        <code
          data-testid="settings-telemetry-command"
          className="min-w-0 flex-1 break-all rounded-none border border-(--line-hair) bg-(--surface-floor) px-2 py-1 font-mono text-inst text-(--ink-primary)"
        >
          {command}
        </code>
        <button
          type="button"
          data-testid="settings-telemetry-copy"
          onClick={() => {
            void onCopy(command).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            )
          }}
          className="focus-ring shrink-0 rounded-none border border-(--line-strong) px-2 py-1 text-inst-dense uppercase tracking-wider text-(--ink-dim) hover:border-(--ink-dim) hover:text-(--ink-primary)"
        >
          Copy
        </button>
      </div>

      {copied !== 'idle' ? (
        <p data-testid="settings-telemetry-copied" className="text-inst text-(--ink-dim)">
          {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
        </p>
      ) : null}

      <p data-testid="settings-telemetry-apply" className="text-inst text-(--ink-dim)">
        {envApplyNote(command)}
      </p>

      <p data-testid="settings-telemetry-warning" className="text-inst text-notice">
        {SAME_PROCESS_WARNING}
      </p>

      <p className="text-inst text-(--ink-dim)">
        nothing here claims it worked — that is{' '}
        <a href="/connect" onClick={openConnect} data-testid="settings-telemetry-connect" className="focus-ring underline">
          /connect
        </a>
        , which shows every link of the chain and its evidence.
      </p>
    </div>
  )
}
