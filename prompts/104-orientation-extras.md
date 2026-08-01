## Direction (prd5 rulings 1+6 — orientation extras)

Two idioms stolen from tools that solved many-things-at-once decades ago
(docs/research/2026-08-01-obs-prd5-prior-art.md):

1. **The idle-worker jump (SC2)**: a keyboard affordance that cycles
   selection through the lanes that NEED YOU, worst/oldest first.
   Suggested key: `n` (next needs-you), `Shift+n` backwards. Selecting
   via jump behaves exactly like clicking the lane (drawer opens, scene
   spotlights, table highlights) — one shared selection, no new state.
   When nothing needs you, `n` does nothing visible except a brief "all
   clear" flash on the attention strip region (no layout shift).
2. **Single-key verbs on the fleet table (k9s idiom)**: with a lane row
   focused (keyboard or selection), `f` toggles panel focus on the
   fleet panel, `a` copies the ATTACH command for the selected lane
   (same clipboard path as the drawer's AttachButton — reuse, don't
   duplicate), `Esc` keeps its existing precedence chain untouched.
   A one-line key hint appears in the fleet panel footer (dim, mono).

Keys must not fire while typing in any input/textarea (standard guard),
must not collide with the existing Esc chain or #100's camera keys
(`0`,`1`,`+`,`-` — those are scene-scoped; yours are global/table-scoped;
document the split in a comment), and must be discoverable (the footer
hint + a `?`-style listing is NOT in scope — just the hint line).

## Fence (may touch ONLY)

- `packages/web/src/fleet/selection.tsx`, `selection.test.tsx`
- `packages/web/src/panels/fleet/index.tsx`, `index.test.tsx`
- `packages/web/src/app/keyboard.ts` (new), `keyboard.test.ts` (new)
- `packages/web/src/app/Shell.tsx`, `Shell.test.tsx` (mount the handler ONLY — minimal)
- `packages/web/src/App.test.tsx` (only if a shell-level pin must evolve; minimal, say so)

## Blocked by

Nothing (fence disjoint from wave-1 siblings — #100 owns scene/**, #103
owns panels/attention/**). **Model:** sonnet. **Wave:** 1.

## Definition of done

- Tests: jump cycles worst-first and wraps; jump = click (same selection
  effects); typing guard; `a` copies the attach command (clipboard
  mocked); `f` toggles focus; Esc chain regression-proven; hint renders.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
