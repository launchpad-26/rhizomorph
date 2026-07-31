/**
 * THE FLEET TABLE (ruling 7) — dense rows, calm chrome, ten-plus lanes without
 * scrolling. The worktrees panel dissolves into it.
 *
 * Registered as a placeholder by the keystone (#75). **#78 owns everything
 * inside this file.** Its STATE column renders the scene's own glyphs at row
 * scale (graft g1) — `Sigil` from `fleet/sigils.tsx` already draws every mark
 * at both scales from one source, which is what lets the table *be* the
 * scene's legend.
 */
export default function FleetTable() {
  return (
    <section
      className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4"
      data-panel="fleet"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Fleet</h2>
      <p className="mt-2 text-sm text-ice-500">
        not built yet — <span className="figures">#78</span> renders one row per lane, with the
        scene's glyphs in the STATE column.
      </p>
    </section>
  )
}
