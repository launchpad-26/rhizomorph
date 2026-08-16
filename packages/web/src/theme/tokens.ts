/**
 * READING `theme.css` AS DATA — the mechanism the mirror tests are built on,
 * extended from one file to the whole token surface.
 *
 * `scene/palette.test.ts` has parsed the real stylesheet off disk since prd4,
 * for the reason prd-32 restates: a hand-copied expectation drifts in exactly
 * the way the test exists to catch. prd-32's rejected alternatives name the
 * generalisation of that idea and refuse it — *a token pipeline dependency*
 * (Style Dictionary and kin) buys a build stage the repo does not want. So the
 * house mechanism extends instead: these are pure functions over CSS *text*,
 * and the tests do the reading.
 *
 * Pure over text rather than over a path, and that is load-bearing twice. It
 * keeps `node:fs` out of a module that lives under `src/`, and it makes every
 * law here riggable — the contrast law is handed a synthetic light theme to
 * prove it computes a second one before #551 lands a real one, and the
 * category caps are handed deliberately illegal families to prove each cap
 * bites. A law that has never been shown failing is a law nobody has checked.
 *
 * This is a token reader, not a CSS parser: it understands `--name: value;`
 * inside a brace-delimited block, and it understands nesting well enough to
 * skip it. That is the whole of what the laws need.
 */

/** A block's own declarations: token name (with leading `--`) → literal value. */
export type Declarations = ReadonlyMap<string, string>

/**
 * A theme, as the contrast law sees it: a name and the fully resolved token
 * table that applies when it is active.
 */
export interface Theme {
  readonly name: string
  readonly tokens: Declarations
}

/**
 * The body of the first block introduced by `opener`, brace-matched.
 *
 * Brace-matched rather than regex-bounded because `@utility focus-ring` nests
 * `&:focus-visible { … }` inside itself, and a `[^}]*` pattern would stop at
 * the inner brace and silently return half a block — the failure mode where a
 * law passes because it read nothing.
 *
 * Comments come out first, or `:root` finds the paragraph *about* `:root` that
 * sits three lines above the rule. That is not hypothetical: `theme.css`
 * explains why the role tokens live in a plain `:root` immediately before
 * opening one.
 */
export function blockBody(source: string, opener: string): string | null {
  const css = stripComments(source)
  const start = css.indexOf(opener)
  if (start === -1) return null

  const open = css.indexOf('{', start + opener.length)
  if (open === -1) return null

  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Custom-property declarations at the top level of a block body. Nested blocks
 * are skipped by depth rather than by luck: a token declared inside a media
 * query or a `&:hover` is conditional, and a law that read it as unconditional
 * would be asserting something false.
 */
export function declarationsOf(body: string): Declarations {
  const found = new Map<string, string>()
  let depth = 0
  let cursor = 0

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char === '{') {
      depth += 1
      cursor = i + 1
      continue
    }
    if (char === '}') {
      depth -= 1
      cursor = i + 1
      continue
    }
    if (char !== ';' && i !== body.length - 1) continue

    const statement = body.slice(cursor, char === ';' ? i : body.length)
    cursor = i + 1
    if (depth !== 0) continue

    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(stripComments(statement))
    if (match) found.set(match[1] as string, (match[2] as string).trim())
  }

  return found
}

/** Every custom property `theme.css` defines anywhere, in any block. */
export function definedTokens(css: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    names.add(match[1] as string)
  }
  return names
}

/**
 * Every custom property a source text *reaches for* — the other half of the
 * referenced-but-undefined law. Deliberately not restricted to CSS files:
 * `var(--duration-flare)` appears in `.tsx` style props too, and a dangling
 * reference there is the same silent fallback.
 */
export function referencedTokens(text: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of stripComments(text).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    names.add(match[1] as string)
  }
  return names
}

/**
 * Follow a token to the literal it finally names.
 *
 * The role tokens are `var()` onto the ice ramp on purpose — "dark is the
 * source of truth and the roles derive from it" is a claim about indirection,
 * so the law has to be able to walk it rather than being handed the answer.
 * Returns `null` for a name that is undefined or that never reaches a literal;
 * a cycle terminates instead of hanging, because a law that hangs is a law
 * nobody runs.
 */
export function resolve(name: string, tokens: Declarations): string | null {
  const seen = new Set<string>()
  let current: string | undefined = tokens.get(name)
  let guard: string | null = name

  while (current !== undefined) {
    if (seen.has(guard as string)) return null
    seen.add(guard as string)

    const reference = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[\s\S]*)?\)$/i.exec(current.trim())
    if (!reference) return current.trim()

    guard = reference[1] as string
    current = tokens.get(guard)
  }
  return null
}

/**
 * The themes `theme.css` declares, each with its tokens fully populated.
 *
 * Discovered rather than listed, which is the whole reason the contrast law is
 * "already shaped for light" while only dark exists. `:root` is dark — the
 * source of truth, unqualified, the theme you get with no attribute set — and
 * every `[data-theme='…']` block is a theme layered over it. When #551 adds
 * that block, this returns two themes and every per-theme law doubles with no
 * edit to the law.
 *
 * `@theme` is folded into the base because Tailwind emits its custom properties
 * to `:root`: a role that resolves onto `--color-ice-1000` has to find it.
 */
export function themesOf(source: string): readonly Theme[] {
  const css = stripComments(source)
  const base = new Map<string, string>()
  for (const opener of ['@theme', ':root']) {
    const body = blockBody(css, opener)
    if (body === null) continue
    for (const [name, value] of declarationsOf(body)) base.set(name, value)
  }

  const themes: Theme[] = [{ name: 'dark', tokens: base }]

  for (const match of css.matchAll(/\[data-theme\s*=\s*['"]([a-z-]+)['"]\]/gi)) {
    const name = match[1] as string
    if (themes.some((theme) => theme.name === name)) continue
    const body = blockBody(css, match[0])
    if (body === null) continue
    const tokens = new Map(base)
    for (const [token, value] of declarationsOf(body)) tokens.set(token, value)
    themes.push({ name, tokens })
  }

  return themes
}

/**
 * Comments are stripped before every scan above. A token named only inside a
 * `/* … *\/` block is prose, and prose that counted as a definition would let a
 * dangling reference hide behind the paragraph explaining it — which is close
 * to how the age-pulse seam survived four PRDs.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ')
}
