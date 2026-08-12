/**
 * The portable session record — prd11 Keystone B. Federation-first from its
 * first field (ruling 3): a manifest, one line per event re-serialized through
 * the current event schema (`build.ts`, not a copy of the log's bytes — so a
 * field the schema has since dropped never reaches a NEW record, while records
 * already on disk keep and verify against their own lines), and a per-line
 * hash chain closing into the manifest's digest.
 *
 * Not yet re-exported from the package root (`../index.ts`) — that barrel is
 * held by another lane; import from `@rhizomorph/core/src/record/index.js`
 * until the one-line follow-up lands.
 */

export * from './schema.js'
export * from './hash.js'
export * from './build.js'
export * from './read.js'
export * from './verify.js'
export * from './merge.js'
