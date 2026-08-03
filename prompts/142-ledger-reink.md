You are a worker agent on rhizomorph (prd9: the trace era, rolling).
You own exactly one issue. Read the files your issue names IN FULL
before changing anything; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #142:

## Direction

The ledger alias debt, called out by the legibility law test itself
(#136): `panels/ledger/index.tsx` still paints in stock Tailwind
`slate-*` and the pre-prd3 `void`/`neon-*` legacy aliases, so it sits
outside the ice register and the new legibility floor — visibly dimmer
than every re-inked surface around it (operator's original complaint
surface).

1. **Re-token the ledger**: every `slate-*`, `void*` and `neon-*` usage in
   `panels/ledger/` moves to the proper ice-ramp/status tokens — text at
   or above the `ice-400` floor, status hues only where the hue's one
   meaning applies (law 9a), figures mono+tabular (law 11). Visual
   intent preserved: this is a re-inking, not a redesign.
2. **Extend the law's reach**: `theme/legibility.test.ts` currently
   documents the ledger as out-of-pattern by construction — remove that
   carve-out and add the ledger's directory to the walked set; add a
   second check that `panels/ledger/` contains NO `slate-`/`void`/`neon-`
   classes (the debt can never silently return).
3. Do NOT delete the theme.css legacy alias tokens themselves —
   StatusBar/replay usages are outside this fence; the aliases die when
   their last caller does (note remaining callers in your summary).

## Fence (may touch ONLY)

- `packages/web/src/panels/ledger/` (all files)
- `packages/web/src/theme/legibility.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** rolling.

## Definition of done

- Zero legacy classes in the ledger, law-tested; every text token at or
  above the floor; hue laws intact; ledger visually consistent with the
  re-inked surfaces (the operator eyeballs it after landing).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
