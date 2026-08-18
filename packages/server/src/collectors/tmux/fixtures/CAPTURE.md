# tmux captures — provenance and recipe

Three real captures pinning the shapes this collector parses. Per the
dialect-verification discipline the repo applies to every collector, a grammar
is a **versioned capture, not documentation** — a hand-written fixture validates
our reading of `tmux(1)`, not tmux.

## The files

| file | what it pins |
|---|---|
| `list-panes.real.txt` | the tab-separated `list-panes` row shape the collector splits on |
| `capture-pane.before.real.txt` | pane content before an agent acts — the "still working" read |
| `capture-pane.after.real.txt` | the same pane after — what makes the two comparable |

The two `capture-pane` files are a **pair**, and the pairing is the point: the
collector decides "has this pane changed" by comparing content hashes, so a
single capture would pin the parse and prove nothing about the comparison.

## Redaction

**This file did not exist until #649, and that is why these captures carried a
real machine's identity for as long as they did.** There was no recipe to fail
to follow. The sessionlog fixtures beside them had a `CAPTURE.md` documenting a
redaction discipline; these had nothing, so nothing was applied.

`list-panes.real.txt` names paths and a hostname in its own columns, and both
are now substituted:

| column | was | is |
|---|---|---|
| `pane_current_path` | the capture machine's repo and worktree roots | `/repo`, `/repo-wt/<lane>` |
| `pane_title` (for a `bash` pane) | the capture machine's hostname | `HOST-REDACTED` |

Everything the collector reads is otherwise byte-identical: the pane ids, the
session and window names, the window index, the command, and the tab separators
that make the row parseable at all. `list-panes.test.ts` asserts against these
substituted values, so the fixture and its expectations move as one edit — a
capture whose test still expects the old bytes is a capture that stopped being
evidence.

The two `capture-pane` files carry agent instructions rather than paths, and
were already free of identity — checked, not assumed.

## Re-deriving

1. Run a real swarm under workmux, with at least one worker pane mid-task.
2. `tmux list-panes -a -F '#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}'`
3. `tmux capture-pane -p -t <pane>` twice, either side of an agent acting.
4. **Substitute before committing**, per the table above and the ruling on #649:
   home paths, usernames and hostnames become obviously-synthetic placeholders,
   chosen so no later reader mistakes one for captured truth.
5. Update `list-panes.test.ts`'s expected values in the same commit.

Step 4 is not optional and not a courtesy. This repository is public.
