/**
 * `?raw` imports — the era corpus's only way in.
 *
 * The recordings and their snapshots are bytes on disk, and the corpus law is
 * about bytes, so they have to be read as text rather than as parsed JSON. Core
 * has no Node types in scope (see `fold.ts`'s header) and must not grow any, so
 * the reading is done by the bundler at import time instead of by `fs` at run
 * time: `corpus.ts` imports each file with Vite's `?raw` suffix and gets its
 * exact contents as a string.
 *
 * This declaration is what makes `tsc` agree. It is the same declaration
 * `vite/client` ships (which `packages/web` uses via its `types` field);
 * declared locally here because this package's tsconfig is not this lane's to
 * change, and because these two files are the only `?raw` importers in core.
 */
declare module '*?raw' {
  const text: string
  export default text
}
