/**
 * Maps a worktree (or any cwd) path to the directory Claude Code tails
 * sessions under: `~/.claude/projects/<slug>`. The slug is the path with
 * every `/`, `_`, `.`, `\` and `:` replaced by `-` — verified against real
 * dirs on this machine, e.g. `/home/operator/worktrees-challenge__worktrees/2-core`
 * becomes `-home-operator-worktrees-challenge--worktrees-2-core`, and a
 * dotted path like `/home/operator/work/v2.0/wt` becomes
 * `-home-operator-work-v2-0-wt` (Claude Code maps `.` the same way it maps
 * `/` and `_`).
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
  return worktreePath.replace(/[/_.\\:]/g, '-')
}
