# From localhost to true software — a research spike for the staged ship

**Status:** research note, 2026-08-13 — run at the operator's direction ("plan the ship from
localhost to TRUE software") as three parallel case-study clusters: the hosted-LLM-observability
neighbors (Langfuse, LangSmith, W&B, Arize Phoenix, MLflow), the desktop-shell school (Docker
Desktop, Ollama, JupyterLab Desktop, LM Studio + packaging tech), and the remote-identity school
(VS Code tunnels, JupyterHub, Prometheus/Grafana, Cloudflare Access, Tailscale, Syncthing). Claims
carry the source grade assigned at read time: **[V]** verified against official docs/repos,
**[R]** reported (blog/talk/press), **[I]** inferred. This note lives here because prd-34 (stage 1,
the doorstep — `docs/prds/prd-34-the-doorstep.md`) and parked prd-38 (the borrowed credential) cite
it; stages 2–4 were parked, at the time of writing, under "the metamorphosis" milestone, and stage 1
is no longer a candidate — it was ruled as prd-34.

## The finding that reframes the question

"Localhost is unprofessional" is two separable complaints, and the industry solved
them **independently**:

1. **Delivery form** (terminal + npm + `127.0.0.1` tab ≠ software). Solved by the
   desktop-shell pattern with zero change to network posture: signed installer,
   background daemon decoupled from any window, tray icon, auto-update, first-run
   wizard. Docker Desktop, Ollama, JupyterLab Desktop and LM Studio all did exactly
   this and stayed localhost-cored [V]. Nobody fixed the "ugly URL" with a prettier
   URL — they hid it inside an app window or behind a tray icon [V].
2. **Network reach** (one machine, one viewer). Solved by borrowed identity over
   outbound tunnels or identity-aware proxies first, native multi-user *much* later
   or never [V].

## The Phoenix playbook (nearest genealogy to rhizomorph)

Arize Phoenix is the one neighbor that *started* localhost/notebook-embedded and
staged its way up. Their own retro: **"we built features, then a container, then a
database layer, and then authentication"** [R — arize.com/blog/phoenix-10k], verified
against release tags [V]:

standard-protocol ingest endpoint (OTLP, v3.0) → multi-project → persistence
(SQLite default, v4.0) → hosted offering → auth (v5.0, JWTs + API keys) →
multi-tenant spaces. Each step was driven by users already abusing the previous
stage. Auth remains **off by default** for the local case [V].

## The universal end-shape (all five neighbors converge)

instrumented client/SDK → **authenticated ingest endpoint (machine credential:
project-scoped API key)** → server owns storage → browser viewer with **separate
human session auth** (password/OIDC). Two credential planes, never one [V].
Storage starts as one process + one simple DB (Phoenix SQLite; Langfuse v1
Postgres-only) and splits into control-plane/OLAP/blob/queue only at real scale
[V/R]. W&B's offline story — an **append-only local transaction log** shipped by a
log-shipper, synced later — is the strongest client design in the set [V].

## The four regrets (what not to repeat)

- **No auth / auth-off-by-default on an exposed server.** MLflow: five years of
  no-auth, then CVSS-10 unauthenticated LFI/RCE CVEs across thousands of exposed
  servers [V]; Ollama: no first-party auth + one-env-var bind-all = hundreds of
  thousands of leaking instances [R]. Jupyter's 2016 drive-by RCE is why
  token-on-loopback is now table stakes [V].
- **Hand-rolling auth late.** Prometheus's own basic-auth shipped "experimental"
  and caught a cache-poisoning CVE [V/R]. Winners borrowed identity: GitHub/MS
  accounts (VS Code tunnels), tailnet identity (Tailscale Serve), Access policies
  (Cloudflare) [V].
- **Synchronous ingest on the hot path.** Langfuse hit 50s responses; LangSmith hit
  Postgres lock contention; both rebuilt as accept-fast → queue → async fold [R].
- **Clients touching storage directly** (MLflow direct-to-S3 artifacts meant every
  client held cloud creds) [V].

## How the RCE-shaped mutation surface ships remotely (three schools)

- **VS Code tunnels**: don't gate operations, gate *who connects* — outbound-only
  tunnel, private by default, connecting identity must equal owner identity, E2E
  encryption inside the tunnel; scoped, expiring widening (org / 24h capability
  tokens) [V]. Remote terminal is fine because remote user ≡ operator.
