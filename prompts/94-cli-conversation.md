## Direction (prd4 ruling 4)

Clicking a lane shows what you would see using a claude/codex agent: the
conversation itself. The drawer's main view becomes a CLI-style session —
chronological, tail-following, the default and largest section.

**Server** (`packages/server/src/api/transcript.ts` — same route; the
read-only law test greps the directory and allows only `/api/transcript/`):
return a STRUCTURED response alongside the existing byte-offset paging —
`entries: [{ ts?, role, blocks }]` where role ∈ user | assistant |
subagent (current `isSidechain` mapping) and blocks are
`{kind:'text', text}` | `{kind:'tool_use', name, hint}` |
`{kind:'tool_result', text}`. The parsing already exists in
`renderTranscriptLine` (:271-294) — restructure it to emit records instead
of a flat string (~40 lines); thinking blocks stay unrendered; keep the
law-12 absence behavior (404 + reason) and the restart detection. Drop or
keep the legacy `text` field — your call; if dropped, update its tests to
the structured shape.

**Drawer** (`packages/web/src/drawer/**`): the conversation replaces the
old collapsed Transcript as the flex-1 main section, styled like an agent
CLI session:
- user turns visually distinct (prompt-like), assistant prose readable
  (not a `<pre>` wall) — sans for prose, mono for figures/code, per law 11;
- tool calls as quiet one-liners between assistant text: `● Name — hint`;
  tool results truncated quietly (expandable is fine, not required);
- chronological order, follow-the-tail with the existing scroll-up pause
  behavior (reuse the `isAtTail` logic);
- subagent turns marked as such, visually quieter.
- Section order becomes: Vitals → Conversation (flex-1, default-on,
  polling while open) → Activity (compact, the git/file/commit audit
  trail — keep its fold as-is) → Attach (unchanged).
- The collapsed-by-default ruling comment in Transcript.tsx is superseded
  by prd4 ruling 4 — say so where you change it. Shell.test's
  no-fetch-on-mount pin updates accordingly (the drawer polls only while
  OPEN; nothing fetches when no lane is selected — keep THAT half true).

## Fence (may touch ONLY)

- `packages/server/src/api/transcript.ts`, `packages/server/src/api/transcript.test.ts`
- `packages/web/src/drawer/**`
- `packages/web/src/App.test.tsx` and `packages/web/src/app/Shell.test.tsx`
  ONLY IF an existing pin about drawer fetch/mount behavior must evolve —
  minimal reconciliation, and say so in the commit message.

## Blocked by

Nothing (zero overlap with #92). **Model:** opus. **Wave:** 1.

## Definition of done

- Structured endpoint: tests for role mapping, tool_use hints,
  tool_result truncation, paging with entries, absence (law 12), restart.
- Drawer: conversation renders a real fixture transcript CLI-style; tail
  follow + scroll-up pause proven; Activity still proves its three kinds;
  read-only law test still green (GET only, no new routes).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments as you go.**
  Never push, never merge, never switch branches.
- Build for a stranger's machine — no user-specific paths or assumptions.
- If blocked, print `BLOCKED: <need>` and stop.
