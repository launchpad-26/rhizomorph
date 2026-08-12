/**
 * WHAT AN OPERATOR SHOULD DO WHEN THE CAPABILITY TOKEN FAILS THEM (#406).
 *
 * `./capability.ts` reads the token. This module says what to do when there
 * isn't one, or when the instrument rejects the one there is — deliberately a
 * separate module, because the reader of a credential should not also be the
 * owner of UI copy.
 *
 * There are two failures and they need different sentences:
 *
 * - **No token on the page at all.** Almost always the dev-mode gap ADR-0012
 *   names: `npm run dev:web` serves `index.html` through vite, which never
 *   runs the server's injection (`server/src/server/static.ts`), so there is
 *   nothing to read. Refused before the wire, so the operator reads what is
 *   missing instead of a 401 about a header they never knew existed.
 *
 * - **A token that the instrument refuses (401).** The token is minted fresh
 *   per server process and stamped in at serve time, so a tab left open
 *   across a restart is holding one that no longer exists. The server's own
 *   sentence names the header — true, and useless to someone looking at a
 *   button — so it is kept and what to DO is added after it.
 *
 * Both sentences were introduced by #234 for `replay/rotate.ts` and
 * `lab/launch/launch.ts` and duplicated byte-for-byte between them; #406
 * found the third caller (`recordings/label.ts`) had neither. Rather than
 * write the copy a third time, all three callers now read it from here — so
 * the next change lands in one place instead of drifting across three.
 *
 * `action` is the caller's own verb phrase ("end the session", "launch",
 * "save the label"), so each message still names what actually failed.
 */

/** The refusal for a page that never received a token — sent before any request. */
export function missingTokenMessage(action: string): string {
  return (
    `could not ${action} — this page carries no capability token, and the instrument requires one. ` +
    'The server stamps the token into the dashboard page as it serves it, so a page served some other way ' +
    'never gets one: `npm run dev:web` serves it through vite, which skips that step. Run the built server ' +
    '(`npm run dev:server`, or `npm run build` then `npm start`) and reload this page.'
  )
}

/**
 * The refusal for a token the instrument rejected. `serverSentence` is the
 * server's own `{ error }` — kept verbatim and first, because it is the true
 * account of what happened; the guidance follows it rather than replacing it.
 */
export function staleTokenMessage(action: string, serverSentence: string): string {
  return (
    `could not ${action} — ${serverSentence}. ` +
    'The instrument mints that token fresh every time it starts, so a page left open across a restart ' +
    'is holding one that has expired. Reload this page and try again.'
  )
}
