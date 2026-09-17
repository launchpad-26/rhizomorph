# ADR-0059 — the team viewer's write is defended by `SameSite=Lax` and an origin check, not by the local mutation guard

**Status:** accepted (prd-51 wave 12, #560)

## Context and Problem Statement

Minting an ingest key (prd-51 ruling 8) is the team server's **first mutating route reached from a
browser**. Every other write it serves is the ingest route, authenticated by a bearer key from a
shipper rather than by a session, and every browser-reached route before this one was a read.

The local instrument already has an answer to this shape: ADR-0008's mutation guard — loopback
bind, loopback `Host`, `Origin`, `Content-Type`, and a per-process capability token — with
ADR-0012 covering how that token reaches the page. The question is whether the team server adopts
it, and if not, what defends the mint instead.

## Considered Options

1. **Adopt ADR-0008's mutation guard as written**, including the loopback assertions and a
   per-process capability token.
2. **A per-request CSRF token** — minted into the form on `GET`, verified on `POST`.
3. **`SameSite=Lax` on the session cookie, plus a server-side origin check, under the existing
   membership gate.**

## Decision Outcome

**Option 3.**

**Option 1 does not transfer, and would break the deployment.** ADR-0008's threat model is another
*local process on the same machine*, and its defence is binding `127.0.0.1`. The team server binds
`0.0.0.0` behind Caddy on a public name by design (`deploy/compose.yml`, `deploy/Caddyfile`), so a
loopback `Host` assertion refuses every real request. ADR-0012's token is per-process and delivered
to whatever can already `GET /` — it separates "has the page" from "has not". Here that job is
already done, and done strictly better, by the signed session cookie: `HttpOnly`, scoped to one
member, and re-validated against GitHub organisation membership **on every request**.

**Option 2 was rejected because it proves less than what is already required.** A CSRF token
demonstrates the caller loaded the form. The session cookie demonstrates the caller is a named
member of the organisation, checked against GitHub on this request — which is strictly stronger and
already enforced. Adding a second secret that proves a weaker fact is not a second defence; it is
another thing to rotate, leak and get wrong.

What defends the mint, in the order it bites:

1. **`SameSite=Lax` on the session cookie.** A cross-site `POST` — form, `fetch`, image, anything
   — does not carry a Lax cookie, so a forged request arrives with no session and is refused before
   any other check. `SameSite=Lax` is set explicitly rather than relied on as a browser default.
2. **A server-side origin check.** The first defence is a browser policy; this one is the server's.
   When an `Origin` header is present its host must equal the request's own `Host`.
3. **The membership gate**, which a forged request carrying a session would still face.

**An absent `Origin` is allowed**, which is ADR-0008's own recorded choice for the same reason:
browsers always send `Origin` on a `POST`, and a non-browser caller sets any value it likes — so
requiring presence refuses honest CLI callers and stops no attacker.

## Consequences

- **The defence is two browser behaviours and one server check, not a secret.** If a browser ever
  shipped a `SameSite=Lax` regression, layer 2 is what remains, and it is weaker: it refuses a
  cross-origin `POST` that announces itself and permits one that omits `Origin` entirely.
- **It does not defend a non-browser caller that has stolen a session cookie.** Nothing here can —
  that is the cookie's problem, and it is why the cookie is `HttpOnly`, `Secure` and short-lived.
- **This is now the precedent for the next browser-reached write on this server**, and the next one
  should either follow it or supersede this record rather than reason from ADR-0008 again.
- **It was nearly not recorded.** The reasoning above shipped in a docblock with the note that it
  was *"deliberately not an ADR … a five-line predicate under a gate the ruling already fixed"*.
  That is a fair description of the code and the wrong test: `docs/adr/README.md` asks whether a
  rejected alternative can be named, and two can. The size of the diff is not the size of the
  decision.
