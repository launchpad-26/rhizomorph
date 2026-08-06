# Sol xhigh review — 2026-08-06

Four independent `gpt-5.6-sol` agents reviewed `1bed433` at `xhigh` reasoning effort.
Each agent inspected the repository directly and returned its report without seeing the
other agents' conclusions.

| Agent remit | Report | Headline |
|---|---|---|
| Product, docs, and vision | [product-docs-vision.md](./product-docs-vision.md) | A distinctive attention radar whose product and documentation have not caught up with its expansion into a privileged laboratory |
| Security and architecture | [security-architecture.md](./security-architecture.md) | Critical boundary failures: exposed reads, unauthorised control routes, and command-injection paths inside one loopback process |
| Implementation and code quality | [implementation-code-quality.md](./implementation-code-quality.md) | Excellent test discipline and typed foundations, undermined by cross-layer correctness gaps, unbounded work, and fragile runtime integration |
| Testing strategy, coverage, and quality | [testing-strategy-coverage-quality.md](./testing-strategy-coverage-quality.md) | Deep semantic tests and strong fixtures, but no measured coverage or real-browser system confidence |

## Verification record

The primary agent independently checked the highest-impact claims and ran the project
quality gates:

- `npm run lint` passed across 547 files.
- `npm run typecheck` passed in all three workspaces.
- `npm test` completed with **3,411 passed and 1 failed** out of 3,412 tests.
- The one failing assertion is
  `packages/server/src/lab/namespace-law.test.ts:654-657`. Its evidence shows the
  worktrees correctly under the lab root, but compares raw `/var/folders/...` with
  Git's canonical `/private/var/folders/...` spelling. The subsequent containment
  assertion passed; this is a test bug, not evidence of a production escape.
- `requireCapabilityToken` is applied to `/api/label`, but not `/api/rotate` or
  `/api/lab/launch`.
- The production web label request has no mechanism to send the capability token.
- The mutation guard deliberately exempts GET and has a test accepting an
  attacker-controlled Host and Origin on a GET.
- The lab launch path accepts an arbitrary `model` string and interpolates it into
  `bash scripts/lane-agent.sh ${model}` for Workmux's shell-shaped agent command.
- Startup, polling, OTEL, checkpoint, and fork paths create independent event-ID
  factories even though IDs are documented as session-unique.

## Convergent conclusion

All four agents identified the laboratory boundary as the project's most urgent
problem, from different directions:

- The product review found that the public trust story still says the laboratory is
  CLI-only while the shipped dashboard can launch experiments.
- The security review found unauthorised high-impact mutations and a command-injection
  route through that browser-accessible launch surface.
- The implementation review found the HTTP layer calling back into the CLI, replacing
  global stderr, parsing prose, and writing through recorders the live server does not
  own.
- The testing review found that isolated server and browser tests let the broken
  authentication contract and missing route-wide authorisation policy remain green.

This is one architectural issue: observation, ingestion, recording control, replay,
and privileged execution currently share a process and route table even though they
have very different authority.

## Recommended order of work

1. Disable or strongly gate browser Lab launch until authentication and model-command
   injection are fixed.
2. Validate Host on every route and authenticate sensitive reads, SSE, ingestion, and
   control with separately scoped credentials.
3. Remove `eval` from `rhizomorph env` consumption or implement complete target-shell
   quoting and strict identifier grammars.
4. Give each session one durable event-ID allocator and add whole-log uniqueness plus
   reconnect tests.
5. Define runtime modes structurally: live observation, ingestion, privileged control,
   and replay should register different capabilities and routes.
6. Replace HTTP-to-CLI re-entry with a typed Lab service owned by the live server.
7. Make persistence precede publication; add atomic owner-aware session leases,
   subprocess deadlines, and bounded SSE/memory queues.
8. Rewrite the current trust, security, product, compatibility, and Lab documentation
   before wider distribution.
9. Add measured coverage, a real-browser SSE-to-UI smoke, and a route-wide security
   contract test.
10. Preserve the product wedge: a local attention radar and flight recorder. Keep the
   laboratory visibly secondary until its boundary and workflow are mature.

These reports are review artefacts only. The Sol agents made no product-code changes.
