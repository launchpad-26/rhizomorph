/**
 * THE ACTIVITY FEED (ruling 15) — one quiet, filterable feed: commits,
 * landings, lane starts and stops, collector events. The commit ticker grows
 * into this.
 *
 * Registered as a placeholder by the keystone (#75). **#79 owns everything
 * inside this file**, and the provenance bar along the bottom with it. The
 * news-vs-history tag it needs is already on the stream state (`isNews`), so a
 * replayed burst can build the feed without pretending it just happened.
 */
export default function ActivityFeed() {
  return (
    <section
      className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4"
      data-panel="feed"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Activity</h2>
      <p className="mt-2 text-sm text-ice-500">
        not built yet — <span className="figures">#79</span> folds commits, landings, lane
        starts/stops and collector events into one filterable feed.
      </p>
    </section>
  )
}
