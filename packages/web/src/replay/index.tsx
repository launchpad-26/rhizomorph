export default function ReplayControls() {
  return (
    <div className="flex items-center gap-3 border-t border-void-line bg-void-raised px-4 py-2 text-xs uppercase tracking-wide text-slate-500">
      <button type="button" disabled className="rounded border border-void-line px-2 py-1 opacity-50">
        Play
      </button>
      <div className="h-1 flex-1 rounded-full bg-void-line" />
      <span>replay coming soon</span>
    </div>
  )
}
