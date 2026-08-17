/**
 * READING THE SERVER'S OWN BOOT LINE — the shell's whole handshake with the
 * process it spawns (prd-34 ruling 1).
 *
 * The server already prints exactly one line naming where it is listening:
 *
 * ```
 * rhizomorph running at http://127.0.0.1:4321
 * ```
 *
 * (`packages/server/src/cli/run.ts`, and the same line CI's boot smoke greps
 * for). The shell reads that line rather than being told a port, because the
 * shell asks for `--port 0` — the OS picks a free one, so an already-running
 * instrument on the default port is never an error the stranger has to
 * understand. The server is therefore the only thing that knows the answer,
 * and this module is the only thing that reads it.
 *
 * **Loopback is asserted here, not assumed.** The shell will load whatever URL
 * this returns into a window with the app's own privileges, so a line that
 * named a non-loopback host would be a network posture change smuggled in
 * through a log parse. {@link readListeningUrl} refuses anything but
 * `127.0.0.1`/`[::1]`/`localhost` over plain `http`, and the caller treats a
 * refusal exactly like no line at all: the shell stays up and says what it
 * saw. prd-34 changes no network posture, and this is where that promise is
 * actually enforceable.
 *
 * **The token is not in this URL, and that is correct.** ADR-0012 delivers the
 * capability token in-band, stamped into `index.html` at serve time and read
 * back by the page itself (`packages/web/src/recordings/capability.ts`), so the
 * shell loads a bare loopback URL and the page performs the same handshake it
 * performs in a browser. prd-34's blueprint sentence describes JupyterLab's
 * `?token=…`; rhizomorph's equivalent handshake is in-band, and adopting the
 * blueprint means reusing our handshake, not adding a second one. The shell
 * mints no credential and carries none.
 */

/** The exact prefix `run.ts` prints. Kept as a constant so the law test can hold it against the server's own source. */
export const BOOT_LINE_MARKER = 'rhizomorph running at '

/** Hosts a shell window may be pointed at. Anything else is a posture change, not a URL. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The first listening URL in `chunk`, or `null` when there is none *and* when
 * there is one the shell refuses to load. Callers accumulate output and re-run
 * this: a chunk boundary can split the line, and returning `null` for a partial
 * line is the same answer as for no line at all.
 */
export function readListeningUrl(chunk: string): string | null {
  for (const line of chunk.split(/\r?\n/)) {
    const at = line.indexOf(BOOT_LINE_MARKER)
    if (at === -1) continue
    const rest = line.slice(at + BOOT_LINE_MARKER.length).trim()
    // The line ends at the first whitespace; trailing punctuation a future
    // wording change might add is trimmed rather than pasted into a URL.
    const raw = (rest.split(/\s/)[0] ?? '').replace(/[.,;)]+$/, '')
    if (raw === '') continue
    if (!isLoopbackHttpUrl(raw)) continue
    return raw
  }
  return null
}

/** True only for a plain-`http` URL on a loopback host. The one gate the shell's window is behind. */
export function isLoopbackHttpUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  return LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`)
}
