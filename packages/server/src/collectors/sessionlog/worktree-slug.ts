/**
 * Maps a worktree (or any cwd) path to the directory Claude Code tails
 * sessions under: `~/.claude/projects/<slug>`. The slug is the path with
 * every `/`, `_`, `.`, `\`, `:` and a literal space replaced by `-` —
 * verified against real dirs on this machine, e.g.
 * `/home/operator/worktrees-challenge__worktrees/2-core` becomes
 * `-home-operator-worktrees-challenge--worktrees-2-core`, and a dotted path
 * like `/home/operator/work/v2.0/wt` becomes `-home-operator-work-v2-0-wt`
 * (Claude Code maps `.` the same way it maps `/` and `_`).
 *
 * **This six-character class is a hand-maintained approximation, not Claude
 * Code's real transform.** Read out of the shipped Claude Code binary
 * (2.1.241, an ELF with the JS embedded, confirmed via `grep -a` — not
 * transcribed from memory):
 *
 * ```
 * function h1r(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
 * function qY(e){let t=h1r(e); if(t.length<=Pae) return t; return `${t.slice(0,Pae)}-${lX_(e)}`}
 * ```
 *
 * with `Pae` (200) capping the length and appending a base36 hash suffix
 * past it, plus an override (`iB` returns `NLu() ?? qY(e)`) this function
 * makes no attempt to replicate. The real class is EVERY non-alphanumeric
 * character, not six of them — confirmed live too: a real session started in
 * `/tmp/slugprobe3/a+b~c(d),e'f@g` minted `-tmp-slugprobe3-a-b-c-d--e-f-g`,
 * so `+ ~ ( ) , ' @` all map alongside the six characters below. Closing that
 * wider gap (length cap and hash suffix included) is out of this function's
 * current scope; #47 tracks the colon/backslash slice of it.
 *
 * **The space was found wrong by probe, not by argument** (prd-42). A real
 * `claude -p` session started from a directory whose name contains a space
 * produced a slug in which the space had become a dash — so Claude Code's
 * own slugger maps it, `concierge/repos.ts`'s reverse walk already assumed
 * it (`entry.replace(/[._ ]/g, '-')`), and this function was the one side
 * that disagreed. For any repo whose path contained a space, every
 * transcript was invisible, indistinguishable from an agent that never
 * started — prd-42 ruling 1's own round-trip law
 * (`worktree-slug.test.ts`) is what proves the two sides now agree on the
 * space specifically, not on every character this function still misses.
 *
 * **`\` and `:` are the Windows half, and they are evidenced rather than
 * assumed** (ledger #11). `research/2026-08-14-cross-host-resume.md` §"Both
 * copied" reads a real Windows-origin slug directory,
 * `C--Users-operator-agenticlaunchpad`, which is `C:\Users\operator\agenticlaunchpad`
 * with the same single substitution applied to its drive colon and its
 * backslashes. Without them this function turned that path into
 * `C:\Users\operator\agenticlaunchpad` unchanged and would have looked for a
 * transcript in a directory Claude Code never writes.
 *
 * Latent today and worth taking anyway: the server cannot run on Windows yet
 * (#281), so no caller reaches this with a Windows path — but the DESTINATION
 * host is what decides the slug, and the concierge's migration (ADR-0020) is
 * exactly the feature that carries a transcript between hosts.
 *
 * The substitution is applied on every platform rather than switched on
 * `process.platform`, because the slug belongs to the PATH rather than to the
 * machine reading it: a Windows path named on a Linux server must produce the
 * slug Windows would. The cost is that a POSIX path legitimately containing
 * `:` or `\` — legal, rare — maps them too, which is the same inference this
 * function already makes for `.` and `_`: Claude Code's own slugger is one
 * character class, not a per-platform rule.
 */
export function worktreePathToProjectSlug(worktreePath: string): string {
  return worktreePath.replace(/[/_.\\: ]/g, '-')
}
