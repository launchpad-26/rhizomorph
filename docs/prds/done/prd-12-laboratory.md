# prd12 — the laboratory: forked realities, under an amended constitution

The fork spike (`docs/research/2026-08-04-fork-checkpoint-spike.md`) proved
the moonshot's risky parts live: conversation state forks cleanly
(truncated session + `--resume --fork-session`, codeword-verified), a dirty
workspace snapshots in 0.037s without touching the working tree, and the
whole restore path runs in seconds. What it needed was a ruling on the
founding law. The operator made it, 2026-08-04, citing the scale of the
innovation. This prd records that amendment exactly, then builds the
prototype it permits.

## Ruling 1 — the read-only amendment (operator, 2026-08-04)

The read-only constitution is AMENDED, not dissolved. Two hands:

- **The observer** — everything rhizomorph has been until today — remains
  read-only, absolutely and forever: collectors, receiver, server, UI. Its
  structural law tests (the readonly greps) do not weaken by one line.
- **The laboratory** — the fork engine — is a second, explicitly-invoked
  actor. It may write ONLY: refs under `refs/rhizomorph/`, git objects
  those refs require, worktrees the lab itself creates, and checkpoint /
  synthesized-session artifacts OUTSIDE the watched repo (the same
  data-directory posture as the event log). It never pushes, never merges,
  never touches an operator branch, never runs without a human's explicit
  command. No background process of the observer may invoke it.
- **The Trust section documents both hands separately** — what the
  observer reads and never writes; what the laboratory writes, exactly
  where, and only when you tell it to. The honesty bar of prd8 ruling 6
  applies to both.
- **The amendment ships with its own law tests**: the observer's readonly
  greps stay green untouched; a new lab-namespace test asserts every
  lab-side write path is confined to the namespaces above.

## Further rulings

2. **Checkpoints are captured live, never synthesized** (the spike's
   keystone finding — a past dirty worktree is unrecoverable). Additive
   `fork.checkpoint` event binding event-log index ↔ session-file byte
   offset ↔ snapshot sha; capture is cheap enough to take at natural
   moments (lane dispatch, gate entry, operator command).
3. **Forks are marked synthetic, everywhere.** A forked lane renders as a
   visibly synthetic branch (scene, fleet, ledger, replay); its lineage is
   a verifiable prefix commitment into the session record's hash chain
   (prd11 ruling 3). Honest-gap voice: a fork's spend is real spend and
   says so.
4. **Comparison reports distributions, not points** — n≥3 arms minimum
   before any surface renders a "winner"; below that, the surface shows
   runs, never conclusions (the Goodhart guard extended to realities).
5. **Path hygiene in synthesized sessions**: the fork's session copy
   rewrites the parent worktree's absolute paths to the fork worktree
   (the spike's named hazard — an agent acting on its parent's tree is
   the one corruption this design must make impossible), and lane
   attribution follows the fork's own slug so the observer discovers it
   with zero new collector code.
6. **Prototype scope, honestly labeled**: `rhizomorph fork
   <lane> [--at <checkpoint>]` + treatment flags (model, prompt-file),
   n-arm dispatch through the EXISTING workmux machinery, and a first
   comparison surface that is a TABLE (arms, verified outcomes, cost,
   duration — distributions per ruling 4), not a visualization. The
   forked-realities scene render is prd13+ material; interactive resume
   of a synthesized session under workmux is the lane's first dogfood
   task (the spike's one unprobed link).

## Implementation

Keystone (after prd11 keystone A frees the core events files):
`fork.checkpoint` additive event + capture plumbing. Then the lab lane:
snapshot/restore engine per the spike's proven recipes + the CLI + the
namespace law test + Trust rewrite. Then the n-arm dispatch + comparison
table. Each behind the full gate; the operator's ruling reviews the Trust
language before the round closes.
