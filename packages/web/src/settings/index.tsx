import { useStream } from '../app/StreamContext.js'
import { foldedRepoPath } from '../app/streamState.js'
import { SettingsPage } from './SettingsPage.js'

/**
 * The route's own wiring, kept out of {@link SettingsPage} so the page itself
 * needs no providers to render — the same reason `App.tsx`'s
 * `RepoScopedSelection` reads the stream at the composition root rather than
 * inside `SelectionProvider`.
 *
 * The one fact it passes down is which repo the fold currently describes, which
 * is where repo-scoped preferences are bucketed (`registry.ts`'s
 * `adoptRepoScope`). It comes from the fold every other surface already reads —
 * no second source, and no fetch of its own.
 */
export function SettingsRoute() {
  const { state } = useStream()
  return <SettingsPage repoPath={foldedRepoPath(state.session)} />
}

export { SettingsPage } from './SettingsPage.js'
export default SettingsRoute
