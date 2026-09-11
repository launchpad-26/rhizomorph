import { useState } from 'react'
import { saveComparison, type SaveComparisonFetchLike, type SavedComparison } from './save.js'
import type { ComparisonInput } from './types.js'

/**
 * THE ROUND TRIP'S OTHER HALF (prd-14 ruling 5, #214). `#213` built the save
 * route and the reopen route with no way for a human to reach either — this
 * control is that way, embedded in the comparison surface itself so a
 * finished comparison can be saved without a fixture. Reopening it lives in
 * the recordings library (`recordings/RecordingsPage.tsx`), which lists a
 * saved comparison as its own kind.
 *
 * ONE CLICK SENDS THE REQUEST — deliberately not the two-step "arm, then act"
 * shape `RenameControl` (edit, then save) and `RotateButton` (armed, then
 * confirmed) use. Review round 2 caught this control's doc CLAIMING that
 * discipline while its `onClick` sent on the first click; this is the
 * corrected claim, not the corrected behaviour, because the single click is
 * the right shape for what this write actually is: a save is ADDITIVE. It
 * creates one new artifact and touches nothing that already exists — never
 * overwrites a prior save, never ends a session (`RotateButton`'s act) and
 * never replaces a label already shown to the operator as truth
 * (`RenameControl`'s act). A second click, deliberate or not, costs at most a
 * second saved comparison sitting in the library — visible, harmless, and
 * nothing a confirm step would have protected against. Arming is for a click
 * that would be costly to take back; this one is not that.
 *
 * What IS held, and tested: nothing is sent until the operator clicks at
 * all, and a failed save says so rather than silently discarding what they
 * asked to keep.
 */
export interface SaveComparisonControlProps {
  input: ComparisonInput
  /** Test-only escape hatch for injecting the mutating fetch. */
  fetchImpl?: SaveComparisonFetchLike
}

type Phase =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; outcome: SavedComparison }
  | { status: 'failed'; message: string }

export function SaveComparisonControl({ input, fetchImpl }: SaveComparisonControlProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const saving = phase.status === 'saving'

  async function save() {
    setPhase({ status: 'saving' })
    try {
      const outcome = await saveComparison(input, fetchImpl)
      setPhase({ status: 'saved', outcome })
    } catch (err) {
      setPhase({ status: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="comparison-save"
          disabled={saving}
          onClick={() => void save()}
          className="shrink-0 rounded-none border border-(--ink-dim) px-2 py-1 normal-case tracking-normal text-(--ink-primary) disabled:opacity-50"
        >
          {saving ? 'saving…' : 'save this comparison'}
        </button>
        {phase.status === 'saved' && (
          <span data-testid="comparison-save-confirmation" role="status" className="normal-case tracking-normal text-(--ink-dim)">
            saved — reopen it from the recordings library
          </span>
        )}
      </div>
      {phase.status === 'failed' && (
        <span data-testid="comparison-save-error" role="status" className="normal-case tracking-normal text-broken">
          {phase.message}
        </span>
      )}
    </div>
  )
}
