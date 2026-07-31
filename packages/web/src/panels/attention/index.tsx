/**
 * THE ATTENTION STRIP (ruling 5) — thin, always present, docked at the top; the
 * single source of truth for the tab signal and the favicon badge.
 *
 * Registered as a placeholder by the keystone (#75) so the shell's curated
 * order is real from wave 1. **#77 owns everything inside this file.** It will
 * read the one derived fleet object's `ladder`, whose type already makes ALL
 * CLEAR structurally unable to render beside a non-zero collision count.
 */
export default function AttentionStrip() {
  return (
    <div
      role="status"
      className="flex h-9 items-center gap-3 px-4 text-xs text-ice-500"
      data-panel="attention"
    >
      <span className="font-medium uppercase tracking-[0.2em] text-ice-600">Attention</span>
      <span className="figures text-[11px] text-ice-600">#77</span>
      <span className="truncate">
        not built yet — N need attention · ALL CLEAR with evidence · click to jump
      </span>
    </div>
  )
}
