# 0027 · The served page declares its own security policy

Date: 2026-08-21 · Status: accepted · Context: the professionalisation loop
(loop 18; the loop-0 finding)

## Context

The SPA was served with no Content-Security-Policy at all. Electron printed
its insecure-CSP warning on every boot of the shell — the first thing loop 0
saw in the console, before any surface was even inspected — and while the
warning names Electron, the fact is the server's: `registerStaticRoute`
streamed HTML with no policy, so the page ran with everything the platform
allows (eval included) on the say-so of nobody.

The app's own architecture already keeps the commitments a strict policy
would demand: the bundle is external module scripts (no inline script in the
built page), the one stream is same-origin SSE, styles are one external sheet
plus inline `style=` attributes, and nothing — script, font, image, frame —
arrives from another origin. A policy that merely *states* what the app
already does costs nothing and turns "we don't load from CDNs" from a habit
into a contract the browser enforces.

## Decision

`static.ts` exports `CONTENT_SECURITY_POLICY` and stamps it as a header on
every HTML response — the SPA fallback included, which is how every
client-side route arrives — and on the missing-build placeholder page.
Assets additionally carry `X-Content-Type-Options: nosniff`.

The policy: `default-src 'self'`; scripts self-only (no eval — nothing in
the dependency tree needs it, verified against the built bundle); styles
self plus `'unsafe-inline'` (the 26 inline `style=` attributes are computed
values on canvas-adjacent chrome, and CSS `style-src-attr` granularity is
not worth a hash pipeline for a loopback app); images and fonts self plus
`data:` (the build inlines sub-4KB assets as data URIs — one small woff2
face arrives that way, found by the policy itself blocking it on the first
live run); `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'`.

Dev-served Vite (which needs eval and inline for HMR) never passes through
this route, so tooling is untouched.

## Consequences

- The Electron warning is gone — measured zero on a live boot, with the page
  rendering and the scene drawing (`Downloads/loops/18-csp-live.png`).
- A future dependency that reaches for eval, or a surface that loads
  anything cross-origin, now fails loudly in every browser rather than
  quietly widening the page's reach. Loosening the policy is a one-line,
  reviewed change to a named constant with laws
  (`static-csp.test.ts`: every HTML route carries it; assets are nosniff;
  the policy never contains `unsafe-eval` or an absolute origin).
- The capability token's in-band `<meta>` delivery (ADR-0012) is unaffected:
  a meta tag is content, not a fetch.
