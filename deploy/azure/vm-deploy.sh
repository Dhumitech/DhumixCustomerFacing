#!/bin/sh
# Runs on the VM. Fixes Linux permissions on the private bundle (Windows cannot
# set them), points compose at the Linux bundle path, then builds and starts the
# existing deploy/demo stack. Never runs migrations, `down -v` or host workers.
set -eu
BUNDLE_NAME="$1"
APP=/opt/dhumi
BUNDLE="$APP/private/$BUNDLE_NAME"
[ -f "$BUNDLE/prepared.json" ] || { echo "Missing prepared bundle $BUNDLE"; exit 1; }

chmod 700 "$APP/private" "$BUNDLE"
find "$BUNDLE" -maxdepth 1 -type f -exec chmod 600 {} +
# Read by non-root containers through bind mounts: app (uid 1000), postgres (uid 999).
chmod 444 "$BUNDLE/api.private.json" "$BUNDLE/outbox.private.json" "$BUNDLE/jobs.private.json" \
  "$BUNDLE/results.private.json" "$BUNDLE/postgres-password.private.txt" "$BUNDLE/mssql-password.private.txt"
find "$BUNDLE/restore" -type d -exec chmod 755 {} +
find "$BUNDLE/restore" -type f -exec chmod 444 {} +

ENV_FILE="$BUNDLE/compose.private.env"
chmod 600 "$ENV_FILE"
sed -i "s|^DHUMI_PRIVATE_DIR=.*|DHUMI_PRIVATE_DIR='$BUNDLE'|" "$ENV_FILE"

cd "$APP/src"
docker compose --env-file "$ENV_FILE" -f deploy/demo/compose.yml build api frontend
docker compose --env-file "$ENV_FILE" -f deploy/demo/compose.yml up -d --no-build
docker compose --env-file "$ENV_FILE" -f deploy/demo/compose.yml ps
