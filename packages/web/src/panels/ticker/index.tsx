export default function TickerPanel() {
  return (
    <section className="flex h-full flex-col rounded-lg border border-void-line bg-void-raised p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neon-amber">
        Commit ticker
      </h2>
      <p className="mt-2 text-sm text-slate-500">Waiting for data…</p>
    </section>
  )
}
