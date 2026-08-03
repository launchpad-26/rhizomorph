/**
 * THE HONEST GAP — zero spans for this lane is a fact worth saying, not a
 * blank panel (law 12). Same voice as `drawer/Activity.tsx`'s own empty
 * state: `role="status"`, dim ice text, a full sentence naming what is
 * missing and where to read about it, never a bare dash.
 */
export function EmptyTrace() {
  return (
    <p role="status" className="px-4 py-3 text-[11px] leading-snug text-ice-400">
      NO TRACE TELEMETRY — no trace telemetry from this lane — see docs/telemetry.md.
    </p>
  )
}
