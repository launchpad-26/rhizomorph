/**
 * HTML ESCAPING, as a named unit rather than an inline regex (#557).
 *
 * Every value these pages render comes out of a database that a shipper on a
 * member's machine wrote: lane names, worktree paths, collision paths. None of
 * it is authored by this server and none of it is trusted. It is escaped in one
 * place so that "is this escaped?" has one answer and one test.
 *
 * The five characters are the HTML5 named-reference set for text and
 * double-quoted attribute contexts. `'` is escaped too, so the same function is
 * safe in a single-quoted attribute — the alternative is two functions and a
 * rule about which to use, which is the shape mistakes take.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * ONE PASS, so the map's order is unobservable — and that is the property, not a caveat.
 *
 * An earlier comment here claimed `&` had to come first "or every other replacement's ampersand
 * is escaped a second time". That is true of a sequence of `replace` calls and false of this:
 * `String.replace` with a global regex scans the input once and never re-examines what it has
 * emitted, so no substitution can be re-escaped whatever order the table is written in. The
 * claim was unpinnable — no mutation of the map's order could redden a test — which is why it
 * is stated as a property of the single pass instead.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] as string)
}
