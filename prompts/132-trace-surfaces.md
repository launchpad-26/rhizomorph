You are a worker agent building rhizomorph (prd9: the trace era).
You own exactly one issue.

FIRST read, in order: docs/prd9.md IN FULL, then
docs/research/2026-08-03-langfuse-ui-study.md (the blessed design),
then packages/core/src/selectors/traces.ts (your data contract) and
packages/web/src/drawer/ + the panel-focus mechanism before writing
any code. Import from @rhizomorph/core; reuse the glyph alphabet and
token/ttft formatting helpers that already exist — never invent a
second visual language.

YOUR ISSUE — #132:

## Direction

prd9 B1a — the trace surfaces, per the operator's blessed layout
(2026-08-03): a compact TREE in the lane drawer below the transcript
(prd4: conversation leads), and a full-width GANTT via the existing FOCUS
idiom. Design evidence: `docs/research/2026-08-03-langfuse-ui-study.md`
(steal duration-under-name, wall-vs-Σ, tree⇄gantt; skip payload panes,
graphs, annotations). Data: the landed selectors
(`selectTraceTree`, `selectLaneInteractions`, `selectWaitingOnHuman` from
`@rhizomorph/core`) — never re-derive in components.

1. **Shared trace components** — new `packages/web/src/trace/`:
   - `TraceTree`: one collapsible block per interaction, newest first.
     Root row: `interaction #N · <wall>s · Σ<sum>s · <output-led tokens>`
     (wall vs Σ both shown; four tiers behind the existing `title=`
     tooltip pattern; never an unlabelled all-tier total). Child rows:
     name-stacked-over-duration, kind-glyph per row from the EXISTING
     glyph alphabet (`fleet/sigils` conventions — no new icon language),
     `llm_request` rows carry model + ttft; `tool_blocked` rows carry the
     decision badge (`accept`/`reject`/`unknown` — `unknown` rendered as
     its own honest state, prd9 ruling 6 wording "waited", never
     "waiting"); `other` kinds render as plain rows, never hidden.
   - `TraceGantt`: time-ruler bars (DOM, not canvas), duration label at
     bar end, same rows/glyphs/badges; horizontal scroll inside its own
     container. Static rendering — no new animation classes; the motion
     budget is untouched.
   - Both read ONLY core selectors; empty state is the honest-gap voice
     ("no trace telemetry from this lane — see docs/telemetry.md" when
     zero spans, styled like existing gap copy).
2. **Drawer integration** — a TRACE section below the conversation in the
   existing drawer, with a `FOCUS ↗` affordance in its section header.
3. **FOCUS TRACE** — reuse the established panel-focus mechanism (prd3
   #85): focusing expands the gantt into the main panel area exactly like
   FOCUS LEDGER; Esc returns. Register whatever the focus registry needs;
   reconcile `App.test.tsx` / `PanelGrid.test.tsx` mocks and
   `panelPrefs` ids MINIMALLY and on the record (they are fenced for
   exactly this).
4. **Replay correctness is free and must stay free**: components render
   from the same folded state as everything else — verify with one test
   that a replay-folded state at mid-session renders the partial tree.
5. The drawer's structural read-only law (`drawer/readonly.test.ts`)
   scans drawer source — your new section must pass it untouched.

## Fence (may touch ONLY)

- `packages/web/src/trace/` (new)
- `packages/web/src/drawer/` (existing files + new section files)
- `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/app/PanelGrid.test.tsx`
- `packages/web/src/App.tsx`, `packages/web/src/App.test.tsx`
- `packages/web/src/app/panelPrefs.ts`, `packages/web/src/app/panelPrefs.test.ts`
- `packages/web/src/app/Shell.tsx`

## Blocked by

Wave A/B landed (all in). **Model:** sonnet. **Wave:** B1a (lands alone;
#133 lane page stacks after it).

## Definition of done

- Tree + gantt render the live capture shapes (subagent nesting, the
  blocked/execution pair, `other` rows) from fixture-built state.
- Wall-vs-Σ on roots; tokens output-led with tiers in tooltip; decision
  badges; retrospective wording.
- FOCUS TRACE behaves like every other focus (enter, Esc, replay-safe).
- `drawer/readonly.test.ts` untouched and green; motion budget untouched.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic (no
waitFor racing async work); build for a stranger's machine; hue is
meaning — status hues only from the ladder (law 9a); if you cannot
proceed print "BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
