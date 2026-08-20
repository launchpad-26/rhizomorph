import type { ServerStatus } from './supervisor.js'

/**
 * WHAT THE WINDOW SHOWS WHEN THERE IS NO INSTRUMENT TO SHOW (prd-34's D43:
 * "failure degrades loudly and keeps working — the broken part names what died,
 * when, and how to restart it, in the same honest-gap voice used for missing
 * data").
 *
 * A shell whose server did not start has exactly two honest options: quit, or
 * show a window that says so. Quitting is the one this instrument may not take
 * — an app that vanishes on failure teaches a stranger that the software is
 * flaky rather than that something specific went wrong — so the window opens on
 * this.
 *
 * **This is not a surface, and it is deliberately unlovely.** It renders no
 * fleet, no lane, no number and nothing that could be mistaken for telemetry;
 * it is three facts and a command. Ruling 1 forbids the shell growing a private
 * fork of a surface, and the cheapest way to keep that promise is for the
 * shell's only markup to be something no one would ever mistake for the
 * instrument. `no-fork-law.test.ts` holds the rest of the package to the same
 * line.
 *
 * The three facts D43 names, in order: **what died** (the phase and the
 * server's own reason), **when** (the timestamp, injected so this is testable),
 * and **how to restart it** (the exact command, which is the same one
 * `rhizomorph doctor` and the README already hand people — the shell invents no
 * new recovery ritual).
 */

export interface FailurePageInput {
  status: ServerStatus
  /** ISO instant the failure was noticed. Injected — this module reads no clock. */
  at: string
  /** The repo the shell tried to watch, or null when none was chosen yet. */
  repoPath: string | null
}

/** The command a person runs to see the same failure in a terminal, where the output is not behind a window. */
export function restartHint(repoPath: string | null): string {
  return repoPath === null ? 'npx rhizomorph' : `npx rhizomorph ${repoPath}`
}

/** A whole `data:`-loadable HTML document. No script, no fetch, no state — it cannot itself fail. */
export function failurePage(input: FailurePageInput): string {
  const detail = input.status.detail ?? 'the server stopped without saying why'
  const tail = input.status.outputTail
  const tailBlock =
    tail.length === 0
      ? '<p class="gap">the server printed nothing before it stopped — that absence is itself the strongest clue, and it usually means the entry point could not be found or could not be read.</p>'
      : `<pre>${tail.map(escapeHtml).join('\n')}</pre>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>rhizomorph — the server did not start</title>
<style>
  /* Theme-awareness in pure CSS: a data: page has no IPC and needs none —
     prefers-color-scheme in an Electron window follows nativeTheme, so this
     page wears whichever world the OS is in. The values are the web theme's
     own registers (ice on dark, paper on light), stated as literals because
     there is no cascade here to var() into. */
  :root { color-scheme: light dark }
  body { background: #04060c; color: #c3cbd9; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 6vh 8vw }
  h1 { color: #f0b429; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 1.5rem }
  dt { color: #6b7891; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; margin-top: 1.25rem }
  dd { margin: .25rem 0 0 }
  code, pre { background: #080b14; border: 1px solid #1b2334; border-radius: 3px; padding: .5rem .75rem; display: block; overflow-x: auto; color: #dbe3ef }
  .gap { color: #6b7891 }
  @media (prefers-color-scheme: light) {
    body { background: #faf6ef; color: #52384e }
    h1 { color: #714a00 }
    dt, .gap { color: #674c61 }
    code, pre { background: #f3eee4; border-color: #dfd1c6; color: #40273c }
  }
</style>
</head>
<body>
<h1>the server did not start</h1>
<dl>
  <dt>what died</dt>
  <dd>${escapeHtml(detail)}</dd>
  <dt>when</dt>
  <dd>${escapeHtml(input.at)}</dd>
  <dt>how to restart it</dt>
  <dd><code>${escapeHtml(restartHint(input.repoPath))}</code></dd>
  <dt>what the server printed</dt>
  <dd>${tailBlock}</dd>
</dl>
<p class="gap">The shell is still running and the tray is still there. Nothing was lost: the session log is on disk, and the next successful boot resumes it.</p>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
