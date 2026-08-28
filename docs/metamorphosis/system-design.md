# the metamorphosis — system design

> Direction for the **the metamorphosis** milestone, not law: the door, the split and the
> commons PRDs carry the rulings when they are written, and this document is re-derived
> against the tree whoever writes them finds — the same morphability clause its issues
> carry. Recorded 2026-08-13 from the operator strategy conversation, on the evidence of
> `docs/research/2026-08-13-from-localhost-to-true-software.md` (lands with prd-29,
> PR #432). Hold-the-line disciplines remain in the milestone description; **exposure
> never precedes identity**.

## the two shapes, named — and the one rejected

There are two different products hiding inside "remote rhizomorph", and the design keeps
them separate on purpose:

- **The mesh** (the door — #446): *visiting*. A named guest opens the balcony of one
  machine, read-only, while that machine is on. Each instrument remains the only server
  of its own data. Nothing centralises. This is the cohort/demo rung, and it survives
  into the team era as "quick look at my machine".
- **The observatory** (the split — #447): *team observability*. Collectors on every
  member's machine ship the event log to one server the team runs; the server owns
  storage; any member sees every fleet — live ones bright, sleeping machines' history
  still there. This is the only shape that can answer "what did the team's fleets do
  last week", because with a mesh that fact exists nowhere.

**Rejected by name: true peer-to-peer data sync** (instruments exchanging event logs
directly, no server). The one accountless P2P precedent in the research, Syncthing,
works because *sync* is machine-to-machine symmetric — and even Syncthing kept its
human-facing control surface on localhost + password. Viewing is human-to-machine, and
every studied system that shipped it did so with borrowed identity, not device pairing.
Named here so nobody re-proposes it by accident.

## the mesh, plane by plane (the door)

| plane | direction |
| --- | --- |
| transport | an operator-owned mesh product — Tailscale first (`tailscale serve`: outbound-only, auto-TLS, WireGuard peer-to-peer with relay fallback). We never write networking or crypto. Cloudflare Tunnel + Access is the interchangeable public-hostname flavour for showing someone outside the tailnet. |
| identity | verified, never trusted, never ours: `tailscale whois` on the connecting address (or the Access JWT against JWKS), per hop. No accounts, no passwords, no sessions of our own — the Prometheus lesson made law. |
| authorization | prd-29's identity seam is the substrate. The route-class table gains a viewer/operator axis: loopback = operator (full power, the capability token); verified mesh identity = **named viewer, gated-reads only**. Mutations never answer a viewer; the viewer never sees the capability token — their verified identity *is* their credential. |
| setup | exposure is an explicit operator act that announces itself: `rhizomorph share` prints what it will do, requires confirmation, registers the expected hostname with the (parameterized, never removed) Host check. One-time per person: join the tailnet. |
| visibility | **being watched is never silent** — the chrome shows `SHARED · viewing: <who>` for the whole session. A door-PRD ruling to write. |
| failure | fail closed, loudly: tailscaled down → sharing off and said so; whois error → 403. |

## the observatory (the split)

**Tenancy: the repo is the unit of watching; the team is the unit of membership.**
Organization (team) → project (a watched repo) → machine ingest keys scoped to a
project. Access follows membership, never repo-knowledge — a stranger with the
observatory's URL has nothing.

**Two credential planes that never fuse** (already a #447 constraint):

- **Humans: borrowed identity.** OIDC — GitHub first — with the team boundary being an
  existing org: *sign in with GitHub; must be a member of `github.com/<team>`*. No
  invite lists to run; leaving the org revokes access. This is the VS Code-tunnels
  trick at team scale.
- **Machines: ingest keys.** Minted by a team admin in the viewer, scoped to one
  project, revocable. The collector holds a key and nothing else; clients never touch
  storage directly (MLflow's regret).

**Who hosts: all three must work, by design.** A team member's spare box, the team's
own infra, or — a separate product/business decision, not assumed here — a cloud we
run. The architecture only requires that exactly one observatory exists per team.

**The collector becomes a log-shipper** (the W&B pattern): an append-only local log,
batched sync, a resume marker. Offline-first and crash-safe fall out of the design;
the local balcony keeps working on a train. Redaction (the #292 lineage) runs **at the
collector, before anything leaves the machine**.

## user experience, sketched

- **Team admin, once:** deploy the container anywhere → sign in with GitHub → bind the
  workspace to the org → create a project per repo → copy its ingest key.
- **Each developer, once:** `rhizomorph connect team https://obs.<team>.dev` → browser
  sign-in → pick the project → the collector ships. Nothing else changes; localhost
  still works, offline still works.
- **Daily:** the team view shows every member's fleet on one screen, live and
  historical; drill into any lane's conversation and trace. **Actions stay home** —
  the team view has no mutation surface at all (the commons, #448); lab launches and
  rotations happen only on the machine that owns the work.

## stack

Stay in the family — a promotion of existing organs, not a new codebase:

| plane | choice | why |
| --- | --- | --- |
| server | Node/TypeScript, Fastify — the same server, grown a tenancy layer | the fold, event schemas and route-class law come along free |
| ingest | versioned, authenticated batch endpoint; collector = log-shipper | append-only is already the house shape; resume and offline are structural |
| human auth | OIDC (GitHub first) + org-membership check | borrowed identity, the unanimous case-study lesson |
| machine auth | project-scoped keys minted in the viewer | the universal ingest/viewer split (Langfuse/LangSmith/Phoenix/W&B) |
| storage | SQLite first, behind a storage interface; Postgres the documented growth step; an OLAP event store named-not-built | Phoenix ran production on SQLite-by-default; the interface keeps the door open |
| internal shape | **accept-fast → queue → fold from day one**, even in-process | the one regret both Langfuse and LangSmith rebuilt around |
| deployment | one self-migrating container | identical on a member's box, a VPS, or k8s |

(A Cloudflare-flavoured hosted build — Durable Objects + D1 — is a plausible later
spike for a managed cloud; the primary target is the boring container, because
self-host-anywhere is the requirement.)

## scalability — the four seams, stated as proto-laws

The container is packaging, not topology: what changes at scale is what sits behind the
ingest API, and the evidence is unanimous that survivors start single-container and
split when forced (Langfuse names losing one-container simplicity as v3's *cost*).
"Designed for full scalability" therefore means these four seams from day one — each
cheap now and a rewrite later:

1. **Never fold on the ingest hot path** — accept-fast, queue, fold async, even when
   the queue is an in-process array.
2. **Storage behind an interface** — no SQL in route handlers; SQLite → Postgres →
   OLAP is a re-deployment, not a rewrite.
3. **Server owns storage** — clients hold an ingest token and nothing else, ever.
4. **The ingest protocol is versioned** — it must survive the storage topology
   changing underneath it (Langfuse's API outlived their entire v1→v3 rebuild).

Rungs: (1) 2–20 people — one container, SQLite, in-process queue, a $5 VPS.
(2) 20–100 — same image, Postgres + Redis attached. (3) real scale — web/worker
split, OLAP event store, blob store. The collector and the protocol never change.

## Docker and Electron are orthogonal — the stage map

- **Electron = stage 1, for the operator.** Packages the *local* instrument as real
  software (tray, installer, auto-update; the Node runtime rides in-process). It does
  nothing for networking — but the desktop shell is the natural home for the `share`
  toggle.
- **Docker = stage 3, for the server.** The observatory's one self-migrating container.
- **Never containerize the watcher.** The local instrument observes the machine —
  `~/.claude/projects`, the repo, worktrees, tmux, the git binary. A container wall
  between the watcher and what it watches is bind-mount sprawl for negative value. The
  Docker-wrapped neighbours (Langfuse, MLflow) are *services you send data to*;
  rhizomorph-local is an *observer of your filesystem*. Different species.

## product rulings this design owes (owners named, not decided here)

- **The veil** — what leaves a machine is ruled, not assumed: metrics and events by
  default; transcript text per-project opt-in, redacted at the collector. The single
  biggest trust change in the metamorphosis. (Its own milestone issue; ruled in the
  split's PRD.)
- **Being watched is never silent** — the shared-state chrome. (Door PRD.)
- **Hosting posture** — self-host-anywhere is the requirement; a managed cloud is a
  separate product decision priced on its own. (Split PRD names it; leads decide.)
- **Actions stay home** — already #448's outcome; the observatory's viewer having no
  mutation surface is its concrete form.
