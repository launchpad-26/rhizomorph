#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${RZ_TEAM_DEPLOY_DIR:-$SCRIPT_DIR}"
ENV_FILE="$TARGET_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  echo "secrets already exist at $ENV_FILE (mode $mode) — not regenerating, ingest key not re-printed."
  exit 0
fi

if [[ ! -d "$TARGET_DIR" ]] || [[ ! -w "$TARGET_DIR" ]]; then
  echo "cannot write to $TARGET_DIR" >&2
  exit 1
fi

postgres_user="rhizomorph"
postgres_db="rhizomorph"
postgres_password="$(openssl rand -hex 32)"
# The "rzk_" prefix is not decoration: packages/server/src/shipper/key.ts
# REFUSES any value without it, so a bare hex string is a key no shipper in this
# tree can be configured with (review of #454). Minted here so the value the
# runbook tells the operator to save is the value `rhizomorph connect team`
# accepts. `shipper/key-mint-law.test.ts` holds the two sides together.
ingest_key="rzk_$(openssl rand -hex 32)"
# STORED ONLY AS SHA-256 (prd-51 ruling 8). The plaintext above exists for the
# length of this script and reaches exactly one place: the line printed at the
# end. What goes into .env, and from there into the app's environment and the
# ingest_keys table, is the digest -- so a stolen .env, a leaked image layer or
# a `docker inspect` yields nothing that can ship a batch.
#
# `printf '%s'`, never `echo`: echo appends a newline, the digest would then be
# of a different string than packages/team/src/keys/hash.ts computes, and the
# deployment's own key would be refused as unknown with nothing saying why.
# packages/team/deploy/init.test.ts runs this script and asserts the two agree.
ingest_key_sha256="$(printf '%s' "$ingest_key" | openssl dgst -sha256 | awk '{ print $NF }')"
# The one project this key may ship for (ruling 8: "scoped to one project").
project="${RZ_TEAM_PROJECT:-default}"
# The fold tick's built-in default, written into .env so the knob an operator
# turns is a line that is already there rather than one they have to know about.
# This is DEFAULT_FOLD_TICK_MS in packages/team/deploy/report.ts, which is what
# the server falls back to when the variable is absent; packages/team/deploy/
# init.test.ts asserts the two are the same number against a real run of this
# script, so the .env this writes cannot start lying about the default.
fold_tick_ms="5000"
database_url="postgres://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}"

tmp_file="$ENV_FILE.tmp.$$"
umask 077
cat > "$tmp_file" <<EOF
POSTGRES_USER=${postgres_user}
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=${postgres_db}
RZ_TEAM_DATABASE_URL=${database_url}
RZ_TEAM_PROJECT=${project}
RZ_TEAM_INGEST_KEY_SHA256=${ingest_key_sha256}

# The fold's safety tick, in MILLISECONDS. Change it here, then run:
# docker compose up -d  (NOT restart -- a restart does not re-read this file).
# 0 disables the periodic tick: the fold then runs only when a batch is
# accepted and at boot. That is a supported setting, not a fault.
# A value that is NOT A NUMBER also reads as 0 -- RZ_TEAM_FOLD_TICK_MS=5s
# DISABLES the tick, it does not set five seconds. Whole milliseconds only.
RZ_TEAM_FOLD_TICK_MS=${fold_tick_ms}

# --- THE GITHUB APP (the human sign-in plane) ------------------------------
# Empty on purpose. These come from GitHub and this script neither prompts for
# them nor generates them. Fill them in, then run: docker compose up -d
# (NOT restart -- a restart does not re-read this file). The full recipe,
# including how to register the App, is in docs/team-server-runbook.md under
# "Signing in with GitHub". While they are empty, sign-in answers 503 and says
# which ones are missing; that is a valid deployment, not a fault.
#
# The organisation login -- github.com/<this>
RZ_TEAM_GITHUB_ORG=
# App settings -> About -> App ID
RZ_TEAM_GITHUB_APP_ID=
# Org -> Settings -> GitHub Apps -> Configure: the last segment of that URL
RZ_TEAM_GITHUB_INSTALLATION_ID=
# App settings -> Client ID
RZ_TEAM_GITHUB_CLIENT_ID=
# App settings -> Generate a new client secret. Shown once
RZ_TEAM_GITHUB_CLIENT_SECRET=
# HOST path of the .pem from App settings -> Private keys. Compose mounts it
# read-only at /run/secrets/github-app-private-key.pem. Keep it OUTSIDE this
# repository: only .env and .env.tmp.* are ignored here, so a key left in this
# directory is copied into an image layer by the Dockerfile.
RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH=
# Non-docker hosts only: the PEM inline. Left commented because a compose .env
# CANNOT carry a multi-line value -- it truncates at the first newline. Use
# RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH above for this deployment.
#RZ_TEAM_GITHUB_APP_PRIVATE_KEY=
EOF
chmod 600 "$tmp_file"
mv "$tmp_file" "$ENV_FILE"

echo "first boot. Postgres and app secrets generated and written to $ENV_FILE (mode 600)."
echo "ingest key for project ${project} (save this now — it will not be printed again): ${ingest_key}"
echo "only its SHA-256 was stored. There is no way to recover this value from the host — if it is lost, rotate (see docs/team-server-runbook.md)."
