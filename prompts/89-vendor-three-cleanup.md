## What

#81 dropped three.js (the scene is canvas 2D), but
`packages/web/vite.config.ts` still carries the `vendor-three`
manualChunks rule (and its comment). The regex simply never matches now —
harmless at runtime, but dead config lies to the next reader about what
the bundle contains.

## Fence (may touch ONLY)

- `packages/web/vite.config.ts`

## Blocked by

#81 (landed). **Model:** sonnet. **Wave:** follow-up (micro).

## Definition of done

- The vendor-three rule and its comment are gone; any remaining chunk
  rules untouched.
- `npm run build` succeeds; root `npm test` + `npm run typecheck` green.
