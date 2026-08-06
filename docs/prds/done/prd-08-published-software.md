# prd8 — rhizomorph: from private project to published software

> **Outcome:** shipped. Publishing itself was later removed from scope by prd9 and reopened by prd15, still gated on #177.

The instrument is finished and the board is empty. This prd makes it
something a stranger can find, trust, install and run. Decisions from the
publishing interview, operator, 2026-08-02/03:

## Rulings

1. **It is published for real users**, not as a portfolio artifact. That
   sets the bar: install in one command, an honest support matrix,
   versioned releases, and a package that contains only what a user
   needs.
2. **The name is `rhizomorph`** — in mycology, the root-like cord of
   bundled hyphae that transports nutrients across distance to the
   colony. It is the thing this app draws: the ribbon that carries a
   lane's substance home to main. Verified free on npm (registry 404).
   The npm package, the bin, and the command are all `rhizomorph`;
   `npx rhizomorph <path-to-repo>` is the install story.
3. **Posture: released as-is, issues welcome.** The README says so in
   plain words. No promise of response times, no pretence of a support
   contract. Honest, and survivable alongside a 9–5.
4. **The licence question is settled by investigation, not permission.**
   Only four paths in the tree were first authored upstream, none are
   referenced by the app: `.claude/skills/tmux-driver/SKILL.md`,
   `.claude/skills/workmux/SKILL.md`, `.agent/skills`, and the README's
   surviving vim-tmux-navigator block (itself MIT, from
   christoomey/vim-tmux-navigator, and irrelevant to using this tool).
   They are removed from the published tree rather than relicensed.
   Everything else is Lachlan Kelliher's own work; MIT stands.
5. **The package must be an allowlist.** `package.json` currently has
   `private: true`, `version: 0.0.0`, no `license`, no `files`, and no
   `.npmignore` — so a publish today would ship `.claude/`, `.swarm/`,
   `prompts/`, `docs/research/` and the whole conductor toolkit to the
   registry. Publishing ships the built app and its docs, nothing else,
   and that is verified by inspecting `npm pack` output, not assumed.
6. **Trust is a first-class feature of the README.** This tool reads
   `~/.claude/projects` — the operator's own agent conversations — and
   serves them over localhost. The docs must say plainly WHAT it reads,
   WHERE it listens (127.0.0.1 only), and that nothing is ever sent
   anywhere. The honest behaviour already exists; it has never been
   stated.
7. **Claim only what is verified.** Linux is CI-verified on every push;
   WSL is the daily development platform; macOS is unverified and must
   be labelled as such until someone runs it there.
8. **The public home is decided after the cleanup**, not before — the
   choice between a fresh standalone repo and detaching this fork is
   cheap and obvious once the tree is publishable. The 118 closed issues
   are the project's decision record and must survive in some public
   form whichever way it goes.

## Implementation waves (issues #119–#122)

Wave 1: **#119** the rename to rhizomorph (mechanical, everywhere — it
must land alone). Wave 2, in parallel: **#120** the publishable package
(licence strip, allowlist, npm metadata, `npm pack` verification) ·
**#121** the stranger's documentation (README for users, privacy and
support sections, CONTRIBUTING, SECURITY, and the prd7 docs staleness).
Wave 3: **#122** release engineering (semver 0.1.0, CHANGELOG, tagged
release). Gates run the bounded busy-box standard throughout.
