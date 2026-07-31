/**
 * THE BURN STRIP (ruling 13) — four numbers, no chrome, docked beside the
 * attention strip: output tokens, dollars (when authoritative), burn rate,
 * overhead ratio. The spend ticker panel dissolves into this and the ledger.
 *
 * Registered as a placeholder by the keystone (#75). **#80 owns everything
 * inside this file.** Its four numbers are already computed, once, on the
 * derived fleet object's `burn` — including the honesty rule that dollars stay
 * absent rather than reading `$0.00` when nothing authoritative arrived.
 */
export default function BurnStrip() {
  return (
    <div className="flex h-9 items-center gap-3 px-4 text-xs text-ice-500" data-panel="burn">
      <span className="font-medium uppercase tracking-[0.2em] text-ice-600">Burn</span>
      <span className="figures text-[11px] text-ice-600">#80</span>
      <span className="truncate">not built yet — output · dollars · rate · overhead</span>
    </div>
  )
}
