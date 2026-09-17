#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${RZ_TEAM_DEPLOY_DIR:-$SCRIPT_DIR}"
ENV_FILE="$TARGET_DIR/.env"
# THE ONE TEMP PATH, AND THE ONLY OTHER FILE THIS SCRIPT EVER WRITES SECRETS TO.
# Declared here, at column 0 and once, because both writers below go through it
# AND because `init.test.ts`'s ignore law reads this assignment and the
# `ENV_FILE=` line above -- anchored, `^tmp_file="$ENV_FILE...` -- to derive what
# .gitignore and .dockerignore must cover. Indenting it into a branch or a
# function does not fail that law, it throws.
tmp_file="$ENV_FILE.tmp.$$"

USAGE="usage: ./init.sh [--rotate-ingest-key]

  (no arguments)        FIRST BOOT. Generates every secret and writes .env.
                        Refuses if .env already exists.
  --rotate-ingest-key   ROTATION. Replaces the ingest key in an .env that
                        already exists, rewriting that ONE line and nothing
                        else. Refuses if .env does not exist."

rotate="no"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate-ingest-key)
      rotate="yes"
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "$USAGE" >&2
      exit 1
      ;;
  esac
  shift
done

# The "rzk_" prefix is not decoration: packages/server/src/shipper/key.ts
# REFUSES any value without it, so a bare hex string is a key no shipper in this
# tree can be configured with (review of #454). Minted here so the value the
# runbook tells the operator to save is the value `rhizomorph connect team`
# accepts. `shipper/key-mint-law.test.ts` holds the two sides together, and it
# reads this assignment anchored at column 0 from another package entirely --
# reformatting it throws there exactly as changing its value does.
#
# Minted BEFORE either path branches, because both mint. A run that then refuses
# -- an .env that already exists, a rotation with nothing to rotate -- throws the
# value away unprinted and unwritten, which costs one `openssl rand` and keeps
# the one assignment both laws read in one place.
ingest_key="rzk_$(openssl rand -hex 32)"
# STORED ONLY AS SHA-256 (prd-51 ruling 8). The plaintext above exists for the
# length of this script and reaches exactly one place: `announce_ingest_key`
# below. What goes into .env, and from there into the app's environment and the
# ingest_keys table, is the digest -- so a stolen .env, a leaked image layer or
# a `docker inspect` yields nothing that can ship a batch.
#
# `printf '%s'`, never `echo`: echo appends a newline, the digest would then be
# of a different string than packages/team/src/keys/hash.ts computes, and the
# deployment's own key would be refused as unknown with nothing saying why.
# packages/team/deploy/init.test.ts runs this script and asserts the two agree.
ingest_key_sha256="$(printf '%s' "$ingest_key" | openssl dgst -sha256 | awk '{ print $NF }')"

# THE ONE PLACE THE PLAINTEXT IS EVER PRINTED, shared by first boot and by
# rotation. One site rather than two is the point: the promise "it will not be
# printed again" is only as good as the number of places that could break it,
# and `init.test.ts` reads this exact line out of real stdout to recover the key
# it then hashes.
announce_ingest_key() {
  echo "ingest key for project $1 (save this now — it will not be printed again): ${ingest_key}"
  echo "only its SHA-256 was stored. There is no way to recover this value from the host — if it is lost, rotate (see docs/team-server-runbook.md)."
}