- **JupyterHub**: every user has RCE by design; containment is per-user OS/container
  isolation + subdomain isolation — a whole architecture, not an auth feature [V].
- **Prometheus**: dangerous endpoints are off-by-default flags regardless of network
  posture [V]. (rhizomorph's lab-launch = its `--web.enable-admin-api`.)

## Packaging verdict (for a Node server + React SPA that must spawn processes)

**Electron + electron-builder/updater.** Electron ships the Node runtime in-process,
so the existing Fastify server and SPA run unmodified; JupyterLab Desktop is the
literal blueprint (shell spawns server, embedded window at `127.0.0.1:port/?token=…`)
[V]. Tauri v2 is smaller but requires compiling the server into a per-target sidecar
(official guide still uses deprecated `pkg`) and has weaker Linux tray support [V].
Real signing costs: Azure Trusted Signing ~$120/yr (Windows; EV no longer buys
SmartScreen bypass since 2024) + Apple Developer $99/yr (mandatory for macOS
auto-update) [R/V]. Choice is reversible — both shells share the same architecture.

## The ship, staged for rhizomorph

rhizomorph is unusually pre-adapted: it already has an OTLP ingest endpoint, an
append-only event log, a fold, a separable SPA viewer, Host/Origin validation and a
capability token on mutating routes (prd-23 / ADR-0008/0012/0014). The end-state is
a **promotion of existing organs, not a rewrite** [I].

- **Stage 0 — loopback parity (issues, not a PRD):** extend token protection to
  read routes (Jupyter parity; transcripts are sensitive), keeping the browser
  handshake in-band. Rhizomorph is already ahead of where MLflow/Phoenix were at
  the same age; this closes the last gap.
- **Stage 1 — the app (professionalism PRD):** Electron shell, tray, signed
  installers, auto-update, first-run wizard (folds into the prd-20 concierge and
  "doorstep" onboarding thread). Zero constitutional change. This alone converts
  "dev server" into "software."
- **Stage 2 — the door (remote-viewing PRD + ADR):** one auth middleware honoring
  (a) loopback = operator, (b) verified forwarded identity (Tailscale `whois` /
  Cloudflare Access JWT via JWKS) = named viewer; route classes grow a
  viewer/operator axis — reads for viewers, **mutations for the owner identity
  only** (VS Code model), lab-launch stays effectively machine-local. Host/Origin
  checks parameterized for the tunnel hostname. No hand-rolled accounts, ever.
- **Stage 3 — the split (multiplayer foundation PRD):** collector promoted to a
  log-shipper (W&B pattern: local append-only log + sync), authenticated ingest
  with project-scoped machine keys minted in the viewer, SQLite-first shared
  server (Phoenix pattern), one self-migrating container for self-host (W&B
  pattern). Human sessions via borrowed OIDC. Assume accept-fast → queue → fold.
- **Stage 4 — multi-user proper:** RBAC on mutations, audit trail; per-user
  isolation only if remote mutation is ever truly needed (JupyterHub's lesson
  says: probably never — keep actions machine-local, share observation).

Licensing note for later: Phoenix's model (ELv2, zero feature gates, monetize
elsewhere) is the closest analog if this ever leaves the cohort [V].

## Sources

Primary references are inline in the three cluster reports (this note's parents),
retained in the session transcript of 2026-08-13; key anchors: langfuse.com/self-hosting,
langfuse v3 infra blog, docs.langchain.com/langsmith/self-hosted, wandb server repo +
"Distributing Our Self-Hosted Software", arize.com/blog/phoenix-10k + Phoenix release
tags v3/v4/v5, mlflow 2.5.0 release + GHSA-xg73-94fp-g449, code.visualstudio.com/docs/remote/tunnels,
learn.microsoft.com dev-tunnels security, jupyterhub technical-overview + websecurity,
prometheus security model + https config, developers.cloudflare.com Access JWT validation,
tailscale.com/kb/1312/serve, docs.syncthing.net device-ids + guilisten,
jupyter/notebook#1830/#1831, docs.docker.com extensions architecture,
docs.ollama.com/faq, lmstudio.ai serve-on-network, v2.tauri.app sidecar/updater,
electron.build auto-update, nodejs.org single-executable-applications.
