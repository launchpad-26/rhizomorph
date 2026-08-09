/**
 * ONE EXTRACTION FOR EVERY SYNTACTIC FORM AN IMPORT CAN TAKE.
 *
 * Three source-grep laws police what a directory may import —
 * `drawer/readonly.test.ts`, `lab/no-live-fleet-law.test.ts` and
 * `lab/launch/explicit-invocation-law.test.ts` — and until PR #301's review
 * each carried its own specifier regex, all three matching only the static
 * `… from '…'` form. A side-effect import (`import '../x.js'`), a dynamic
 * import (`import('../x.js')`) and a template-literal specifier
 * (``import(`../x.js`)``) reach the same module while a from-only law stays
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
 * Static, re-export and side-effect forms take `'…'` or `"…"`. The dynamic
 * form additionally takes a template literal — and ONLY the dynamic form
 * does, because that is the grammar: `from `…`` and `import `…`` are syntax
 * errors in JS, so a backtick there is prose, not code. That asymmetry is
 * load-bearing, not fussiness — `lab/LabPage.tsx:125`'s own doc comment
 * says ``…importing `cssColour` from `../scene/`…``, and a backtick branch
 * on `from` reads that sentence as a scene import and fails the law on
 * documentation.
 *
 * A template-literal specifier comes back raw, `${…}` and all — a computed
 * `` import(`../../scene/${name}.js`) `` still *starts* with the path being
 * policed, so a prefix check sees it rather than nothing.
 *
 * Otherwise as crude as the laws it serves, on purpose: it will also
 * "extract" from a commented-out import or a quoted `from '…'` inside a
 * string. For a forbid-law that is the right failure direction — a false
 * match fails loudly in a diff a reviewer reads; a missed form passes
 * silently forever.
 */

const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s+)(?:'([^'\n]*)'|"([^"\n]*)")|\bimport\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g

/** Every import specifier in `text`, in source order, in every form named above. */
export function extractImportSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].map(
    (match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])!,
  )
}