if [[ "$rotate" == "yes" ]]; then
  # ROTATION REWRITES ONE LINE OF AN EXISTING FILE. IT DOES NOT RECREATE IT.
  #
  # The procedure this replaces was "delete the file, then run first boot", and
  # it took the live deployment down on 2026-09-17 (#591) in two independent
  # ways, both of which are properties of recreating the file rather than of any
  # function in it:
  #
  #   1. It minted a new POSTGRES_PASSWORD. The postgres image applies that
  #      variable ONLY at initdb, so against an existing volume the database
  #      never hears about it -- the app just holds a DSN whose password is
  #      wrong, fails its first query, and never becomes healthy.
  #   2. It wrote the six RZ_TEAM_GITHUB_* values back EMPTY, which is correct
  #      for first boot and destructive here. They are hand-entered, and
  #      RZ_TEAM_GITHUB_CLIENT_SECRET is shown once by GitHub and cannot be
  #      read back -- so rotating an INGEST key destroyed the human sign-in
  #      plane, unrecoverably.
  #
  # So this path knows the name of exactly one variable. Every other byte --
  # comments, ordering, the operator's own additions, and any variable a later
  # PRD adds to this file -- is copied through unread. A rewrite that preserved
  # "the values we know about" would be the second defect again, one release later.
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "nothing to rotate: $ENV_FILE does not exist." >&2
    echo "that is first boot, not a rotation — run ./init.sh with no arguments." >&2
    exit 1
  fi
  if [[ ! -w "$ENV_FILE" ]] || [[ ! -w "$TARGET_DIR" ]]; then
    echo "cannot write to $ENV_FILE" >&2
    exit 1
  fi

  # EXACTLY ONE LINE PER NAME, FOR BOTH NAMES THIS PATH TOUCHES.
  #
  # The reason is the same for the one it REWRITES and the one it READS, and it
  # is compose's, not ours: a .env is LAST-WINS. A duplicate therefore means the
  # value this script acts on is not the value the container gets.
  #
  #   RZ_TEAM_INGEST_KEY_SHA256 twice -- the rewrite lands on the first and the
  #   app boots on the second, so the key just printed is seeded for nothing.
  #   RZ_TEAM_PROJECT twice -- the operator is told the key is scoped to the
  #   first, while the boot scopes it to the second. The doctor catches that
  #   afterwards ("held for project X, not Y"); being caught afterwards is not
  #   the same as not doing it.
  #
  # The second of those shipped in the first cut of this change: the digest was
  # guarded and the project was read with `head -n 1`, which is the guard's own
  # argument applied to one name and not its sibling (verify of #591). Zero lines
  # refuses too -- appending to a file that has neither name is seeding a
  # deployment whose state we have not read.
  for required_name in RZ_TEAM_INGEST_KEY_SHA256 RZ_TEAM_PROJECT; do
    name_lines="$(grep -c "^$required_name=" "$ENV_FILE" || true)"
    if [[ "$name_lines" != "1" ]]; then
      if [[ "$name_lines" == "0" ]]; then
        echo "$ENV_FILE has no $required_name line." >&2
      else
        echo "$ENV_FILE has $name_lines $required_name lines, not 1." >&2
      fi
      echo "rotation will not guess: a compose .env is last-wins, so a duplicate means the value this script acts on is not the one the container gets — fix the file by hand." >&2
      exit 1
    fi
  done

  # The project is read OUT OF THE FILE, not out of the environment: an in-place
  # rotation already knows which deployment it is rotating, so the old
  # procedure's "pass the same RZ_TEAM_PROJECT" hazard -- minting for another
  # project and leaving the original key live -- cannot be reached from here.
  #
  # `head -n 1` is belt and braces, NOT the policy: the loop above is what makes
  # there be exactly one line to take.
  env_project="$(sed -n 's/^RZ_TEAM_PROJECT=//p' "$ENV_FILE" | head -n 1)"
  if [[ -z "$env_project" ]]; then
    echo "$ENV_FILE names no project: RZ_TEAM_PROJECT is empty or absent." >&2
    echo "a key is scoped to one project — set RZ_TEAM_PROJECT in $ENV_FILE, then rotate." >&2
    exit 1
  fi
  # An exported RZ_TEAM_PROJECT that disagrees REFUSES rather than being
  # ignored. Ignoring it would be a knob an operator sets that silently does
  # nothing, which is the shape #584 closed for RZ_TEAM_FOLD_TICK_MS one issue ago.
  if [[ -n "${RZ_TEAM_PROJECT:-}" ]] && [[ "$RZ_TEAM_PROJECT" != "$env_project" ]]; then
    echo "RZ_TEAM_PROJECT=$RZ_TEAM_PROJECT disagrees with $ENV_FILE, which names $env_project." >&2
    echo "rotation is in place: it rotates the key of the project this deployment already serves, and does not re-scope it." >&2
    echo "unset RZ_TEAM_PROJECT to rotate $env_project's key." >&2
    exit 1
  fi

  umask 077
  # `print` emits the record verbatim, so no line is reinterpreted on its way
  # through -- and the replacement arrives via -v as data rather than as part of
  # the program text.
  awk -v replacement="RZ_TEAM_INGEST_KEY_SHA256=${ingest_key_sha256}" '
    /^RZ_TEAM_INGEST_KEY_SHA256=/ { print replacement; next }
    { print }
  ' "$ENV_FILE" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"

  echo "rotated. One line of $ENV_FILE was rewritten: RZ_TEAM_INGEST_KEY_SHA256."
  echo "untouched: POSTGRES_PASSWORD, RZ_TEAM_DATABASE_URL, the six RZ_TEAM_GITHUB_* values, and every other line in the file."
  announce_ingest_key "$env_project"
  echo "now run: docker compose up -d — NOT docker compose restart, which does not re-read .env. That boot seeds the new digest and revokes the old key."
  exit 0
fi

if [[ -f "$ENV_FILE" ]]; then
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  echo "secrets already exist at $ENV_FILE (mode $mode) — not regenerating, ingest key not re-printed."
  echo "to replace the ingest key without disturbing anything else in the file: ./init.sh --rotate-ingest-key"
  exit 0
fi

if [[ ! -d "$TARGET_DIR" ]] || [[ ! -w "$TARGET_DIR" ]]; then
  echo "cannot write to $TARGET_DIR" >&2
  exit 1
fi

postgres_user="rhizomorph"
postgres_db="rhizomorph"
# FIRST BOOT ONLY, and the placement is load-bearing. This line is inside the
# first-boot path and unreachable from the rotation above, because the postgres
# image applies POSTGRES_PASSWORD only at initdb: a fresh value against an
# existing volume is not a credential change, it is a DSN the database will
# refuse (#591). Rotating the DATABASE password is a real thing to want and a
# different procedure -- it needs ALTER USER against the running container --
# and it is not what rotating an ingest key means.
postgres_password="$(openssl rand -hex 32)"
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
# These SURVIVE a rotation: ./init.sh --rotate-ingest-key rewrites the digest
# line and nothing else. The procedure that recreated this file did not, and
# the client secret below is shown once by GitHub and cannot be read back.
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
announce_ingest_key "$project"
