/**
 * Maps a worktree (or any cwd) path to the directory Claude Code tails
 * sessions under: `~/.claude/projects/<slug>`. The slug is the path with
 * every non-alphanumeric character replaced by `-` — verified against real
 * dirs on this machine, e.g.
 * `/home/operator/worktrees-challenge__worktrees/2-core` becomes
 * `-home-operator-worktrees-challenge--worktrees-2-core`, and a dotted path
 * like `/home/operator/work/v2.0/wt` becomes `-home-operator-work-v2-0-wt`
 * (Claude Code maps `.` the same way it maps `/` and `_`).
 *
 * **This is Claude Code's real transform, read out of the shipped binary**
 * (2.1.246, an ELF with the JS embedded, confirmed via `grep -a` — not
 * transcribed from memory):
 *
 * ```
 * function B(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
 * ```
 *
 * matching the same shape recorded from 2.1.241 under a different minified
 * name (`h1r`) — confirmed live too: a real session started in
 * `/tmp/slugprobe3/a+b~c(d),e'f@g` minted `-tmp-slugprobe3-a-b-c-d--e-f-g`,
 * so `+ ~ ( ) , ' @` all map alongside `/`, `_`, `.`, `\`, `:` and a literal
 * space.
 *
 * **KNOWN, NAMED GAP (#124): the 200-character cap and base36 hash suffix
 * are not implemented.** The shipped binary wraps the replace above in a
 * second function that truncates past a length cap (`Pae`, 200) and appends
 * a hash of the untruncated input (`lX_(e)`, base36) rather than letting the
 * slug grow unbounded:
 *
 * ```
 * function qY(e){let t=h1r(e); if(t.length<=Pae) return t; return `${t.slice(0,Pae)}-${lX_(e)}`}
 * ```
 *
 * `lX_`'s exact hash algorithm has not been read out of the binary or
 * verified against a real long-path capture, so this function does not
 * attempt to replicate it — guessing wrong would silently mint a slug that
 * LOOKS capped and hashed but still is not the one Claude Code wrote,
 * indistinguishable from correct without the same live-probe evidence the
 * character class above required. This function therefore lets the slug grow
 * past 200 characters uncapped: for a worktree path whose slug would exceed
 * that length, the directory this function computes and the directory Claude
 * Code actually created diverge. There is also an override this function
 * makes no attempt to replicate (`iB` returns `NLu() ?? qY(e)`), unread past
 * its existence.
 *
 * **The space was found wrong by probe, not by argument** (prd-42). A real
 * `claude -p` session started from a directory whose name contains a space
 * produced a slug in which the space had become a dash — so Claude Code's
 * own slugger maps it, `concierge/repos.ts`'s reverse walk already assumed
 * it (its class read `entry.replace(/[._ ]/g, '-')` then; #47 widened it to
 * `/[._:\\ ]/g`), and this function was the one side that disagreed. For any
 * repo whose path contained a space, every transcript was invisible,
 * indistinguishable from an agent that never started — prd-42 ruling 1's own
 * round-trip law (`concierge/repos.test.ts`, moved there by #47) is what
 * proves the two sides agree on the characters the law's generator covers.
 * Both sides map the same class as of prd-42 wave 7 — the walk widened to the
 * full grammar in #120, this function in #124 — so that law is where the
 * agreement between them is pinned.
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
 * function already makes for every other punctuation character: Claude
 * Code's own slugger is one character class, not a per-platform rule.
 */
export function worktreePathToProjectSlug(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9]/g, '-')
}
