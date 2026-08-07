# Docker and the installer question — a decision brief for the leads

**Status:** research note, 2026-08-07 — written to ground a leads' discussion
(Lachlan + Gabe). Two questions, both raised as "unsure": should this repo have
Docker support in the name of system agnosticism, and would an installer be
useful. Claims below are graded: **[verified]** = checked against the tree or a
run this session; **[recorded]** = already ruled or documented elsewhere, cited.

## Question A — Docker

**Recommendation: no container runtime. The instrument's subject is the host;
containerizing it blinds it.**

- **[verified]** Zero container artifacts or discussion exist — no Dockerfile,
  compose file, or devcontainer, and no mention across all six review
  strategies (`docs/review/`) or the three agnosticism-era spikes
  (`docs/research/`). The question has never been raised because nothing pulls
  toward it.
- **[verified]** Every core signal is a host fact, one line each:
  - `git`/`tmux`/`workmux` on the host's PATH, via the argv-only exec seam
    (`packages/server/src/server/exec.ts`, constitutional per ADR-0004);
  - transcripts found by mapping the host's **absolute worktree path** to a
    slug under `~/.claude/projects`
    (`packages/server/src/collectors/sessionlog/worktree-slug.ts:8`) — a
    container's remapped paths break the join outright;
  - process liveness read from `/proc`
    (`sessionlog/process-probe.ts`) — a container's `/proc` is not the host's,
    the exact cross-namespace gap the file already documents for WSL;
  - the OTel receiver binds `127.0.0.1` (ADR-0008) and every agent is pointed
    at that loopback by `rhizomorph env` — a container boundary turns the
    same-machine trust story into a port-forwarding exercise.
- **[verified]** A containerized rhizomorph is therefore an L0-at-best
  instrument (git-only, if the repo is mounted at an identical absolute path)
  with new failure modes — strictly worse than running it native.
- **[recorded]** Docker does not address the real agnosticism gap. prd-15
  ruling 7 names it: a **Windows-native verification pass** with captures, not
  confidence. Containers on Windows run Linux; a Docker lane would spend effort
  to leave that gap exactly where it is. Agnosticism here is delivered by
  degradation rungs and native verification (prd-15 rulings 5 and 7), not by
  environment substitution.
- **Niches that would be legitimate, named and deliberately unclaimed:** a
  `.devcontainer` for *developing this repo* (not running the instrument), and
  a fixtures-only demo image. Both are low-value today — the sample-fleet
  affordance (#259) already delivers the demo case in the browser with zero
  infrastructure.

**Proposed ruling A:** *the instrument runs on the host it observes* — no
container runtime target; devcontainer/demo-image stay unclaimed until someone
brings a real use the sample fleet cannot serve. If blessed, worth recording as
an ADR (this question will recur from the cohort; a numbered record kills the
re-litigation).

## Question B — the installer

**Recommendation: the installer is `npm publish`, it is already built, and its
sequencing is already ruled. What remains are one operator decision and one
interim fix.**

- **[verified]** The machinery exists and is guarded end-to-end: root
  `package.json` carries the `rhizomorph` bin and a `files` allowlist; the
  packaging guard runs byte-identically in CI and `release.yml`; release fires
  only on a `v*` tag with a version triple-guard and fails closed without a
  human-held `NPM_TOKEN`; `pack-smoke` proves the tarball on a 4-leg OS×Node
  grid on every push. Nothing needs building — it is dormant **by ruling**.
- **[recorded]** prd-15 owns the sequencing: publish is its **last** wave (8),
  explicitly after the Windows-native pass (wave 6), so agnosticism lands
  before a stranger's `npm install` becomes the front door. The six-strategy
  review pushes the same direction from the other side: *"highest-leverage next
  move is distribution, not features"* (kimi), and *"delay 'any CLI / any OS'
  positioning until real non-Claude and Windows evidence exists"* (sol).
- **Alternative installers considered and rejected:** `curl | sh` — wrong
  posture for a tool whose brand is a trust document; OS package managers
  (brew/winget/scoop) — premature before npm distribution has a single
  stranger-run behind it. `npx rhizomorph` *is* the installer for a Node tool.
- **[verified] The interim gap is real and already review-flagged:** a clone
  never puts `rhizomorph` on an interactive shell's PATH, yet the guides and
  the UI's own baked-in remedy strings all instruct `rhizomorph <cmd>`
  (sol-xhigh product review, "pick one clone-safe syntax… and test every
  documented remedy"). CHANGELOG also contradicts the README by calling 0.1.0
  a "First published release" with an npx install route. Fix now, independent
  of any publish decision — filed alongside this note.

**Proposed ruling B:** no new installer work. The distribution path is prd-15
waves 6 → 8 as already ruled; the leads' open item is the go/no-go around the
publish preconditions (an operator decision, not a build task — details with
the leads); the interim clone-safe-syntax fix and the Windows wave-6 pass are
filed as issues and don't wait.

## What this note deliberately does not cover

The publish preconditions include an operator-level item the leads are handling
directly; it is out of scope for this public note by design.

---

*Sources: the fact-finding sweep of 2026-08-07 (package.json, ci.yml,
release.yml, pack-smoke.sh, collectors, prd-15, roadmap, docs/review/*,
docs/research/*). No product code was changed by this note.*
