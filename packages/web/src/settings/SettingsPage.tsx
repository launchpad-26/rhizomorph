import { Nav } from '../app/Nav.js'

/**
 * THE SETTINGS STUB (#549, ahead of prd-35/#550) — a fenced placeholder of
 * the exact kind `/connect` landed as in wave 2 (`app/router.ts`'s own
 * comment): the route exists so the persistent nav (S4) has a real surface
 * to point every hand's "same place, always" claim at, but the configuration
 * surface itself — the theme switch, and whatever else prd-35 rules on — is
 * #550's to build. This file may grow no control of its own; that is the
 * fence #549 was dispatched under.
 */
export function SettingsPage() {
  return (
    <div data-testid="settings-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <Nav />
      <header className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <h1 className="text-sm text-ice-100">Settings</h1>
        <span className="text-[length:var(--text-inst)] normal-case tracking-normal text-ice-400">
          not built yet — prd-35 and #550 own this surface
        </span>
      </header>
    </div>
  )
}
