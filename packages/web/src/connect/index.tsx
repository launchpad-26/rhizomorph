import { navigate } from '../app/router.js'

/**
 * THE CONNECT PLACEHOLDER (prd19 ruling 1, wave 2, #252) — `/connect`, the
 * fourth nav hand. Ruling 1 is explicit that this is "a fifth route and a
 * fourth nav hand, plus one quiet pointer from the empty balcony … a
 * permanent `/connect` route, never an interstitial" — so the fence for the
 * handshake checklist (wave 3, prd19 rulings 2-7) has to exist before that
 * page's own issue starts. This wave ships only the fence: a real,
 * deep-linkable, back-button-honest route that says what it will become,
 * modeled on `/lab`'s own wave-1 keystone (prd14) and `/recordings`'
 * (#135) header shape.
 */
export function ConnectPage() {
  return (
    <div data-testid="connect-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <header className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <button
          type="button"
          data-testid="connect-back"
          onClick={() => navigate('/')}
          className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          ← balcony
        </button>
        <h1 className="text-sm text-ice-100">Connect</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="text-ice-400">connect — the handshake checklist lands in wave 3</p>
      </div>
    </div>
  )
}

export default ConnectPage
