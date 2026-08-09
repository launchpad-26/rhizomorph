/**
 * THE CAPABILITY TOKEN, browser side (issue #249; see `docs/adr/` for the
 * in-band-vs-out-of-band decision). The server mints one per process
 * (`server/src/api/security.ts`) and — since #249 — stamps it into
 * `index.html`'s `<head>` at serve time (`server/src/server/static.ts`).
 * This module is the one place that reads it back off the page, so every
 * mutating call site (`label.ts` today; `/api/rotate` and the laboratory's
 * launch in their own follow-up lanes, per #234) reads it the same way
 * rather than each growing its own `querySelector`.
 */

/**
 * The header name a mutating request must carry it under. Mirrors
 * `packages/server/src/api/security.ts`'s `CAPABILITY_TOKEN_HEADER` —
 * duplicated, not imported, because this package stays browser-safe (no
 * `node:*`) and the server package is not.
 */
export const CAPABILITY_TOKEN_HEADER = 'x-rhizomorph-capability'

/** The `<meta name="...">` the server writes the token under — must match `static.ts`'s own constant. */
export const CAPABILITY_META_NAME = 'rhizomorph-capability'

/**
 * Reads the token off the current page, or null if this document never got
 * one — a build served some other way than `server/static.ts` (the vite dev
 * server serves `index.html` itself and never runs that injection; see the
 * ADR's known dev-mode gap), or a page that isn't the app shell at all.
 */
export function readCapabilityToken(doc: Pick<Document, 'querySelector'> = document): string | null {
  const content = doc.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.getAttribute('content')
  return content !== null && content !== undefined && content.length > 0 ? content : null
}
