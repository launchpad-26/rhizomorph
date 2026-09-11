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
ingest_key="$(openssl rand -hex 32)"
database_url="postgres://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}"

tmp_file="$ENV_FILE.tmp.$$"
umask 077
cat > "$tmp_file" <<EOF
POSTGRES_USER=${postgres_user}
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=${postgres_db}
RZ_TEAM_DATABASE_URL=${database_url}
RZ_TEAM_INGEST_KEY=${ingest_key}
EOF
chmod 600 "$tmp_file"
mv "$tmp_file" "$ENV_FILE"

echo "first boot. Postgres and app secrets generated and written to $ENV_FILE (mode 600)."
echo "ingest key (save this now — it will not be printed again): ${ingest_key}"
