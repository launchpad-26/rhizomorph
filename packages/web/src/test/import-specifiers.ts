/**
 * ONE EXTRACTION FOR THE IMPORT FORMS THE LAWS POLICE.
 *
 * Three source-grep laws police what a directory may import —
 * `drawer/readonly.test.ts`, `lab/no-live-fleet-law.test.ts` and
 * `lab/launch/explicit-invocation-law.test.ts` — and until PR #301's review
 * each carried its own specifier regex: the drawer sweep and both
 * fleet/panels pattern sets matched only the static `… from '…'` form, and
 * the scene detector, which already saw quoted bare and dynamic forms,
 * missed template literals. A side-effect import (`import '../x.js'`), a
 * dynamic import (`import('../x.js')`) and a template-literal specifier
 * (``import(`../x.js`)``) reach the same module while a narrower law stays
 * green — the exact species of gap #297 exists to close. This module is the
 * one place the forms are enumerated, so the three laws cannot drift apart
 * on which forms they can see.
 *
 * It is deliberately a plain module, not a test file: the laws' recursive
 * *walkers* stay duplicated because importing one test file from another
 * makes vitest re-run the imported suite nested under the importer (see
 * `explicit-invocation-law.test.ts`'s file doc) — a module with no
 * `describe` blocks carries no such cost, so sharing it invents no coupling
 * the walkers were kept apart to avoid.
 *
 * Forms covered:
 *
 * - static:       `import { x } from '…'`, `import x from '…'`,
 *                 `import * as ns from '…'`, `import type { T } from '…'`
 * - re-export:    `export { x } from '…'`, `export * from '…'`
 * - side-effect:  `import '…'`
 * - dynamic:      `import('…')`, `await import('…')`
 *
 * Between the keyword and its specifier the grammar allows more than
 * whitespace, and the matcher crosses all of it: nothing at all
 * (`import'../x.js'` is two tokens, no separator needed), block comments
 * (`import /* preload *\/ '../x.js'`, `import(/* @vite-ignore *\/ '../x.js')`
 * — closing delimiters escaped here only because this doc is itself a block
 * comment) and line comments. This repo's biome formatter is disabled
 * (`biome.json`), so no tooling normalizes those spellings away before a
 * law greps the text — the matcher has to see them itself (found by the
 * c77c2ee verify pass, which walked straight past a `\s+` here).
 *
 * Static, re-export and side-effect forms take `'…'` or `"…"`. The dynamic
 * form additionally takes a template literal — and ONLY the dynamic form
 * does, because that is the grammar: `from `…`` and `import `…`` are syntax
 * errors in JS, so a backtick there is prose, not code. That asymmetry is
 * load-bearing, not fussiness — `lab/LabPage.tsx:125`'s own doc comment
 * says ``…importing `cssColour` from `../scene/`…``, and a backtick branch
 * on `from` reads that sentence as a scene import and fails the law on
 * documentation.
 *
 * A template-literal specifier comes back raw, `${…}` and all, wherever the
 * interpolation sits. That raw text is only prefix-checkable when the
 * interpolation follows the policed segment — `` import(`${base}/fleet/x.js`) ``
 * starts with no `../` and matches no forbidden prefix, yet reaches
 * wherever `base` points. The laws therefore fail loudly on ANY specifier
 * containing `${` instead of trusting a prefix check to see it (c77c2ee
 * verify pass); this module just hands the raw text over.
 *
 * NOT covered, and knowingly: `import.meta.glob('…')` (a Vite macro, not
 * ECMAScript import syntax), a specifier built in a variable before
 * `import(p)`, and escape-sequence obfuscation (`'../fleet/x.js'`
 * decodes to a `../` path before resolution) — forms nobody writes by
 * drift. These laws are backstops against accidental
 * reach, not a sandbox against a determined author; that defense is human
 * review.
 *
 * Otherwise as crude as the laws it serves, on purpose: it will also
 * "extract" from a commented-out import or a quoted `from '…'` inside a
 * string. For a forbid-law that is the right failure direction — a false
 * match fails loudly in a diff a reviewer reads; a missed form passes
 * silently forever.
 */

/**
 * Trivia the grammar allows between an import keyword and its specifier:
 * whitespace (including none), block comments, line comments.
 */
const TRIVIA = String.raw`(?:\s|/\*[^*]*(?:\*+[^*/][^*]*)*\*+/|//[^\n]*)*`

// Plain strings, not String.raw, for the arms that name a backtick — a
// literal backtick would end a raw template before the pattern did.
const IMPORT_SPECIFIER_RE = new RegExp(
  "(?:\\bfrom|\\bimport)" + TRIVIA + "(?:'([^'\\n]*)'|\"([^\"\\n]*)\")" +
    '|\\bimport' + TRIVIA + '\\(' + TRIVIA + '(?:\'([^\'\\n]*)\'|"([^"\\n]*)"|`([^`\\n]*)`)',
  'g',
)

/** Every import specifier in `text`, in source order, in every form named above. */
export function extractImportSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].map(
    (match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])!,
  )
}
